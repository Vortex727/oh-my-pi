/**
 * Saved setups: named, reusable settings overlays stored as
 * `<agentDir>/setups/<name>.yml`. A setup file is a native `config.yml`-style
 * document plus reserved `$setup` metadata. Loading is tolerant: settings this
 * version of omp cannot own are skipped with a warning instead of rejecting the
 * whole file, so setups survive setting renames and removals across upgrades.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDir, isEexist, isEnoent, logger, stringifyYamlConfig } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { RawSettings, Settings } from "../config/settings";
import { getUi, isCredential, isMachineLocal, SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import { replaceFileAtomically } from "../utils/atomic-file";
import {
	type ModelRoleAssignments,
	PROFILE_EMOJIS,
	PROFILE_SETTINGS_GROUPS,
	type ProfileDraft,
	type ProfileEmoji,
	type ProfileSettingsGroup,
	type SetupMetadata,
} from "./types";

const SETUPS_DIRNAME = "setups";
const SETUP_EXTENSION = ".yml";
const SETUP_METADATA_KEY = "$setup";
const SETUP_FORMAT_VERSION = 1;
const MAX_SETUP_BYTES = 1024 * 1024;
const MAX_SETUP_NAME_LENGTH = 64;
const WINDOWS_INVALID_FILENAME_RE = /[\p{Cc}\p{Cf}<>:"/\\|?*]/u;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PROFILE_EMOJI_SET = new Set<string>(PROFILE_EMOJIS.map(option => option.emoji));
const GROUP_ORDER = new Map<string, number>(PROFILE_SETTINGS_GROUPS.map((group, index) => [group.id, index]));
/** Structured settings a setup may own; every other setup setting is a boolean, number, or enum. */
const STRUCTURED_SETUP_PATHS: Partial<Record<SettingPath, true>> = {
	"task.disabledAgents": true,
	"task.agentModelOverrides": true,
	"retry.fallbackChains": true,
};

export type SetupErrorKind = "invalid-name" | "not-found" | "exists" | "invalid" | "too-large" | "unsupported-version";

export class SetupError extends Error {
	constructor(
		readonly kind: SetupErrorKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SetupError";
	}
}

export interface SavedSetupDescriptor {
	name: string;
	updatedAt: number;
	metadata?: SetupMetadata;
	/** Why the setup cannot be loaded; listed anyway so the user can see and delete it. */
	error?: string;
}

export interface LoadedSetup extends ProfileDraft {
	name: string;
	path: string;
	/** Entries skipped while loading, each naming the setting and why. */
	warnings: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Validate a user-facing setup name; the result is also the file basename. */
export function normalizeSetupName(name: string): string {
	const normalized = name.trim();
	if (
		!normalized ||
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		[...normalized].length > MAX_SETUP_NAME_LENGTH ||
		WINDOWS_INVALID_FILENAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized) ||
		PROTOTYPE_KEYS.has(normalized)
	) {
		throw new SetupError("invalid-name", `"${name}" is not a valid profile name`);
	}
	return normalized;
}

function setupsDirectory(agentDir: string): string {
	return path.join(agentDir, SETUPS_DIRNAME);
}

function setupFilePath(name: string, agentDir: string): string {
	return path.join(setupsDirectory(agentDir), `${name}${SETUP_EXTENSION}`);
}

// ─── Setting ownership ───────────────────────────────────────────────────────

function settingGroup(settingPath: SettingPath): ProfileSettingsGroup | undefined {
	if (settingPath === "task.disabledAgents" || settingPath === "task.agentModelOverrides") return "tasks";
	const tab = getUi(settingPath)?.tab;
	return tab !== undefined && GROUP_ORDER.has(tab) ? (tab as ProfileSettingsGroup) : undefined;
}

/** Whether a setup may own `settingPath`: grouped, not credential or machine-local, and a supported value type. */
function isSetupSettingPath(settingPath: SettingPath): boolean {
	if (settingGroup(settingPath) === undefined || isCredential(settingPath) || isMachineLocal(settingPath))
		return false;
	const { type } = SETTINGS_SCHEMA[settingPath];
	return (
		type === "boolean" || type === "number" || type === "enum" || Object.hasOwn(STRUCTURED_SETUP_PATHS, settingPath)
	);
}

const SETUP_SETTING_PATHS = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(isSetupSettingPath);
const SETUP_SETTING_PATH_SET = new Set<string>(SETUP_SETTING_PATHS);
/** Every proper prefix of a setup setting path, e.g. `task` for `task.disabledAgents`. */
const SETUP_BRANCHES = new Set<string>(
	SETUP_SETTING_PATHS.flatMap(settingPath => {
		const segments = settingPath.split(".");
		return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("."));
	}),
);

/** Settings a setup includes when `group` is enabled. */
export function getSetupGroupPaths(group: ProfileSettingsGroup): SettingPath[] {
	return SETUP_SETTING_PATHS.filter(settingPath => settingGroup(settingPath) === group);
}

function sortGroups(groups: Iterable<ProfileSettingsGroup>): ProfileSettingsGroup[] {
	return [...new Set(groups)].sort((left, right) => (GROUP_ORDER.get(left) ?? 0) - (GROUP_ORDER.get(right) ?? 0));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** The value a setup may store for `settingPath`, or `undefined` when this omp version would reject it. */
function validSettingValue(settingPath: SettingPath, value: unknown): unknown {
	const definition = SETTINGS_SCHEMA[settingPath];
	switch (settingPath) {
		case "task.disabledAgents":
			return isStringArray(value) ? [...value] : undefined;
		case "task.agentModelOverrides": {
			if (!isPlainRecord(value)) return undefined;
			const overrides: Record<string, string | string[] | null> = {};
			for (const [agent, selector] of Object.entries(value)) {
				if (PROTOTYPE_KEYS.has(agent)) return undefined;
				if (selector === null || typeof selector === "string") overrides[agent] = selector;
				else if (isStringArray(selector)) overrides[agent] = [...selector];
				else return undefined;
			}
			return overrides;
		}
		case "retry.fallbackChains": {
			if (!isPlainRecord(value)) return undefined;
			const chains: Record<string, string[]> = {};
			for (const [role, chain] of Object.entries(value)) {
				if (PROTOTYPE_KEYS.has(role) || !isStringArray(chain)) return undefined;
				chains[role] = [...chain];
			}
			return chains;
		}
	}
	if (definition.type === "boolean") return typeof value === "boolean" ? value : undefined;
	if (definition.type === "number") return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	if (definition.type === "enum") {
		return typeof value === "string" && (definition.values as readonly string[]).includes(value) ? value : undefined;
	}
	return undefined;
}

// ─── Nested config paths ─────────────────────────────────────────────────────

/** Read a dotted setting path from a nested settings object. */
export function readConfigPath(
	source: Record<string, unknown>,
	settingPath: string,
): { present: boolean; value?: unknown } {
	let current: unknown = source;
	for (const segment of settingPath.split(".")) {
		if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) return { present: false };
		current = current[segment];
	}
	return { present: true, value: current };
}

/** Write a dotted setting path into a nested settings object, creating parent objects. */
export function writeConfigPath(target: RawSettings, settingPath: string, value: unknown): void {
	const segments = settingPath.split(".");
	let current = target;
	for (const segment of segments.slice(0, -1)) {
		const child = current[segment];
		if (isPlainRecord(child)) {
			current = child;
		} else {
			const created: RawSettings = {};
			current[segment] = created;
			current = created;
		}
	}
	current[segments[segments.length - 1]] = value;
}

function deleteConfigPath(target: RawSettings, settingPath: string): void {
	const segments = settingPath.split(".");
	const parents: RawSettings[] = [target];
	for (const segment of segments.slice(0, -1)) {
		const child = parents[parents.length - 1][segment];
		if (!isPlainRecord(child)) return;
		parents.push(child);
	}
	delete parents[parents.length - 1][segments[segments.length - 1]];
	// Drop parents the deletion emptied so saved files stay minimal.
	for (let index = parents.length - 1; index > 0; index--) {
		if (Object.keys(parents[index]).length > 0) break;
		delete parents[index - 1][segments[index - 1]];
	}
}

/** Keys present in a setup document that no setup setting path accounts for. */
function collectIgnoredPaths(node: Record<string, unknown>, prefix: string, ignored: string[]): void {
	for (const key of Object.keys(node)) {
		const childPath = prefix ? `${prefix}.${key}` : key;
		if (!prefix && (key === SETUP_METADATA_KEY || key === "modelRoles")) continue;
		if (SETUP_SETTING_PATH_SET.has(childPath)) continue;
		const child = node[key];
		if (isPlainRecord(child) && SETUP_BRANCHES.has(childPath)) collectIgnoredPaths(child, childPath, ignored);
		else ignored.push(childPath);
	}
}

// ─── Parsing and serialization ───────────────────────────────────────────────

function parseMetadata(value: unknown, warnings: string[]): SetupMetadata {
	const metadata: SetupMetadata = { version: SETUP_FORMAT_VERSION, enabledGroups: [] };
	if (value === undefined) return metadata;
	if (!isPlainRecord(value)) {
		warnings.push(`Ignored ${SETUP_METADATA_KEY}: expected a mapping`);
		return metadata;
	}
	if (value.version !== undefined && value.version !== SETUP_FORMAT_VERSION) {
		throw new SetupError(
			"unsupported-version",
			`This profile uses format version ${String(value.version)}; update omp to load it`,
		);
	}
	if (typeof value.emoji === "string" && PROFILE_EMOJI_SET.has(value.emoji)) {
		metadata.emoji = value.emoji as ProfileEmoji;
	} else if (value.emoji !== undefined) {
		warnings.push("Ignored emoji: not one of the available profile emojis");
	}
	if (Array.isArray(value.enabledGroups)) {
		const groups: ProfileSettingsGroup[] = [];
		for (const group of value.enabledGroups) {
			if (typeof group === "string" && GROUP_ORDER.has(group)) groups.push(group as ProfileSettingsGroup);
			else warnings.push(`Ignored settings group ${JSON.stringify(group)}: unknown group`);
		}
		metadata.enabledGroups = sortGroups(groups);
	} else if (value.enabledGroups !== undefined) {
		warnings.push("Ignored enabledGroups: expected a list");
	}
	return metadata;
}

function parseModelRoles(value: unknown, warnings: string[]): ModelRoleAssignments {
	const roles: ModelRoleAssignments = {};
	if (value === undefined) return roles;
	if (!isPlainRecord(value)) {
		warnings.push("Ignored modelRoles: expected a mapping");
		return roles;
	}
	for (const [role, selector] of Object.entries(value)) {
		if (PROTOTYPE_KEYS.has(role)) warnings.push(`Ignored model role "${role}": reserved name`);
		else if (selector === null || typeof selector === "string") roles[role] = selector;
		else warnings.push(`Ignored model role "${role}": expected a model selector or null`);
	}
	return roles;
}

/**
 * Read a setup document. Only a non-mapping document or an unsupported format
 * version is fatal; every other problem skips the affected entry with a warning.
 * Groups owning a kept setting stay enabled even if metadata omitted them, so a
 * setting moved between Settings tabs keeps its saved value.
 */
export function parseSetupDocument(document: unknown): ProfileDraft & { warnings: string[] } {
	if (!isPlainRecord(document)) throw new SetupError("invalid", "A profile must be a YAML mapping");
	const warnings: string[] = [];
	const metadata = parseMetadata(document[SETUP_METADATA_KEY], warnings);
	const config: RawSettings = { modelRoles: parseModelRoles(document.modelRoles, warnings) };
	const groups = new Set(metadata.enabledGroups);
	for (const settingPath of SETUP_SETTING_PATHS) {
		const found = readConfigPath(document, settingPath);
		if (!found.present) continue;
		const value = validSettingValue(settingPath, found.value);
		if (value === undefined) {
			warnings.push(`Ignored ${settingPath}: value is not valid for this version of omp`);
			continue;
		}
		writeConfigPath(config, settingPath, value);
		groups.add(settingGroup(settingPath)!);
	}
	const ignored: string[] = [];
	collectIgnoredPaths(document, "", ignored);
	for (const ignoredPath of ignored) {
		warnings.push(`Ignored ${ignoredPath}: not a setting this version of omp can load from a profile`);
	}
	metadata.enabledGroups = sortGroups(groups);
	return { metadata, config, warnings };
}

/** Serialize a draft as a native settings overlay with `$setup` metadata. */
export function serializeSetup(draft: ProfileDraft): string {
	const metadata: Record<string, unknown> = { version: SETUP_FORMAT_VERSION };
	if (draft.metadata.emoji !== undefined) metadata.emoji = draft.metadata.emoji;
	metadata.enabledGroups = sortGroups(draft.metadata.enabledGroups);
	return stringifyYamlConfig({ [SETUP_METADATA_KEY]: metadata, ...draft.config });
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

/** The draft's model roles; entries that are not a selector or `null` are dropped. */
export function draftModelRoles(draft: ProfileDraft): ModelRoleAssignments {
	const roles: ModelRoleAssignments = {};
	const value = draft.config.modelRoles;
	if (!isPlainRecord(value)) return roles;
	for (const [role, selector] of Object.entries(value)) {
		if (selector === null || typeof selector === "string") roles[role] = selector;
	}
	return roles;
}

/** Flatten a setup's settings into path-keyed overrides for a read-only preview `Settings`. */
export function setupOverrides(draft: ProfileDraft): Partial<Record<SettingPath, unknown>> {
	const overrides: Partial<Record<SettingPath, unknown>> = { modelRoles: draftModelRoles(draft) };
	for (const settingPath of SETUP_SETTING_PATHS) {
		const found = readConfigPath(draft.config, settingPath);
		if (found.present) overrides[settingPath] = found.value;
	}
	return overrides;
}

/**
 * Start a models-only draft from the effective configuration. When the live
 * session's model is supplied, it becomes the saved default together with its
 * configured thinking level (including `auto`).
 */
export function createSetupDraft(
	settings: Settings,
	current?: { provider: string; id: string; thinkingLevel?: ConfiguredThinkingLevel },
): ProfileDraft {
	const modelRoles: ModelRoleAssignments = {};
	for (const [role, selector] of Object.entries(settings.getModelRoles())) {
		if (selector !== undefined) modelRoles[role] = selector;
	}
	if (current) {
		modelRoles.default = formatModelSelectorValue(`${current.provider}/${current.id}`, current.thinkingLevel);
	}
	return { metadata: { version: SETUP_FORMAT_VERSION, enabledGroups: [] }, config: { modelRoles } };
}

/**
 * Include or exclude a settings group. Including captures the settings the
 * user explicitly configured in that group; defaults stay unset so the setup
 * keeps following omp's defaults. Excluding removes every saved group setting.
 */
export function setDraftGroup(
	draft: ProfileDraft,
	group: ProfileSettingsGroup,
	included: boolean,
	settings: Settings,
): ProfileDraft {
	const config = structuredClone(draft.config);
	const groups = new Set(draft.metadata.enabledGroups);
	if (included) {
		for (const settingPath of getSetupGroupPaths(group)) {
			if (readConfigPath(config, settingPath).present || !settings.isConfigured(settingPath)) continue;
			const value = validSettingValue(settingPath, settings.get(settingPath));
			if (value !== undefined) writeConfigPath(config, settingPath, value);
		}
		groups.add(group);
	} else {
		for (const settingPath of getSetupGroupPaths(group)) deleteConfigPath(config, settingPath);
		groups.delete(group);
	}
	return { metadata: { ...draft.metadata, enabledGroups: sortGroups(groups) }, config };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

async function readSetupDocument(filePath: string, name: string): Promise<unknown> {
	const file = Bun.file(filePath);
	let content: string;
	try {
		if (file.size > MAX_SETUP_BYTES) throw new SetupError("too-large", `Profile "${name}" is larger than 1 MiB`);
		content = await file.text();
	} catch (error) {
		if (error instanceof SetupError) throw error;
		if (isEnoent(error)) throw new SetupError("not-found", `Profile "${name}" was not found`, { cause: error });
		throw error;
	}
	try {
		return YAML.parse(content);
	} catch (error) {
		throw new SetupError("invalid", `Profile "${name}" is not valid YAML`, { cause: error });
	}
}

async function readSetupFile(filePath: string, name: string): Promise<ProfileDraft & { warnings: string[] }> {
	return parseSetupDocument(await readSetupDocument(filePath, name));
}

/** Atomically replace `filePath` with `content`. */
async function replaceSetupFile(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await Bun.write(tempPath, content);
	try {
		await replaceFileAtomically(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
}

/** List saved setups by name, including unreadable ones with their error. */
export async function listSavedSetups(agentDir: string = getAgentDir()): Promise<SavedSetupDescriptor[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(setupsDirectory(agentDir));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const descriptors: SavedSetupDescriptor[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(SETUP_EXTENSION)) continue;
		const name = entry.slice(0, -SETUP_EXTENSION.length);
		try {
			if (normalizeSetupName(name) !== name) continue;
		} catch {
			continue;
		}
		const filePath = setupFilePath(name, agentDir);
		let updatedAt: number;
		try {
			const stats = await fs.stat(filePath);
			if (!stats.isFile()) continue;
			updatedAt = stats.mtimeMs;
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		try {
			const { metadata } = await readSetupFile(filePath, name);
			descriptors.push({ name, updatedAt, metadata });
		} catch (error) {
			if (!(error instanceof SetupError)) throw error;
			descriptors.push({ name, updatedAt, error: error.message });
		}
	}
	return descriptors.sort((left, right) => left.name.localeCompare(right.name));
}

/** Load one saved setup; skipped entries are logged and returned as warnings. */
export async function loadSavedSetup(name: string, agentDir: string = getAgentDir()): Promise<LoadedSetup> {
	const normalized = normalizeSetupName(name);
	const filePath = setupFilePath(normalized, agentDir);
	const setup = await readSetupFile(filePath, normalized);
	if (setup.warnings.length > 0) {
		logger.warn("Saved setup loaded with skipped entries", { setup: normalized, warnings: setup.warnings });
	}
	return { ...setup, name: normalized, path: filePath };
}

/** Save a draft. Without `overwrite`, an existing setup of the same name is never replaced. */
export async function saveSetup(
	name: string,
	draft: ProfileDraft,
	options: { agentDir?: string; overwrite?: boolean } = {},
): Promise<SavedSetupDescriptor> {
	const normalized = normalizeSetupName(name);
	const agentDir = options.agentDir ?? getAgentDir();
	const filePath = setupFilePath(normalized, agentDir);
	const content = serializeSetup(draft);
	if (Buffer.byteLength(content) > MAX_SETUP_BYTES) {
		throw new SetupError("too-large", `Profile "${normalized}" is larger than 1 MiB`);
	}
	await fs.mkdir(setupsDirectory(agentDir), { recursive: true });
	if (options.overwrite) {
		await replaceSetupFile(filePath, content);
	} else {
		try {
			await fs.writeFile(filePath, content, { flag: "wx" });
		} catch (error) {
			if (isEexist(error)) {
				throw new SetupError("exists", `A profile named "${normalized}" already exists`, { cause: error });
			}
			throw error;
		}
	}
	return { name: normalized, updatedAt: Date.now(), metadata: draft.metadata };
}

/**
 * Set or clear one saved setup's emoji. Every other entry stays as written,
 * including entries this version of omp skipped on load, so an emoji change
 * never drops settings a newer omp understands.
 */
export async function setSavedSetupEmoji(
	name: string,
	emoji: ProfileEmoji | undefined,
	agentDir: string = getAgentDir(),
): Promise<SavedSetupDescriptor> {
	const normalized = normalizeSetupName(name);
	const filePath = setupFilePath(normalized, agentDir);
	const document = await readSetupDocument(filePath, normalized);
	// Parsing validates the format version before anything is written.
	const { metadata } = parseSetupDocument(document);
	const { [SETUP_METADATA_KEY]: rawMetadata, ...entries } = document as Record<string, unknown>;
	const nextMetadata: Record<string, unknown> = isPlainRecord(rawMetadata)
		? { ...rawMetadata }
		: { version: SETUP_FORMAT_VERSION, enabledGroups: metadata.enabledGroups };
	if (emoji === undefined) delete nextMetadata.emoji;
	else nextMetadata.emoji = emoji;
	const content = stringifyYamlConfig({ [SETUP_METADATA_KEY]: nextMetadata, ...entries });
	if (Buffer.byteLength(content) > MAX_SETUP_BYTES) {
		throw new SetupError("too-large", `Profile "${normalized}" is larger than 1 MiB`);
	}
	await replaceSetupFile(filePath, content);
	return { name: normalized, updatedAt: Date.now(), metadata: { ...metadata, emoji } };
}

/** Rename a saved setup without replacing another one. Case-only renames are allowed. */
export async function renameSavedSetup(
	name: string,
	newName: string,
	agentDir: string = getAgentDir(),
): Promise<string> {
	const from = normalizeSetupName(name);
	const to = normalizeSetupName(newName);
	if (from === to) return to;
	const fromPath = setupFilePath(from, agentDir);
	const toPath = setupFilePath(to, agentDir);
	if (from.toLowerCase() === to.toLowerCase()) {
		// Same file on case-insensitive filesystems: an in-place rename changes only the case.
		await fs.rename(fromPath, toPath);
		return to;
	}
	let content: string;
	try {
		content = await Bun.file(fromPath).text();
	} catch (error) {
		if (isEnoent(error)) throw new SetupError("not-found", `Profile "${from}" was not found`, { cause: error });
		throw error;
	}
	try {
		await fs.writeFile(toPath, content, { flag: "wx" });
	} catch (error) {
		if (isEexist(error)) throw new SetupError("exists", `A profile named "${to}" already exists`, { cause: error });
		throw error;
	}
	await fs.rm(fromPath);
	return to;
}

/** Delete one saved setup file. Live settings and other setups are untouched. */
export async function deleteSavedSetup(name: string, agentDir: string = getAgentDir()): Promise<void> {
	const normalized = normalizeSetupName(name);
	try {
		await fs.rm(setupFilePath(normalized, agentDir));
	} catch (error) {
		if (isEnoent(error)) throw new SetupError("not-found", `Profile "${normalized}" was not found`, { cause: error });
		throw error;
	}
}
