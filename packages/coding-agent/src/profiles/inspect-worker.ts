import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getActiveProfile, getAgentDir } from "@oh-my-pi/pi-utils";
import { initializeWithSettings } from "../capability";
import { collectUsageSnapshot } from "../cli/usage-cli";
import { getProfileLaunchConfigFiles } from "../cli/profile-bootstrap";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../session/auth-broker-config";
import type { AuthStorage } from "../session/auth-storage";
import { buildProfileSnapshot } from "./snapshot";
import { loadSavedSetup } from "./setups";
import type { ProfileInspectRequest, ProfileInspectResponse } from "./types";
import { sanitizeProfileUsageSnapshot } from "./usage";

const MAX_REQUEST_BYTES = 64 * 1024;

async function readRequest(): Promise<ProfileInspectRequest | undefined> {
	let source: string;
	try {
		source = await Bun.stdin.text();
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(source, "utf8") > MAX_REQUEST_BYTES) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const setup = record.setup;
	if (
		Object.keys(record).some(key => key !== "cwd" && key !== "usage" && key !== "setup") ||
		typeof record.cwd !== "string" ||
		!path.isAbsolute(record.cwd) ||
		typeof record.usage !== "boolean" ||
		(setup !== undefined && typeof setup !== "string")
	) {
		return undefined;
	}
	try {
		if (!(await fs.stat(record.cwd)).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	return {
		cwd: path.normalize(record.cwd),
		usage: record.usage,
		setup,
	};
}

function writeResponse(response: ProfileInspectResponse): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

export async function runProfileInspectWorker(): Promise<void> {
	const request = await readRequest();
	if (!request) {
		writeResponse({ ok: false, message: "Invalid profile inspection request" });
		return;
	}

	let authStorage: AuthStorage | undefined;
	try {
		const setup = request.setup === undefined ? undefined : await loadSavedSetup(request.setup, getAgentDir());
		const configFiles = [...getProfileLaunchConfigFiles()];
		if (setup) configFiles.push(setup.path);
		const settings = await Settings.init({
			readOnly: true,
			cwd: request.cwd,
			configFiles,
		});
		initializeWithSettings(settings);
		const modelRoleOverrides: Record<string, string> = {};
		if (process.env.PI_SMOL_MODEL) modelRoleOverrides.smol = process.env.PI_SMOL_MODEL;
		if (process.env.PI_SLOW_MODEL) modelRoleOverrides.slow = process.env.PI_SLOW_MODEL;
		if (process.env.PI_PLAN_MODEL) modelRoleOverrides.plan = process.env.PI_PLAN_MODEL;
		if (Object.keys(modelRoleOverrides).length > 0) settings.overrideModelRoles(modelRoleOverrides);
		authStorage = await discoverAuthStorage(settings.getAgentDir());
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		await modelRegistry.refresh("offline");
		const snapshot = await buildProfileSnapshot({
			profile: getActiveProfile() ?? "default",
			cwd: request.cwd,
			settings,
			modelRegistry,
			authStorage,
		});
		if (request.usage) {
			try {
				const collection = await collectUsageSnapshot(authStorage, {
					modelRegistry,
				});
				snapshot.usage = sanitizeProfileUsageSnapshot(collection.snapshot);
			} catch {
				snapshot.warnings.push("Usage unavailable for this profile");
			}
		}
		writeResponse({ ok: true, snapshot });
	} catch {
		writeResponse({ ok: false, message: "Unable to inspect profile configuration" });
	} finally {
		authStorage?.close();
	}
}
