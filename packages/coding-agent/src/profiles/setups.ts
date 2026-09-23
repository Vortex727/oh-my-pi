import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEexist, isEnoent, stringifyYamlConfig } from "@oh-my-pi/pi-utils";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { YAML } from "bun";
import type { RawSettings, Settings } from "../config/settings";
import {
	getUi,
	isCredential,
	migrateLegacyFindEnabled,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "../config/settings-schema";
import { replaceFileAtomically } from "../utils/atomic-file";
import { readBoundedRegularTextFile } from "./bounded-file";
import {
	PROFILE_EMOJIS,
	PROFILE_SETTINGS_GROUPS,
	type ModelRoleAssignments,
	type ProfileDraft,
	type ProfileEmoji,
	type ProfileSettingsGroup,
	type ProfileSnapshot,
	type SetupMetadata,
} from "./types";

export interface SavedSetupDescriptor {
	name: string;
	updatedAt: number;
	metadata?: SetupMetadata;
}

const SETUPS_DIRNAME = "setups";
const SETUP_EXTENSION = ".yml";
const SETUP_METADATA_KEY = "$setup";
const MAX_NATIVE_SETUP_BYTES = 1024 * 1024;
const WINDOWS_INVALID_FILENAME_RE = /[\p{Cc}\p{Cf}<>:"/\\|?*]/u;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;
const PROFILE_EMOJI_LOOKUP: Record<ProfileEmoji, true> = Object.fromEntries(
	PROFILE_EMOJIS.map(option => [option.emoji, true]),
) as Record<ProfileEmoji, true>;
const PROFILE_GROUP_LOOKUP: Record<ProfileSettingsGroup, true> = Object.fromEntries(
	PROFILE_SETTINGS_GROUPS.map(group => [group.id, true]),
) as Record<ProfileSettingsGroup, true>;
const PROFILE_GROUP_ORDER: Record<ProfileSettingsGroup, number> = Object.fromEntries(
	PROFILE_SETTINGS_GROUPS.map((group, index) => [group.id, index]),
) as Record<ProfileSettingsGroup, number>;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_NODES = 10_000;
const MAX_COLLECTION_ENTRIES = 1_000;
const MAX_KEY_LENGTH = 256;
const MAX_STRING_LENGTH = 64 * 1024;

/** Local-only categories are exact path segments, not group-name/prefix guesses. */
const LOCAL_ONLY_PATH_SEGMENTS: Record<string, true> = {
	account: true,
	accounts: true,
	broker: true,
	command: true,
	endpoint: true,
	endpoints: true,
	executable: true,
	path: true,
	paths: true,
	route: true,
	routes: true,
	routing: true,
	url: true,
	urls: true,
};
const LOCAL_ONLY_SETTING_PATHS: Partial<Record<SettingPath, true>> = {
	"codexResets.autoRedeem": true,
	"codexResets.minBlockedMinutes": true,
	"codexResets.keepCredits": true,
	"codexResets.salvageHorizonHours": true,
	"claudeResets.autoRedeem": true,
	"claudeResets.minBlockedMinutes": true,
	"claudeResets.keepCredits": true,
	"claudeResets.salvageHorizonHours": true,
	modelRoleStorage: true,
	"providers.antigravityEndpoint": true,
	"providers.fireworksTier": true,
	"tier.openai": true,
	"tier.anthropic": true,
	"tier.google": true,
	"tier.subagent": true,
	"tier.advisor": true,
};
const SPECIAL_TASK_PATHS: Partial<Record<SettingPath, true>> = {
	"task.disabledAgents": true,
	"task.agentModelOverrides": true,
};
const PORTABLE_STRUCTURED_PATHS: Partial<Record<SettingPath, true>> = {
	"retry.fallbackChains": true,
};

function invalidSetupName(): Error {
	return new Error("Invalid saved setup name");
}

function invalidSetup(): Error {
	return new Error("Saved setup is invalid");
}

export function normalizeSetupName(name: string): string {
	const normalized = name.trim();
	if (
		!normalized ||
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		[...normalized].length > 64 ||
		WINDOWS_INVALID_FILENAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized) ||
		normalized === "__proto__" ||
		normalized === "constructor" ||
		normalized === "prototype"
	) {
		throw invalidSetupName();
	}
	return normalized;
}

function setupPath(name: string, agentDir: string): string {
	return path.resolve(agentDir, SETUPS_DIRNAME, `${normalizeSetupName(name)}${SETUP_EXTENSION}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertSafeKey(key: string): void {
	if (
		key.length === 0 ||
		key.length > MAX_KEY_LENGTH ||
		key === "__proto__" ||
		key === "constructor" ||
		key === "prototype"
	) {
		throw invalidSetup();
	}
}

async function hasSafeSetupDirectory(directory: string): Promise<boolean> {
	try {
		const stats = await fs.lstat(directory);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Saved setup storage is invalid");
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function isSameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function regularSetupStats(filePath: string, name: string): Promise<Stats> {
	if (!(await hasSafeSetupDirectory(path.dirname(filePath)))) {
		throw new Error(`Saved setup "${name}" was not found`);
	}
	try {
		const stats = await fs.lstat(filePath);
		if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Saved setup is not a regular file");
		return stats;
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Saved setup "${name}" was not found`);
		throw error;
	}
}

export function setProfileConfigPath(target: RawSettings, settingPath: string, value: unknown): void {
	const segments = settingPath.split(".");
	let current = target;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index];
		assertSafeKey(segment);
		const existing = current[segment];
		if (existing === undefined) {
			const child: RawSettings = Object.create(null);
			current[segment] = child;
			current = child;
		} else {
			if (!isPlainRecord(existing)) throw invalidSetup();
			current = existing;
		}
	}
	const leaf = segments.at(-1)!;
	assertSafeKey(leaf);
	current[leaf] = value;
}

export function getProfileConfigPath(
	source: Record<string, unknown>,
	settingPath: string,
): { present: boolean; value?: unknown } {
	const segments = settingPath.split(".");
	let current: unknown = source;
	for (const segment of segments) {
		if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) return { present: false };
		current = current[segment];
	}
	return { present: true, value: current };
}

function deleteConfigPath(target: RawSettings, settingPath: string): void {
	const segments = settingPath.split(".");
	const parents: Array<{ object: RawSettings; key: string }> = [];
	let current = target;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index];
		const child = current[segment];
		if (!isPlainRecord(child)) return;
		parents.push({ object: current, key: segment });
		current = child;
	}
	delete current[segments.at(-1)!];
	for (let index = parents.length - 1; index >= 0; index--) {
		const { object, key } = parents[index];
		const child = object[key];
		if (isPlainRecord(child) && Object.keys(child).length === 0) delete object[key];
		else break;
	}
}

function settingGroup(path: SettingPath): ProfileSettingsGroup | undefined {
	if (Object.hasOwn(SPECIAL_TASK_PATHS, path)) return "tasks";
	const tab = getUi(path)?.tab;
	return tab && Object.hasOwn(PROFILE_GROUP_LOOKUP, tab) ? (tab as ProfileSettingsGroup) : undefined;
}

/** Resolve portable ownership from canonical schema UI metadata. */
export function getProfileSettingGroup(path: SettingPath): ProfileSettingsGroup | undefined {
	return settingGroup(path);
}

/** Portable settings deliberately exclude free-form machine data and exact local-service categories. */
export function isPortableProfileSettingPath(path: SettingPath): boolean {
	if (Object.hasOwn(SPECIAL_TASK_PATHS, path) || Object.hasOwn(PORTABLE_STRUCTURED_PATHS, path)) return true;
	const group = settingGroup(path);
	if (!group || isCredential(path) || Object.hasOwn(LOCAL_ONLY_SETTING_PATHS, path)) return false;
	const definition = SETTINGS_SCHEMA[path];
	if (definition.type !== "boolean" && definition.type !== "number" && definition.type !== "enum") return false;
	return !path
		.toLowerCase()
		.split(".")
		.some(segment => Object.hasOwn(LOCAL_ONLY_PATH_SEGMENTS, segment));
}

function collectProfileGroupPaths(group: ProfileSettingsGroup): readonly SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
		path => settingGroup(path) === group && isPortableProfileSettingPath(path),
	);
}

const PROFILE_GROUP_PATHS: Readonly<Record<ProfileSettingsGroup, readonly SettingPath[]>> = Object.freeze({
	model: collectProfileGroupPaths("model"),
	appearance: collectProfileGroupPaths("appearance"),
	interaction: collectProfileGroupPaths("interaction"),
	context: collectProfileGroupPaths("context"),
	memory: collectProfileGroupPaths("memory"),
	files: collectProfileGroupPaths("files"),
	shell: collectProfileGroupPaths("shell"),
	tools: collectProfileGroupPaths("tools"),
	tasks: collectProfileGroupPaths("tasks"),
	providers: collectProfileGroupPaths("providers"),
});

export function getProfileGroupPaths(group: ProfileSettingsGroup): readonly SettingPath[] {
	if (!Object.hasOwn(PROFILE_GROUP_PATHS, group)) throw invalidSetup();
	return PROFILE_GROUP_PATHS[group];
}

function assertBoundedTree(
	value: unknown,
	state = { nodes: 0, bytes: 0 },
	seen = new WeakSet<object>(),
	depth = 0,
): void {
	state.nodes += 1;
	if (state.nodes > MAX_TREE_NODES || state.bytes > MAX_NATIVE_SETUP_BYTES || depth > MAX_TREE_DEPTH) {
		throw invalidSetup();
	}
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw invalidSetup();
		return;
	}
	if (typeof value === "string") {
		if (value.length > MAX_STRING_LENGTH) throw invalidSetup();
		state.bytes += Buffer.byteLength(value);
		if (state.bytes > MAX_NATIVE_SETUP_BYTES) throw invalidSetup();
		return;
	}
	if (typeof value !== "object" || seen.has(value)) throw invalidSetup();
	seen.add(value);
	if (Array.isArray(value)) {
		if (value.length > MAX_COLLECTION_ENTRIES) throw invalidSetup();
		for (const child of value) assertBoundedTree(child, state, seen, depth + 1);
		return;
	}
	if (!isPlainRecord(value)) throw invalidSetup();
	const keys = Object.keys(value);
	if (keys.length > MAX_COLLECTION_ENTRIES) throw invalidSetup();
	for (const key of keys) {
		state.bytes += Buffer.byteLength(key);
		if (state.bytes > MAX_NATIVE_SETUP_BYTES) throw invalidSetup();
		assertBoundedTree(value[key], state, seen, depth + 1);
	}
}

function copyBoundedValue(value: unknown, state = { nodes: 0 }, seen = new WeakSet<object>(), depth = 0): unknown {
	state.nodes += 1;
	if (state.nodes > MAX_TREE_NODES || depth > MAX_TREE_DEPTH) throw invalidSetup();
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw invalidSetup();
		return value;
	}
	if (typeof value === "string") {
		if (value.length > MAX_STRING_LENGTH) throw invalidSetup();
		return value;
	}
	if (typeof value !== "object" || value === null || seen.has(value)) throw invalidSetup();
	seen.add(value);
	if (Array.isArray(value)) {
		if (value.length > MAX_COLLECTION_ENTRIES) throw invalidSetup();
		return value.map(item => copyBoundedValue(item, state, seen, depth + 1));
	}
	if (!isPlainRecord(value)) throw invalidSetup();
	const keys = Object.keys(value);
	if (keys.length > MAX_COLLECTION_ENTRIES) throw invalidSetup();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		assertSafeKey(key);
		result[key] = copyBoundedValue(value[key], state, seen, depth + 1);
	}
	return result;
}

function copyStringArray(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length > MAX_COLLECTION_ENTRIES ||
		!value.every(item => typeof item === "string" && item.length <= MAX_STRING_LENGTH)
	) {
		throw invalidSetup();
	}
	return [...value];
}

export function copyProfileModelRoles(value: unknown): ModelRoleAssignments {
	if (!isPlainRecord(value) || Object.keys(value).length > MAX_COLLECTION_ENTRIES) throw invalidSetup();
	const result: ModelRoleAssignments = Object.create(null);
	for (const key of Object.keys(value)) {
		assertSafeKey(key);
		const selector = value[key];
		if (selector !== null && (typeof selector !== "string" || selector.length > MAX_STRING_LENGTH)) {
			throw invalidSetup();
		}
		result[key] = selector;
	}
	return result;
}

export function copyProfileAgentOverrides(value: unknown): Record<string, string | string[] | null> {
	if (!isPlainRecord(value) || Object.keys(value).length > MAX_COLLECTION_ENTRIES) throw invalidSetup();
	const result: Record<string, string | string[] | null> = Object.create(null);
	for (const key of Object.keys(value)) {
		assertSafeKey(key);
		const selector = value[key];
		if (selector === null || (typeof selector === "string" && selector.length <= MAX_STRING_LENGTH)) {
			result[key] = selector;
		} else {
			result[key] = copyStringArray(selector);
		}
	}
	return result;
}

function copyFallbackChains(value: unknown): Record<string, string[]> {
	if (!isPlainRecord(value) || Object.keys(value).length > MAX_COLLECTION_ENTRIES) throw invalidSetup();
	const result: Record<string, string[]> = Object.create(null);
	for (const key of Object.keys(value)) {
		assertSafeKey(key);
		result[key] = copyStringArray(value[key]);
	}
	return result;
}

function copySettingValue(path: SettingPath, value: unknown): unknown {
	const migrated = path === "find.enabled" ? migrateLegacyFindEnabled(value) : value;
	if (path === "retry.fallbackChains") return copyFallbackChains(migrated);
	const definition = SETTINGS_SCHEMA[path];
	switch (definition.type) {
		case "boolean":
			if (typeof migrated !== "boolean") throw invalidSetup();
			return migrated;
		case "number":
			if (typeof migrated !== "number" || !Number.isFinite(migrated)) throw invalidSetup();
			return migrated;
		case "enum":
			if (typeof migrated !== "string" || !(definition.values as readonly string[]).includes(migrated)) {
				throw invalidSetup();
			}
			return migrated;
		case "string":
			if (typeof migrated !== "string" || migrated.length > MAX_STRING_LENGTH) throw invalidSetup();
			return migrated;
		case "array":
			if (!Array.isArray(migrated)) throw invalidSetup();
			return copyBoundedValue(migrated);
		case "record":
			if (!isPlainRecord(migrated)) throw invalidSetup();
			return copyBoundedValue(migrated);
	}
}

const NATIVE_SETTING_PATHS = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
	path => path !== "modelRoles" && settingGroup(path) !== undefined && !isCredential(path),
);
const NATIVE_SETTING_PATH_SET = new Set<string>(NATIVE_SETTING_PATHS);
const NATIVE_ALLOWED_BRANCHES = new Set<string>(["task"]);
for (const settingPath of NATIVE_SETTING_PATHS) {
	const segments = settingPath.split(".");
	for (let index = 1; index < segments.length; index++) {
		NATIVE_ALLOWED_BRANCHES.add(segments.slice(0, index).join("."));
	}
}

function validateConfigTree(value: unknown, prefix = "", seen = new WeakSet<object>()): void {
	if (!isPlainRecord(value) || seen.has(value)) throw invalidSetup();
	seen.add(value);
	for (const key of Object.keys(value)) {
		if (key.includes(".")) throw invalidSetup();
		assertSafeKey(key);
		const childPath = prefix ? `${prefix}.${key}` : key;
		const child = value[key];
		if (childPath === SETUP_METADATA_KEY) throw invalidSetup();
		if (childPath === "modelRoles") {
			copyProfileModelRoles(child);
			continue;
		}
		if (childPath === "task.disabledAgents") {
			copyStringArray(child);
			continue;
		}
		if (childPath === "task.agentModelOverrides") {
			copyProfileAgentOverrides(child);
			continue;
		}
		if (NATIVE_SETTING_PATH_SET.has(childPath)) {
			copySettingValue(childPath as SettingPath, child);
			continue;
		}
		if (!NATIVE_ALLOWED_BRANCHES.has(childPath)) throw invalidSetup();
		validateConfigTree(child, childPath, seen);
	}
}

function copyNativeConfig(parsed: unknown): { config: RawSettings; paths: SettingPath[] } {
	if (!isPlainRecord(parsed)) throw invalidSetup();
	assertBoundedTree(parsed);
	validateConfigTree(parsed);
	if (!Object.hasOwn(parsed, "modelRoles")) throw invalidSetup();
	const config: RawSettings = Object.create(null);
	setProfileConfigPath(config, "modelRoles", copyProfileModelRoles(parsed.modelRoles));
	const paths: SettingPath[] = [];
	for (const settingPath of NATIVE_SETTING_PATHS) {
		const found = getProfileConfigPath(parsed, settingPath);
		if (!found.present) continue;
		const copied = copySettingValue(settingPath, found.value);
		setProfileConfigPath(config, settingPath, copied);
		paths.push(settingPath);
	}
	return { config, paths };
}

function canonicalGroups(groups: readonly ProfileSettingsGroup[]): ProfileSettingsGroup[] {
	return [...groups].sort((left, right) => PROFILE_GROUP_ORDER[left] - PROFILE_GROUP_ORDER[right]);
}

function copyMetadata(value: unknown): SetupMetadata {
	if (!isPlainRecord(value)) throw invalidSetup();
	const keys = Object.keys(value);
	if (keys.some(key => key !== "version" && key !== "emoji" && key !== "enabledGroups")) throw invalidSetup();
	if (
		value.version !== 1 ||
		!Array.isArray(value.enabledGroups) ||
		value.enabledGroups.length > PROFILE_SETTINGS_GROUPS.length
	) {
		throw invalidSetup();
	}
	if (
		value.emoji !== undefined &&
		(typeof value.emoji !== "string" || !Object.hasOwn(PROFILE_EMOJI_LOOKUP, value.emoji as ProfileEmoji))
	) {
		throw invalidSetup();
	}
	const seen = new Set<string>();
	const enabledGroups: ProfileSettingsGroup[] = [];
	for (const group of value.enabledGroups) {
		if (
			typeof group !== "string" ||
			!Object.hasOwn(PROFILE_GROUP_LOOKUP, group as ProfileSettingsGroup) ||
			seen.has(group)
		) {
			throw invalidSetup();
		}
		seen.add(group);
		enabledGroups.push(group as ProfileSettingsGroup);
	}
	return {
		version: 1,
		...(value.emoji === undefined ? {} : { emoji: value.emoji as ProfileEmoji }),
		enabledGroups: canonicalGroups(enabledGroups),
	};
}

function groupsForPaths(paths: readonly SettingPath[]): ProfileSettingsGroup[] {
	const groups = new Set<ProfileSettingsGroup>();
	for (const settingPath of paths) {
		const group = settingGroup(settingPath);
		if (group) groups.add(group);
	}
	return canonicalGroups([...groups]);
}

function validateOwnedPaths(metadata: SetupMetadata, paths: readonly SettingPath[]): void {
	const enabled = new Set(metadata.enabledGroups);
	for (const settingPath of paths) {
		const group = settingGroup(settingPath);
		if (!group || !enabled.has(group)) throw invalidSetup();
	}
}

function validateNativeRoot(parsed: unknown): ProfileDraft {
	if (!isPlainRecord(parsed)) throw invalidSetup();
	const metadataValue = parsed[SETUP_METADATA_KEY];
	const configRoot: RawSettings = Object.create(null);
	for (const key of Object.keys(parsed)) {
		if (key === SETUP_METADATA_KEY) continue;
		assertSafeKey(key);
		configRoot[key] = parsed[key];
	}
	const { config, paths } = copyNativeConfig(configRoot);
	const metadata =
		metadataValue === undefined
			? { version: 1 as const, enabledGroups: groupsForPaths(paths) }
			: copyMetadata(metadataValue);
	validateOwnedPaths(metadata, paths);
	return { metadata, config };
}

/** Validate and detach a draft from caller-owned mutable values. */
export function validateProfileDraft(draft: ProfileDraft): ProfileDraft {
	if (!isPlainRecord(draft) || !Object.hasOwn(draft, "metadata") || !Object.hasOwn(draft, "config")) {
		throw invalidSetup();
	}
	const metadata = copyMetadata(draft.metadata);
	const { config, paths } = copyNativeConfig(draft.config);
	validateOwnedPaths(metadata, paths);
	return { metadata, config };
}

/** Return exact local-only saved paths that prevent full-profile export. */
export function getProfileDraftIncompatibilities(draft: ProfileDraft): SettingPath[] {
	const validated = validateProfileDraft(draft);
	return NATIVE_SETTING_PATHS.filter(settingPath => {
		const found = getProfileConfigPath(validated.config, settingPath);
		return found.present && !isPortableProfileSettingPath(settingPath);
	});
}

/** Extract portable role assignments while preserving raw aliases, fallbacks, and configured thinking. */
export function getSetupModelRoles(settings: Settings, snapshot: ProfileSnapshot): ModelRoleAssignments {
	const roles: ModelRoleAssignments = Object.create(null);
	for (const [role, selector] of Object.entries(settings.getModelRoles())) {
		assertSafeKey(role);
		roles[role] = selector ?? null;
	}
	for (const role of snapshot.roles) {
		assertSafeKey(role.role);
		if (!Object.hasOwn(roles, role.role)) roles[role.role] = null;
	}
	const runtimeDefault = snapshot.roles.find(role => role.role === "default");
	if (runtimeDefault?.provider && runtimeDefault.modelId) {
		roles.default = formatModelSelectorValue(
			`${runtimeDefault.provider}/${runtimeDefault.modelId}`,
			runtimeDefault.thinkingLevel,
		);
	}
	return roles;
}

/** New profile drafts always begin with model roles only. */
export function createProfileDraft(settings: Settings, snapshot: ProfileSnapshot): ProfileDraft {
	const config: RawSettings = Object.create(null);
	setProfileConfigPath(config, "modelRoles", getSetupModelRoles(settings, snapshot));
	return { metadata: { version: 1, enabledGroups: [] }, config };
}

/** Toggle ownership immutably; enabling captures current eligible values, disabling deletes every saved path in the group. */
export function setProfileDraftGroup(
	draft: ProfileDraft,
	group: ProfileSettingsGroup,
	enabled: boolean,
	settings: Settings,
): ProfileDraft {
	if (!Object.hasOwn(PROFILE_GROUP_LOOKUP, group)) throw invalidSetup();
	const next = validateProfileDraft(draft);
	const enabledGroups = new Set(next.metadata.enabledGroups);
	if (enabled === enabledGroups.has(group)) return next;
	if (enabled) {
		const paths = getProfileGroupPaths(group);
		if (paths.length === 0) throw new Error(`The ${group} settings group has no portable settings`);
		for (const settingPath of paths) {
			if (getProfileConfigPath(next.config, settingPath).present) continue;
			const value: unknown = settings.get(settingPath);
			if (value === undefined) continue;
			setProfileConfigPath(next.config, settingPath, copySettingValue(settingPath, value));
		}
		enabledGroups.add(group);
	} else {
		for (const settingPath of NATIVE_SETTING_PATHS) {
			if (settingGroup(settingPath) === group) deleteConfigPath(next.config, settingPath);
		}
		enabledGroups.delete(group);
	}
	next.metadata.enabledGroups = canonicalGroups([...enabledGroups]);
	return next;
}

function nativeRoot(draft: ProfileDraft): RawSettings {
	const validated = validateProfileDraft(draft);
	const root: RawSettings = Object.create(null);
	root[SETUP_METADATA_KEY] = {
		version: 1,
		...(validated.metadata.emoji === undefined ? {} : { emoji: validated.metadata.emoji }),
		enabledGroups: [...validated.metadata.enabledGroups],
	};
	for (const [key, value] of Object.entries(validated.config)) root[key] = value;
	return root;
}

async function writeSetup(filePath: string, draft: ProfileDraft, overwrite: boolean): Promise<void> {
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await hasSafeSetupDirectory(directory))) throw new Error("Saved setup storage is invalid");
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let removeTemp = false;
	try {
		const handle = await fs.open(tempPath, "wx", 0o600);
		removeTemp = true;
		try {
			const content = stringifyYamlConfig(nativeRoot(draft));
			if (Buffer.byteLength(content) > MAX_NATIVE_SETUP_BYTES) throw new Error("Saved setup is too large");
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (overwrite) {
			try {
				const target = await fs.lstat(filePath);
				if (!target.isFile() || target.isSymbolicLink()) {
					throw new Error("Saved setup target is not a regular file");
				}
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			await replaceFileAtomically(tempPath, filePath);
			removeTemp = false;
		} else {
			try {
				await fs.link(tempPath, filePath);
			} catch (error) {
				if (isEexist(error)) {
					throw new Error(`A saved setup named "${path.basename(filePath, SETUP_EXTENSION)}" already exists`);
				}
				throw error;
			}
			await fs.rm(tempPath);
			removeTemp = false;
		}
	} finally {
		if (removeTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
	}
}

async function readSetupFile(filePath: string, name: string): Promise<ProfileDraft> {
	if (!(await hasSafeSetupDirectory(path.dirname(filePath)))) {
		throw new Error(`Saved setup "${name}" was not found`);
	}
	const content = await readBoundedRegularTextFile(filePath, MAX_NATIVE_SETUP_BYTES, {
		invalid: "Saved setup is invalid",
		notFound: `Saved setup "${name}" was not found`,
		failed: "Failed to read saved setup",
		tooLarge: "Saved setup is too large",
	});
	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch {
		throw invalidSetup();
	}
	return validateNativeRoot(parsed);
}

/** List native saved setup overlays without creating setup storage. */
export async function listSavedSetups(agentDir = getAgentDir()): Promise<SavedSetupDescriptor[]> {
	const directory = path.resolve(agentDir, SETUPS_DIRNAME);
	try {
		if (!(await hasSafeSetupDirectory(directory))) return [];
	} catch {
		throw new Error("Failed to list saved setups");
	}
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw new Error("Failed to list saved setups");
	}
	const descriptors: SavedSetupDescriptor[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(SETUP_EXTENSION)) continue;
		const rawName = entry.name.slice(0, -SETUP_EXTENSION.length);
		let name: string;
		try {
			name = normalizeSetupName(rawName);
		} catch {
			continue;
		}
		if (name !== rawName) continue;
		try {
			const filePath = path.join(directory, entry.name);
			const stats = await fs.lstat(filePath);
			if (!stats.isFile() || stats.isSymbolicLink()) continue;
			let metadata: SetupMetadata | undefined;
			try {
				metadata = (await readSetupFile(filePath, name)).metadata;
			} catch {
				// Invalid entries remain discoverable so selecting them can surface the validation error.
			}
			descriptors.push({ name, updatedAt: stats.mtimeMs, ...(metadata ? { metadata } : {}) });
		} catch (error) {
			if (!isEnoent(error)) throw new Error("Failed to list saved setups");
		}
	}
	return descriptors.sort((left, right) => left.name.localeCompare(right.name));
}

/** Load and validate a native setup overlay by name, separating inert metadata from executable settings. */
export async function loadSavedSetup(
	name: string,
	agentDir = getAgentDir(),
): Promise<{ path: string; config: RawSettings; metadata: SetupMetadata }> {
	const normalized = normalizeSetupName(name);
	const filePath = setupPath(normalized, agentDir);
	try {
		const draft = await readSetupFile(filePath, normalized);
		return { path: filePath, config: draft.config, metadata: draft.metadata };
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "Saved setup is invalid" ||
				error.message === "Saved setup is too large" ||
				error.message.includes("was not found"))
		) {
			throw error;
		}
		throw new Error("Failed to read saved setup");
	}
}

/** Rename a saved setup without rewriting it or replacing another setup. */
export async function renameSavedSetup(
	name: string,
	newName: string,
	agentDir = getAgentDir(),
): Promise<SavedSetupDescriptor> {
	const normalized = normalizeSetupName(name);
	const normalizedNewName = normalizeSetupName(newName);
	const sourcePath = setupPath(normalized, agentDir);
	const destinationPath = setupPath(normalizedNewName, agentDir);
	const sourceStats = await regularSetupStats(sourcePath, normalized);
	if (normalized === normalizedNewName) {
		return { name: normalizedNewName, updatedAt: sourceStats.mtimeMs };
	}
	let destinationStats: Stats | undefined;
	try {
		destinationStats = await fs.lstat(destinationPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (destinationStats) {
		const entries = await fs.readdir(path.dirname(destinationPath));
		const isCaseOnlyRename =
			sourcePath.toLowerCase() === destinationPath.toLowerCase() &&
			isSameFile(sourceStats, destinationStats) &&
			entries.includes(path.basename(sourcePath)) &&
			!entries.includes(path.basename(destinationPath));
		if (!isCaseOnlyRename) throw new Error(`A saved setup named "${normalizedNewName}" already exists`);
		try {
			await fs.rename(sourcePath, destinationPath);
			const entries = await fs.readdir(path.dirname(destinationPath));
			if (!entries.includes(path.basename(destinationPath))) {
				throw new Error("The filesystem did not apply the requested filename casing");
			}
		} catch (error) {
			throw new Error(
				`Saved setup "${normalized}" could not be renamed to "${normalizedNewName}" without overwriting; the source data was preserved`,
				{ cause: error },
			);
		}
		const renamedStats = await regularSetupStats(destinationPath, normalizedNewName);
		return { name: normalizedNewName, updatedAt: renamedStats.mtimeMs };
	}
	try {
		await fs.link(sourcePath, destinationPath);
	} catch (error) {
		if (isEexist(error)) throw new Error(`A saved setup named "${normalizedNewName}" already exists`);
		throw error;
	}
	try {
		const linkedStats = await fs.lstat(destinationPath);
		const currentSourceStats = await fs.lstat(sourcePath);
		if (
			!linkedStats.isFile() ||
			linkedStats.isSymbolicLink() ||
			!isSameFile(sourceStats, linkedStats) ||
			!isSameFile(linkedStats, currentSourceStats)
		) {
			throw new Error("Saved setup changed while it was being renamed");
		}
		await fs.unlink(sourcePath);
	} catch (error) {
		let currentSourceStats: Stats | undefined;
		try {
			currentSourceStats = await fs.lstat(sourcePath);
		} catch (sourceError) {
			if (!isEnoent(sourceError)) throw new Error("Failed to rename saved setup safely", { cause: error });
		}
		if (!currentSourceStats) {
			const renamedStats = await regularSetupStats(destinationPath, normalizedNewName);
			return { name: normalizedNewName, updatedAt: renamedStats.mtimeMs };
		}
		try {
			const currentDestinationStats = await fs.lstat(destinationPath);
			if (isSameFile(currentSourceStats, currentDestinationStats)) await fs.unlink(destinationPath);
		} catch (cleanupError) {
			if (!isEnoent(cleanupError)) throw new Error("Failed to rename saved setup safely", { cause: error });
		}
		throw error;
	}
	const renamedStats = await regularSetupStats(destinationPath, normalizedNewName);
	return { name: normalizedNewName, updatedAt: renamedStats.mtimeMs };
}

/** Delete one saved setup file without changing live settings or sibling setups. */
export async function deleteSavedSetup(name: string, agentDir = getAgentDir()): Promise<void> {
	const normalized = normalizeSetupName(name);
	const filePath = setupPath(normalized, agentDir);
	await regularSetupStats(filePath, normalized);
	try {
		await fs.unlink(filePath);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Saved setup "${normalized}" was not found`);
		throw error;
	}
}

/** Persist a complete draft atomically; create-only unless overwrite is explicit. */
export async function saveProfileDraft(
	name: string,
	draft: ProfileDraft,
	options: { overwrite?: boolean; agentDir?: string } = {},
): Promise<SavedSetupDescriptor> {
	const normalized = normalizeSetupName(name);
	const validated = validateProfileDraft(draft);
	const filePath = setupPath(normalized, options.agentDir ?? getAgentDir());
	const incompatible = getProfileDraftIncompatibilities(validated);
	if (incompatible.length > 0) {
		if (options.overwrite !== true) {
			throw new Error(`Saved setup cannot introduce local-only setting "${incompatible[0]}"`);
		}
		let existing: ProfileDraft;
		try {
			existing = await readSetupFile(filePath, normalized);
		} catch {
			throw new Error(`Saved setup cannot introduce local-only setting "${incompatible[0]}"`);
		}
		for (const settingPath of incompatible) {
			const before = getProfileConfigPath(existing.config, settingPath);
			const after = getProfileConfigPath(validated.config, settingPath);
			if (!before.present || !after.present || !Bun.deepEquals(before.value, after.value)) {
				throw new Error(`Saved setup cannot introduce local-only setting "${settingPath}"`);
			}
		}
	}
	await writeSetup(filePath, validated, options.overwrite === true);
	const stats = await fs.stat(filePath);
	return { name: normalized, updatedAt: stats.mtimeMs, metadata: validated.metadata };
}

/** Update one model role while preserving metadata and every unrelated saved path. */
export async function updateSavedSetupRole(
	name: string,
	role: string,
	selector: string | null,
	agentDir = getAgentDir(),
): Promise<SavedSetupDescriptor> {
	const normalized = normalizeSetupName(name);
	assertSafeKey(role);
	const loaded = await loadSavedSetup(normalized, agentDir);
	const roles = copyProfileModelRoles(loaded.config.modelRoles);
	roles[role] = selector;
	setProfileConfigPath(loaded.config, "modelRoles", roles);
	return saveProfileDraft(
		normalized,
		{ metadata: loaded.metadata, config: loaded.config },
		{ overwrite: true, agentDir },
	);
}

/** Save a create-only native models-only profile. */
export async function saveModelRolesSetup(
	name: string,
	roles: ModelRoleAssignments,
	agentDir = getAgentDir(),
): Promise<SavedSetupDescriptor> {
	const config: RawSettings = Object.create(null);
	setProfileConfigPath(config, "modelRoles", copyProfileModelRoles(roles));
	return saveProfileDraft(name, { metadata: { version: 1, enabledGroups: [] }, config }, { agentDir });
}

/** Save a new models-only draft from the current effective model assignments. */
export async function saveSetup(
	name: string,
	options: { settings: Settings; snapshot: ProfileSnapshot; overwrite?: boolean },
): Promise<SavedSetupDescriptor> {
	return saveProfileDraft(name, createProfileDraft(options.settings, options.snapshot), {
		overwrite: options.overwrite,
		agentDir: options.settings.getAgentDir(),
	});
}
