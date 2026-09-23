import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { postmortem } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { getProfileLaunchConfigFiles, PROFILE_SWITCH_SUPERVISED_ENV } from "../cli/profile-bootstrap";
import { safeSend } from "../utils/ipc";
import { createProfileLaunchSpec, inspectProfile, listProfiles } from "./client";
import { normalizeProfileName } from "@oh-my-pi/pi-utils/dirs";
import { loadSavedSetup, normalizeSetupName } from "./setups";

export { PROFILE_SWITCH_SUPERVISED_ENV };
const PROFILE_SWITCH_ACK_TIMEOUT_MS = 5_000;
const PROFILE_SETUP_SWITCH_ACK_TIMEOUT_MS = 35_000;
const CHILD_TERMINATION_GRACE_MS = 2_000;

export type ProfileSwitchRequest =
	| { type: "profile-switch"; profile: string; cwd: string; setup?: string }
	| { type: "profile-switch-cancelled" };
export type ProfileSwitchResponse =
	| { type: "profile-switch-accepted" }
	| { type: "profile-switch-rejected"; message: string };

type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;

function canonicalProfileName(profile: string): string {
	if (profile === "default") return profile;
	const normalized = normalizeProfileName(profile);
	if (!normalized || normalized !== profile) throw new Error("Invalid profile switch request");
	return normalized;
}

/** True only in a supervisor-launched child with a live IPC channel. */
export function isSupervisedProfileSwitchChild(): boolean {
	const sender = process.send as IpcSend | undefined;
	return process.env[PROFILE_SWITCH_SUPERVISED_ENV] === "1" && process.connected === true && !!sender;
}

/** Ask the dormant supervisor to accept the next target before tearing down this live session. */
export async function requestSupervisedProfileSwitch(profile: string, cwd: string, setup?: string): Promise<void> {
	if (!isSupervisedProfileSwitchChild()) throw new Error("Profile switch supervisor is unavailable");
	const sender = process.send as IpcSend;
	const deferred = Promise.withResolvers<void>();
	let settled = false;
	const finish = (error?: Error): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		process.off("message", onMessage);
		process.off("disconnect", onDisconnect);
		if (error) {
			cancelSupervisedProfileSwitch();
			deferred.reject(error);
		} else {
			deferred.resolve();
		}
	};
	const onMessage = (message: unknown): void => {
		if (!message || typeof message !== "object") return;
		const type = Reflect.get(message, "type");
		if (type === "profile-switch-accepted") {
			finish();
		} else if (type === "profile-switch-rejected") {
			finish(new Error("Profile switch request was rejected"));
		}
	};
	const onDisconnect = (): void => finish(new Error("Profile switch supervisor disconnected"));
	const timeout = setTimeout(
		() => finish(new Error("Profile switch supervisor did not acknowledge the request")),
		setup === undefined ? PROFILE_SWITCH_ACK_TIMEOUT_MS : PROFILE_SETUP_SWITCH_ACK_TIMEOUT_MS,
	);
	process.on("message", onMessage);
	process.once("disconnect", onDisconnect);
	try {
		const request: ProfileSwitchRequest =
			setup === undefined
				? { type: "profile-switch", profile, cwd }
				: { type: "profile-switch", profile, cwd, setup };
		sender.call(process, request, error => {
			if (error) finish(new Error("Profile switch request could not be sent"));
		});
	} catch {
		finish(new Error("Profile switch request could not be sent"));
	}
	return deferred.promise;
}

/** Withdraw an accepted request when a last-moment busy check or teardown fails. */
export function cancelSupervisedProfileSwitch(): void {
	if (!isSupervisedProfileSwitchChild()) return;
	const sender = process.send as IpcSend | undefined;
	try {
		sender?.call(process, { type: "profile-switch-cancelled" } satisfies ProfileSwitchRequest);
	} catch {}
}

type SupervisedChild = Subprocess<"inherit", "inherit", "inherit">;

async function terminateChild(child: SupervisedChild | undefined): Promise<void> {
	if (!child || child.exitCode !== null) return;
	let processRef: Process | null = null;
	try {
		processRef = Process.fromPid(child.pid);
	} catch {}
	if (processRef) {
		await processRef.terminate({ gracefulMs: CHILD_TERMINATION_GRACE_MS, timeoutMs: 500 }).catch(() => false);
		if (child.exitCode === null) {
			try {
				processRef.killTree(9);
			} catch {}
		}
	} else {
		try {
			child.kill("SIGTERM");
		} catch {}
		await Promise.race([child.exited, Bun.sleep(CHILD_TERMINATION_GRACE_MS)]);
		if (child.exitCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {}
		}
	}
	await Promise.race([child.exited, Bun.sleep(500)]);
}

interface ValidatedSwitchRequest {
	profile: string;
	cwd: string;
	setup?: string;
	configPath?: string;
}

async function validateSwitchRequest(message: unknown): Promise<ValidatedSwitchRequest | undefined> {
	if (!message || typeof message !== "object" || Reflect.get(message, "type") !== "profile-switch") return undefined;
	const profile = Reflect.get(message, "profile");
	const cwd = Reflect.get(message, "cwd");
	const setup = Reflect.get(message, "setup");
	if (
		typeof profile !== "string" ||
		typeof cwd !== "string" ||
		!path.isAbsolute(cwd) ||
		(setup !== undefined && typeof setup !== "string")
	) {
		return undefined;
	}
	let canonical: string;
	let normalizedSetup: string | undefined;
	try {
		canonical = canonicalProfileName(profile);
		normalizedSetup = setup === undefined ? undefined : normalizeSetupName(setup);
	} catch {
		return undefined;
	}
	try {
		if (!(await fs.stat(cwd)).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const profiles = await listProfiles();
	if (!profiles.some(candidate => candidate.name === canonical)) return undefined;
	if (normalizedSetup === undefined) return { profile: canonical, cwd };
	const snapshot = await inspectProfile(
		canonical,
		{ cwd, usage: false, setup: normalizedSetup },
		new AbortController().signal,
	);
	const loaded = await loadSavedSetup(normalizedSetup, snapshot.agentDir);
	return { profile: canonical, cwd, setup: normalizedSetup, configPath: loaded.path };
}

/**
 * Run the one dormant profile-switch supervisor. Exactly one child owns the
 * terminal at a time; accepted zero-exit handoffs replace that child in place.
 */
export async function superviseProfileSwitch(
	initialProfile: string,
	initialCwd: string,
	initialSetup?: string,
): Promise<number> {
	const initial = await validateSwitchRequest(
		initialSetup === undefined
			? {
					type: "profile-switch",
					profile: canonicalProfileName(initialProfile),
					cwd: initialCwd,
				}
			: {
					type: "profile-switch",
					profile: canonicalProfileName(initialProfile),
					cwd: initialCwd,
					setup: initialSetup,
				},
	);
	if (!initial) throw new Error("Profile switch target is no longer available");
	let next = initial;
	let child: SupervisedChild | undefined;
	let shuttingDown = false;
	const unregisterCleanup = postmortem.register(
		"profile-switch-child",
		async () => {
			shuttingDown = true;
			await terminateChild(child);
		},
		{ exitOnly: true },
	);
	try {
		while (!shuttingDown) {
			const args = ["--cwd", next.cwd];
			for (const configFile of getProfileLaunchConfigFiles()) args.push("--config", configFile);
			if (next.configPath) args.push("--config", next.configPath);
			const launch = createProfileLaunchSpec(next.profile, args);
			let pending: ValidatedSwitchRequest | undefined;
			let requestInFlight = false;
			let requestGeneration = 0;
			child = Bun.spawn({
				cmd: launch.cmd,
				cwd: next.cwd,
				env: { ...launch.env, [PROFILE_SWITCH_SUPERVISED_ENV]: "1" },
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
				serialization: "advanced",
				windowsHide: false,
				ipc(message, subprocess) {
					if (
						message &&
						typeof message === "object" &&
						Reflect.get(message, "type") === "profile-switch-cancelled"
					) {
						requestGeneration++;
						pending = undefined;
						requestInFlight = false;
						return;
					}
					if (requestInFlight || pending) {
						safeSend(
							subprocess,
							{ type: "profile-switch-rejected", message: "A profile switch is already pending" },
							"profile switch supervisor",
						);
						return;
					}
					requestInFlight = true;
					const generation = ++requestGeneration;
					void validateSwitchRequest(message)
						.then(request => {
							if (generation !== requestGeneration) return;
							requestInFlight = false;
							if (!request || subprocess.exitCode !== null || shuttingDown) {
								safeSend(
									subprocess,
									{ type: "profile-switch-rejected", message: "Invalid profile switch request" },
									"profile switch supervisor",
								);
								return;
							}
							pending = request;
							safeSend(subprocess, { type: "profile-switch-accepted" }, "profile switch supervisor");
						})
						.catch(() => {
							if (generation !== requestGeneration) return;
							requestInFlight = false;
							safeSend(
								subprocess,
								{ type: "profile-switch-rejected", message: "Invalid profile switch request" },
								"profile switch supervisor",
							);
						});
				},
			});
			const exitCode = await child.exited;
			child = undefined;
			if (shuttingDown) return exitCode;
			if (exitCode !== 0 || !pending) return exitCode;
			next = pending;
		}
		return 1;
	} finally {
		unregisterCleanup();
		await terminateChild(child);
	}
}
