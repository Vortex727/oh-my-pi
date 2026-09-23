import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isCompiledBinary, isEnoent, isRecord, stripWindowsExtendedLengthPathPrefix } from "@oh-my-pi/pi-utils";
import { getActiveProfile, getProfileRootDir, normalizeProfileName } from "@oh-my-pi/pi-utils/dirs";
import { filterProcessEnv } from "@oh-my-pi/pi-utils/env";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import {
	getProfileLaunchConfigFiles,
	getProfileLaunchEnvironment,
	PROFILE_LAUNCH_CONFIG_FILES_ENV,
} from "../cli/profile-bootstrap";
import type {
	ProfileAgentRow,
	ProfileDescriptor,
	ProfileInspectRequest,
	ProfileInspectResponse,
	ProfileRoleRow,
	ProfileSettingRow,
	ProfileSnapshot,
} from "./types";

export const PROFILE_INSPECT_WORKER_ARG = "__omp_worker_profile_inspect";

const INSPECTION_TIMEOUT_MS = 30_000;
const MAX_PROTOCOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONCURRENT_INSPECTIONS = 2;
const CLI_REQUIRED_MESSAGE = "Profile inspection and switching require the OMP CLI";

let discoveryWarnings: string[] = [];
let activeInspections = 0;
interface InspectionWaiter {
	resolve: (release: () => void) => void;
	signal: AbortSignal;
	onAbort: () => void;
}
const inspectionWaiters: InspectionWaiter[] = [];

function abortError(): Error {
	return new DOMException("Profile inspection cancelled", "AbortError");
}

function releaseInspectionSlot(): void {
	activeInspections--;
	while (inspectionWaiters.length > 0) {
		const waiter = inspectionWaiters.shift()!;
		waiter.signal.removeEventListener("abort", waiter.onAbort);
		if (waiter.signal.aborted) continue;
		activeInspections++;
		waiter.resolve(releaseInspectionSlot);
		return;
	}
}

async function acquireInspectionSlot(signal: AbortSignal): Promise<() => void> {
	if (signal.aborted) throw abortError();
	if (activeInspections < MAX_CONCURRENT_INSPECTIONS) {
		activeInspections++;
		return releaseInspectionSlot;
	}
	const deferred = Promise.withResolvers<() => void>();
	const waiter: InspectionWaiter = {
		resolve: deferred.resolve,
		signal,
		onAbort: () => {
			const index = inspectionWaiters.indexOf(waiter);
			if (index >= 0) inspectionWaiters.splice(index, 1);
			deferred.reject(abortError());
		},
	};
	inspectionWaiters.push(waiter);
	signal.addEventListener("abort", waiter.onAbort, { once: true });
	return deferred.promise;
}

async function discoverProfileSource(directory: string, names: Set<string>, warnings: string[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return;
		warnings.push("A profile directory could not be read");
		return;
	}
	for (const entry of entries) {
		let normalized: string | undefined;
		try {
			normalized = normalizeProfileName(entry.name);
		} catch {
			continue;
		}
		if (!normalized) continue;
		let isDirectory = entry.isDirectory();
		if (!isDirectory && entry.isSymbolicLink()) {
			try {
				isDirectory = (await fs.stat(path.join(directory, entry.name))).isDirectory();
			} catch {
				isDirectory = false;
			}
		}
		if (isDirectory) names.add(normalized);
	}
}

/** Discover valid saved profile directories without creating or opening profile storage. */
export async function listProfiles(): Promise<ProfileDescriptor[]> {
	const warnings: string[] = [];
	const names = new Set<string>(["default"]);
	const active = getActiveProfile() ?? "default";
	names.add(active);
	const baseline = getProfileLaunchEnvironment() ?? process.env;
	const sources = new Set<string>([path.join(getProfileRootDir(undefined), "profiles")]);
	if (process.platform === "linux" || process.platform === "darwin") {
		for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const) {
			const root = baseline[key];
			if (root) sources.add(path.join(root, "omp", "profiles"));
		}
	}
	await Promise.all([...sources].map(source => discoverProfileSource(source, names, warnings)));
	discoveryWarnings = warnings;
	return [...names]
		.map(name => ({ name, active: name === active }))
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			if (left.name === "default" || right.name === "default") return left.name === "default" ? -1 : 1;
			return left.name.localeCompare(right.name);
		});
}

/** Warnings from the most recent profile discovery pass. */
export function getProfileDiscoveryWarnings(): string[] {
	return [...discoveryWarnings];
}

/** Whether this process was entered through a real CLI host that can safely relaunch itself. */
export function hasProfileLaunchContext(): boolean {
	return getProfileLaunchEnvironment() !== undefined && (isCompiledBinary() || workerHostEntry() !== null);
}

export interface ProfileLaunchSpec {
	cmd: string[];
	env: Record<string, string>;
}

/** Build a target-profile CLI invocation from the original, pre-dotenv launch environment. */
export function createProfileLaunchSpec(profile: string, args: readonly string[]): ProfileLaunchSpec {
	const baseline = getProfileLaunchEnvironment();
	const hostEntry = workerHostEntry();
	if (!baseline || (!isCompiledBinary() && !hostEntry)) throw new Error(CLI_REQUIRED_MESSAGE);
	const normalized = normalizeProfileName(profile);
	const profileName = normalized ?? "default";
	const executable = stripWindowsExtendedLengthPathPrefix(process.execPath);
	const cmd = isCompiledBinary() ? [executable] : [executable, hostEntry!];
	cmd.push("--profile", profileName, ...args);

	const env = filterProcessEnv(baseline);
	env[PROFILE_LAUNCH_CONFIG_FILES_ENV] = JSON.stringify(getProfileLaunchConfigFiles());
	return { cmd, env };
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<{ text: string; overflow: boolean }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let capturedBytes = 0;
	let totalBytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (capturedBytes < MAX_PROTOCOL_OUTPUT_BYTES) {
				const take = Math.min(value.byteLength, MAX_PROTOCOL_OUTPUT_BYTES - capturedBytes);
				text += decoder.decode(value.subarray(0, take), { stream: true });
				capturedBytes += take;
			}
		}
		text += decoder.decode();
		return { text, overflow: totalBytes > MAX_PROTOCOL_OUTPUT_BYTES };
	} finally {
		reader.releaseLock();
	}
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isOptionalRoleCost(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || typeof value.input !== "number" || typeof value.output !== "number") return false;
	const rates = [value.input, value.output];
	if (value.cacheRead !== undefined) {
		if (typeof value.cacheRead !== "number") return false;
		rates.push(value.cacheRead);
	}
	if (value.cacheWrite !== undefined) {
		if (typeof value.cacheWrite !== "number") return false;
		rates.push(value.cacheWrite);
	}
	return rates.every(rate => Number.isFinite(rate) && rate >= 0) && rates.some(rate => rate > 0);
}

function isRoleRow(value: unknown): value is ProfileRoleRow {
	return (
		isRecord(value) &&
		typeof value.role === "string" &&
		isOptionalString(value.selector) &&
		isOptionalString(value.provider) &&
		isOptionalString(value.modelId) &&
		isOptionalString(value.thinkingLevel) &&
		isOptionalRoleCost(value.cost) &&
		typeof value.automatic === "boolean" &&
		isOptionalString(value.warning)
	);
}

function isAgentRow(value: unknown): value is ProfileAgentRow {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.enabled === "boolean" &&
		typeof value.source === "string" &&
		isOptionalString(value.selector) &&
		isOptionalString(value.provider) &&
		isOptionalString(value.modelId) &&
		isOptionalString(value.thinkingLevel) &&
		isOptionalString(value.warning)
	);
}

function isSettingRow(value: unknown): value is ProfileSettingRow {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.label === "string" &&
		(value.value === null || ["boolean", "number", "string"].includes(typeof value.value)) &&
		typeof value.hidden === "boolean" &&
		typeof value.configured === "boolean"
	);
}

function containsRawPayload(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsRawPayload);
	if (!isRecord(value)) return false;
	if (Object.hasOwn(value, "raw")) return true;
	return Object.values(value).some(containsRawPayload);
}

function isProfileSnapshot(value: unknown): value is ProfileSnapshot {
	if (!isRecord(value) || containsRawPayload(value)) return false;
	if (
		typeof value.profile !== "string" ||
		typeof value.generatedAt !== "number" ||
		!Number.isFinite(value.generatedAt) ||
		typeof value.agentDir !== "string" ||
		!isRecord(value.credentialSources) ||
		!Object.values(value.credentialSources).every(source => typeof source === "string") ||
		!Array.isArray(value.roles) ||
		!value.roles.every(isRoleRow) ||
		!Array.isArray(value.agents) ||
		!value.agents.every(isAgentRow) ||
		!isRecord(value.memory) ||
		typeof value.memory.backend !== "string" ||
		!isOptionalString(value.memory.scope) ||
		typeof value.memory.storageLabel !== "string" ||
		!Array.isArray(value.settings) ||
		!value.settings.every(isSettingRow) ||
		!Array.isArray(value.warnings) ||
		!value.warnings.every(warning => typeof warning === "string")
	) {
		return false;
	}
	if (value.usage === undefined) return true;
	return (
		isRecord(value.usage) &&
		typeof value.usage.generatedAt === "number" &&
		Number.isFinite(value.usage.generatedAt) &&
		Array.isArray(value.usage.reports) &&
		value.usage.reports.every(isRecord) &&
		Array.isArray(value.usage.accountsWithoutUsage) &&
		value.usage.accountsWithoutUsage.every(isRecord) &&
		isRecord(value.usage.capacity) &&
		Object.values(value.usage.capacity).every(Array.isArray)
	);
}

function parseInspectResponse(text: string): ProfileInspectResponse {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Profile inspection returned invalid data");
	}
	if (!isRecord(value) || typeof value.ok !== "boolean") throw new Error("Profile inspection returned invalid data");
	if (value.ok === false) {
		if (typeof value.message !== "string") throw new Error("Profile inspection returned invalid data");
		return { ok: false, message: value.message };
	}
	if (!isProfileSnapshot(value.snapshot)) throw new Error("Profile inspection returned invalid data");
	return { ok: true, snapshot: value.snapshot };
}

async function runInspectionProcess(
	profile: string,
	request: unknown,
	cwd: string,
	signal: AbortSignal,
): Promise<ProfileInspectResponse> {
	const release = await acquireInspectionSlot(signal);
	try {
		// Even an immediately available async slot resumes on a later microtask.
		if (signal.aborted) throw abortError();
		const args = [PROFILE_INSPECT_WORKER_ARG];
		for (const configFile of getProfileLaunchConfigFiles()) args.push("--config", configFile);
		const launch = createProfileLaunchSpec(profile, args);
		const proc = Bun.spawn({
			cmd: launch.cmd,
			cwd,
			env: launch.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		let stopped: "abort" | "timeout" | undefined;
		const stop = (reason: "abort" | "timeout"): void => {
			if (stopped || proc.exitCode !== null) return;
			stopped = reason;
			try {
				proc.kill("SIGKILL");
			} catch {}
		};
		const onAbort = (): void => stop("abort");
		signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => stop("timeout"), INSPECTION_TIMEOUT_MS);
		try {
			const stdout = readBounded(proc.stdout);
			const stderr = readBounded(proc.stderr);
			proc.stdin.write(JSON.stringify(request));
			proc.stdin.end();
			const exitCode = await proc.exited;
			const [out] = await Promise.all([stdout, stderr]);
			if (stopped === "abort") throw abortError();
			if (stopped === "timeout") throw new Error("Profile inspection timed out");
			if (exitCode !== 0) throw new Error("Profile inspection failed");
			if (out.overflow) throw new Error("Profile inspection returned too much data");
			return parseInspectResponse(out.text.trim());
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			if (proc.exitCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {}
				await proc.exited;
			}
		}
	} finally {
		release();
	}
}

/** Inspect one profile in a fresh, isolated CLI subprocess. */
export async function inspectProfile(
	profile: string,
	request: ProfileInspectRequest,
	signal: AbortSignal,
): Promise<ProfileSnapshot> {
	const normalized = normalizeProfileName(profile);
	const profileName = normalized ?? "default";
	const response = await runInspectionProcess(profileName, request, request.cwd, signal);
	if (!response.ok) throw new Error(response.message || "Profile inspection failed");
	if (response.snapshot.profile !== profileName) throw new Error("Profile inspection returned the wrong profile");
	return response.snapshot;
}

/** Distribution smoke probe for the hidden profile-inspection module graph, without opening credentials or fetching usage. */
export async function smokeTestProfileInspectWorker(): Promise<void> {
	const controller = new AbortController();
	const active = getActiveProfile() ?? "default";
	const response = await runInspectionProcess(active, {}, process.cwd(), controller.signal);
	if (response.ok) throw new Error("profile inspection smoke failed: malformed request was accepted");
}
