import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEexist, isEnoent, stringifyYamlConfig } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { RawSettings } from "../config/settings";
import { validateModelRolesArtifact } from "./role-sharing";
import { readBoundedRegularTextFile } from "./bounded-file";
import {
	copyProfileModelRoles,
	getProfileConfigPath,
	getProfileDraftIncompatibilities,
	getProfileGroupPaths,
	normalizeSetupName,
	setProfileConfigPath,
	validateProfileDraft,
} from "./setups";
import type { ProfileDraft, ProfileEmoji, ProfileSettingsGroup } from "./types";

const PROFILE_FORMAT = "omp-profile";
const PROFILE_VERSION = 1;
export const MAX_PROFILE_ARTIFACT_BYTES = 1024 * 1024;

export interface ParsedProfile {
	draft: ProfileDraft;
	name?: string;
}

export type ParsedProfileArtifact =
	| { format: "omp-profile"; draft: ProfileDraft; name?: string }
	| { format: "omp-model-roles"; draft: ProfileDraft; name?: string };

function invalidProfileArtifact(): Error {
	return new Error("Profile file is invalid");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertBounded(content: string): void {
	if (Buffer.byteLength(content) > MAX_PROFILE_ARTIFACT_BYTES) throw new Error("Profile file is too large");
}

function parseYaml(content: string): unknown {
	assertBounded(content);
	try {
		return YAML.parse(content);
	} catch {
		throw invalidProfileArtifact();
	}
}

function assertExactRootKeys(value: Record<string, unknown>): void {
	const allowed: Record<string, true> = {
		format: true,
		version: true,
		name: true,
		emoji: true,
		includedGroups: true,
		modelRoles: true,
		settings: true,
	};
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(allowed, key)) throw invalidProfileArtifact();
	}
	for (const required of ["format", "version", "includedGroups", "modelRoles", "settings"]) {
		if (!Object.hasOwn(value, required)) throw invalidProfileArtifact();
	}
}

/** Serialize exactly the paths owned by a full profile draft. */
export function serializeProfile(draft: ProfileDraft, name?: string): string {
	const validated = validateProfileDraft(draft);
	const incompatible = getProfileDraftIncompatibilities(validated);
	if (incompatible.length > 0) {
		throw new Error(`Profile cannot be exported because "${incompatible[0]}" is local-only`);
	}
	const settings: RawSettings = Object.create(null);
	for (const group of validated.metadata.enabledGroups) {
		for (const settingPath of getProfileGroupPaths(group)) {
			const found = getProfileConfigPath(validated.config, settingPath);
			if (found.present) setProfileConfigPath(settings, settingPath, found.value);
		}
	}
	const root: Record<string, unknown> = {
		format: PROFILE_FORMAT,
		version: PROFILE_VERSION,
		...(name === undefined ? {} : { name: normalizeSetupName(name) }),
		...(validated.metadata.emoji === undefined ? {} : { emoji: validated.metadata.emoji }),
		includedGroups: [...validated.metadata.enabledGroups],
		modelRoles: copyProfileModelRoles(validated.config.modelRoles),
		settings,
	};
	const content = stringifyYamlConfig(root);
	assertBounded(content);
	return content;
}

function parseProfileRoot(parsed: unknown): ParsedProfile {
	try {
		if (!isPlainRecord(parsed)) throw invalidProfileArtifact();
		assertExactRootKeys(parsed);
		if (parsed.format !== PROFILE_FORMAT || parsed.version !== PROFILE_VERSION) throw invalidProfileArtifact();
		if (parsed.name !== undefined && typeof parsed.name !== "string") throw invalidProfileArtifact();
		if (!Array.isArray(parsed.includedGroups) || !isPlainRecord(parsed.settings)) throw invalidProfileArtifact();
		if (Object.hasOwn(parsed.settings, "modelRoles") || Object.hasOwn(parsed.settings, "$setup")) {
			throw invalidProfileArtifact();
		}
		const config: RawSettings = Object.create(null);
		setProfileConfigPath(config, "modelRoles", copyProfileModelRoles(parsed.modelRoles));
		for (const [key, value] of Object.entries(parsed.settings)) config[key] = value;
		const draft = validateProfileDraft({
			metadata: {
				version: 1,
				...(parsed.emoji === undefined ? {} : { emoji: parsed.emoji as ProfileEmoji }),
				enabledGroups: parsed.includedGroups as ProfileSettingsGroup[],
			},
			config,
		});
		if (getProfileDraftIncompatibilities(draft).length > 0) throw invalidProfileArtifact();
		return {
			draft,
			...(parsed.name === undefined ? {} : { name: normalizeSetupName(parsed.name) }),
		};
	} catch {
		throw invalidProfileArtifact();
	}
}

/** Parse the strict omp-profile v1 envelope without consulting or mutating local settings. */
export function parseProfile(content: string): ParsedProfile {
	return parseProfileRoot(parseYaml(content));
}

/** Dispatch either supported share envelope while normalizing both to a profile draft. */
export function parseProfileArtifact(content: string): ParsedProfileArtifact {
	const parsed = parseYaml(content);
	const format = isPlainRecord(parsed) ? parsed.format : undefined;
	if (format === PROFILE_FORMAT) return { format: "omp-profile", ...parseProfileRoot(parsed) };
	if (format === "omp-model-roles") {
		const config: RawSettings = Object.create(null);
		setProfileConfigPath(config, "modelRoles", validateModelRolesArtifact(parsed));
		return {
			format: "omp-model-roles",
			draft: { metadata: { version: 1, enabledGroups: [] }, config },
		};
	}
	throw invalidProfileArtifact();
}

async function readBoundedFile(filePath: string): Promise<string> {
	return readBoundedRegularTextFile(filePath, MAX_PROFILE_ARTIFACT_BYTES, {
		invalid: "Profile file is invalid",
		notFound: "Profile file was not found",
		failed: "Failed to read profile file",
		tooLarge: "Profile file is too large",
	});
}

export async function readProfileFile(filePath: string): Promise<ParsedProfile> {
	return parseProfile(await readBoundedFile(filePath));
}

export async function readProfileArtifactFile(filePath: string): Promise<ParsedProfileArtifact> {
	return parseProfileArtifact(await readBoundedFile(filePath));
}

/** Create a full-profile artifact atomically; an existing destination is never replaced. */
export async function writeProfileFile(filePath: string, draft: ProfileDraft, name?: string): Promise<void> {
	const content = serializeProfile(draft, name);
	const directory = path.dirname(filePath);
	try {
		const stats = await fs.lstat(directory);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("invalid-directory");
	} catch (error) {
		if (isEnoent(error)) throw new Error("The selected directory does not exist");
		throw new Error("Failed to write profile file");
	}
	const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
	let removeTemp = false;
	try {
		const handle = await fs.open(tempPath, "wx", 0o600);
		removeTemp = true;
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fs.link(tempPath, filePath);
		} catch (error) {
			if (isEexist(error)) throw new Error("A file already exists at the selected path");
			throw new Error("Failed to write profile file");
		}
		await fs.rm(tempPath);
		removeTemp = false;
	} finally {
		if (removeTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
	}
}
