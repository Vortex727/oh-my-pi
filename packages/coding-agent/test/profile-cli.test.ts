import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as profileClient from "@oh-my-pi/pi-coding-agent/profiles/client";
import * as profileLaunch from "@oh-my-pi/pi-coding-agent/profiles/launch";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import {
	__resetProfileSnapshotForTests,
	APP_NAME,
	getActiveProfile,
	getAgentDbPath,
	getAgentDir,
	setAgentDir,
	setProfile,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { runCli } from "../src/cli";
import * as profileAliasCli from "../src/cli/profile-alias";
import { resumeCommand } from "../src/utils/resume-command";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

describe("global --profile flag", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalAgentDir = "";
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalConfigDir = process.env.PI_CONFIG_DIR;
		configDir = `.omp-profile-cli-test-${Snowflake.next()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalProfile) {
			setProfile(originalProfile);
		} else if (originalAgentDirEnv !== undefined) {
			setAgentDir(originalAgentDir);
		} else {
			setProfile(undefined);
		}
		if (originalOmpProfileEnv === undefined) {
			delete process.env.OMP_PROFILE;
		} else {
			process.env.OMP_PROFILE = originalOmpProfileEnv;
		}
		if (originalPiProfileEnv === undefined) {
			delete process.env.PI_PROFILE;
		} else {
			process.env.PI_PROFILE = originalPiProfileEnv;
		}
		if (originalAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		}
		__resetProfileSnapshotForTests();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("activates a profile before dispatching root flags", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile=work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(writeSpy).toHaveBeenCalled();
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));
	});

	it("activates a profile inherited from OMP_PROFILE at run time", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		setProfile(undefined);
		process.env.OMP_PROFILE = "work";
		delete process.env.PI_PROFILE;

		await runCli(["--version"]);

		expect(process.exitCode).toBe(0);
		expect(writeSpy).toHaveBeenCalled();
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));
		expect(getAgentDbPath()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent", "agent.db"));
	});

	it("accepts the profile flag after other root flags", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--version", "--profile", "office"]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("office");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "office", "agent"));
	});

	it("installs a shell alias and exits before command dispatch", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "omp-work",
			profile: "work",
			command: "omp --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile", "work", "--alias", "omp-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "omp-work",
			}),
		);
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created omp-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("installs a shell alias when launch is explicit", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "omp-work",
			profile: "work",
			command: "omp --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["launch", "--profile", "work", "--alias", "omp-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "omp-work",
			}),
		);
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created omp-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("installs a shell alias when acp is explicit", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "omp-work",
			profile: "work",
			command: "omp --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["acp", "--profile", "work", "--alias", "omp-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "omp-work",
			}),
		);
		expect(getActiveProfile()).toBe("work");
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created omp-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("rejects missing profile values without dispatching", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile", "--version"]);

		expect(process.exitCode).toBe(1);
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")).toContain(
			"--profile requires a profile name",
		);
		expect(outSpy).not.toHaveBeenCalled();
	});

	it("loads profile agent .env before command modules import pi-utils env", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-cli-env-"));
		try {
			const home = path.join(root, "home");
			const configDir = ".omp-profile-cli-env";
			const defaultAgentDir = path.join(home, configDir, "agent");
			const profileAgentDir = path.join(home, configDir, "profiles", "work", "agent");
			await fs.mkdir(defaultAgentDir, { recursive: true });
			await fs.mkdir(profileAgentDir, { recursive: true });
			await Bun.write(path.join(defaultAgentDir, ".env"), "OMP_PROFILE_BOOTSTRAP_SENTINEL=default\n");
			await Bun.write(path.join(profileAgentDir, ".env"), "OMP_PROFILE_BOOTSTRAP_SENTINEL=work\n");

			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					'await runCli(["--profile", "work", "--help"]);',
					'process.stdout.write("\\nSENTINEL=" + (Bun.env.OMP_PROFILE_BOOTSTRAP_SENTINEL ?? ""));',
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: configDir,
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
			};
			delete childEnv.OMP_PROFILE;
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;
			delete childEnv.OMP_PROFILE_BOOTSTRAP_SENTINEL;

			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("SENTINEL=work");
			expect(stdout).not.toContain("SENTINEL=default");
		} finally {
			await removeWithRetries(root);
		}
		// Spawns a probe that imports the command modules, so the cost is cold
		// transpile of the CLI graph, not latency under test.
	}, 30_000);

	it("surfaces an invalid OMP_PROFILE env as a clean error, not an import crash", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-cli-env-bad-"));
		try {
			const home = path.join(root, "home");
			await fs.mkdir(home, { recursive: true });

			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					'await runCli(["--version"]);',
					// Reached only if the module import did NOT throw — i.e. the invalid
					// env was deferred to runCli's error handler instead of crashing the
					// process during the static import of dirs.ts.
					'process.stdout.write("HANDLED");',
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: ".omp-profile-cli-env-bad",
				OMP_PROFILE: "..",
				NO_COLOR: "1",
			};
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;

			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);

			expect(stdout, stderr).toContain("HANDLED");
			expect(stderr).toContain("Invalid OMP profile");
			expect(exitCode).toBe(1);
		} finally {
			await removeWithRetries(root);
		}
		// Same cold-spawn cost as the sibling above; it only escapes Bun's 5s
		// default because that test warms the transpile cache first.
	}, 30_000);
});

describe("profile inspection client lifecycle", () => {
	it("cancels before spawning and releases the inspection slot for the next request", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-inspect-cancel-"));
		try {
			const home = path.join(root, "home");
			const workspace = path.join(root, "workspace");
			const workerLog = path.join(root, "workers.log");
			await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
			const probe = path.join(root, "inspect-cancel-probe.ts");
			const clientUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "client.ts"),
			).href;
			const bootstrapUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "cli", "profile-bootstrap.ts"),
			).href;
			const workerHostUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "utils", "src", "worker-host.ts"),
			).href;
			await Bun.write(
				probe,
				[
					'import * as fs from "node:fs/promises";',
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					`import { captureProfileLaunchEnvironment } from ${JSON.stringify(bootstrapUrl)};`,
					`import { inspectProfile, PROFILE_INSPECT_WORKER_ARG } from ${JSON.stringify(clientUrl)};`,
					`import { declareWorkerHostEntry } from ${JSON.stringify(workerHostUrl)};`,
					`const workerLog = ${JSON.stringify(workerLog)};`,
					"const args = process.argv.slice(2);",
					"captureProfileLaunchEnvironment(args);",
					"if (args.includes(PROFILE_INSPECT_WORKER_ARG)) {",
					'\tawait fs.appendFile(workerLog, "worker\\n");',
					"\tawait runCli(args);",
					"} else {",
					"\tdeclareWorkerHostEntry();",
					"\tconst controller = new AbortController();",
					`\tconst pending = inspectProfile("default", { cwd: ${JSON.stringify(workspace)}, usage: false, setup: "../invalid" }, controller.signal);`,
					"\tcontroller.abort();",
					"\tlet cancellation: string | undefined;",
					"\ttry {",
					"\t\tawait pending;",
					'\t\tthrow new Error("Inspection resolved after cancellation");',
					"\t} catch (error) {",
					"\t\tcancellation = error instanceof Error ? error.name : typeof error;",
					"\t}",
					`\tconst snapshot = await inspectProfile("default", { cwd: ${JSON.stringify(workspace)}, usage: false }, new AbortController().signal);`,
					'\tconst workerStarts = (await fs.readFile(workerLog, "utf8")).trim().split("\\n").filter(Boolean).length;',
					"\tprocess.stdout.write(JSON.stringify({ cancellation, profile: snapshot.profile, workerStarts }));",
					"}",
				].join("\n"),
			);
			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: ".omp-profile-inspect-cancel",
				NO_COLOR: "1",
			};
			delete childEnv.OMP_PROFILE;
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;
			delete childEnv.PI_CONFIG_FILES;
			delete childEnv.OMP_PROFILE_LAUNCH_CONFIG_FILES;
			const proc = Bun.spawn([process.execPath, probe], {
				cwd: workspace,
				env: childEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({
				cancellation: "AbortError",
				profile: "default",
				workerStarts: 1,
			});
		} finally {
			await removeWithRetries(root);
		}
	}, 60_000);

	it("applies each target profile's provider settings before discovering preview agents", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-inspect-capability-"));
		try {
			const home = path.join(root, "home");
			const workspace = path.join(root, "workspace");
			const configDir = ".omp-profile-inspect-capability";
			const extensionDir = path.join(root, "preview-extension");
			const enabledAgentDir = path.join(home, configDir, "profiles", "enabled", "agent");
			const disabledAgentDir = path.join(home, configDir, "profiles", "disabled", "agent");
			await Promise.all([
				fs.mkdir(workspace, { recursive: true }),
				fs.mkdir(path.join(extensionDir, "agents"), { recursive: true }),
				fs.mkdir(enabledAgentDir, { recursive: true }),
				fs.mkdir(disabledAgentDir, { recursive: true }),
			]);
			await Promise.all([
				Bun.write(
					path.join(extensionDir, "agents", "profile-preview-fixture.md"),
					"---\nname: profile-preview-fixture\ndescription: Profile preview fixture\n---\nInspect this profile.\n",
				),
				Bun.write(path.join(enabledAgentDir, "config.yml"), Bun.YAML.stringify({ extensions: [extensionDir] })),
				Bun.write(
					path.join(disabledAgentDir, "config.yml"),
					Bun.YAML.stringify({ extensions: [extensionDir], disabledProviders: ["omp-plugins"] }),
				),
			]);
			const probe = path.join(root, "inspect-capability-probe.ts");
			const clientUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "client.ts"),
			).href;
			const bootstrapUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "cli", "profile-bootstrap.ts"),
			).href;
			const workerHostUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "utils", "src", "worker-host.ts"),
			).href;
			await Bun.write(
				probe,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					`import { captureProfileLaunchEnvironment } from ${JSON.stringify(bootstrapUrl)};`,
					`import { inspectProfile, PROFILE_INSPECT_WORKER_ARG } from ${JSON.stringify(clientUrl)};`,
					`import { declareWorkerHostEntry } from ${JSON.stringify(workerHostUrl)};`,
					"const args = process.argv.slice(2);",
					"captureProfileLaunchEnvironment(args);",
					"if (args.includes(PROFILE_INSPECT_WORKER_ARG)) {",
					"\tawait runCli(args);",
					"} else {",
					"\tdeclareWorkerHostEntry();",
					`\tconst request = { cwd: ${JSON.stringify(workspace)}, usage: false };`,
					'\tconst enabled = await inspectProfile("enabled", request, new AbortController().signal);',
					'\tconst disabled = await inspectProfile("disabled", request, new AbortController().signal);',
					'\tconst fixture = "profile-preview-fixture";',
					"\tprocess.stdout.write(JSON.stringify({",
					"\t\tenabled: enabled.agents.some(agent => agent.name === fixture),",
					"\t\tdisabled: disabled.agents.some(agent => agent.name === fixture),",
					"\t}));",
					"}",
				].join("\n"),
			);
			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: configDir,
				NO_COLOR: "1",
			};
			delete childEnv.OMP_PROFILE;
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;
			delete childEnv.PI_CONFIG_FILES;
			delete childEnv.OMP_PROFILE_LAUNCH_CONFIG_FILES;
			const proc = Bun.spawn([process.execPath, probe], {
				cwd: workspace,
				env: childEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({ enabled: true, disabled: false });
		} finally {
			await removeWithRetries(root);
		}
	}, 90_000);
});

describe("profile switch launch lifecycle", () => {
	it("does not expose a relaunch context when runCli is imported by an SDK host", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-sdk-context-"));
		try {
			const probe = path.join(root, "probe.ts");
			const clientUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "client.ts"),
			).href;
			await Bun.write(
				probe,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					`import { hasProfileLaunchContext } from ${JSON.stringify(clientUrl)};`,
					'await runCli(["--version"]);',
					'process.stdout.write("\\nCONTEXT=" + hasProfileLaunchContext());',
				].join("\n"),
			);
			const proc = Bun.spawn([process.execPath, probe], {
				cwd: repoRoot,
				env: { ...process.env, NO_COLOR: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("CONTEXT=false");
		} finally {
			await removeWithRetries(root);
		}
	}, 30_000);

	it("keeps one supervisor while zero-exit handoffs launch the requested profile and cwd", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-supervisor-"));
		try {
			const home = path.join(root, "home");
			const configDir = ".omp-profile-supervisor";
			const firstCwd = path.join(root, "first");
			const secondCwd = path.join(root, "second");
			const logFile = path.join(root, "children.jsonl");
			await Promise.all([
				fs.mkdir(path.join(home, configDir, "profiles", "a"), { recursive: true }),
				fs.mkdir(path.join(home, configDir, "profiles", "b"), { recursive: true }),
				fs.mkdir(firstCwd, { recursive: true }),
				fs.mkdir(secondCwd, { recursive: true }),
			]);
			const probe = path.join(root, "supervisor-probe.ts");
			const launchUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "launch.ts"),
			).href;
			const bootstrapUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "cli", "profile-bootstrap.ts"),
			).href;
			const workerHostUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "utils", "src", "worker-host.ts"),
			).href;
			await Bun.write(
				probe,
				[
					'import * as fs from "node:fs/promises";',
					`import { superviseProfileSwitch, PROFILE_SWITCH_SUPERVISED_ENV } from ${JSON.stringify(launchUrl)};`,
					`import { captureProfileLaunchEnvironment } from ${JSON.stringify(bootstrapUrl)};`,
					`import { declareWorkerHostEntry } from ${JSON.stringify(workerHostUrl)};`,
					`const logFile = ${JSON.stringify(logFile)};`,
					`const secondCwd = ${JSON.stringify(secondCwd)};`,
					"const args = process.argv.slice(2);",
					'const profile = args[args.indexOf("--profile") + 1];',
					'if (process.env[PROFILE_SWITCH_SUPERVISED_ENV] === "1") {',
					'\tawait fs.appendFile(logFile, JSON.stringify({ profile, args, cwd: process.cwd(), pid: process.pid, ppid: process.ppid }) + "\\n");',
					'\tif (profile === "b") {',
					"\t\tconst ack = Promise.withResolvers();",
					'\t\tprocess.on("message", message => { if (message?.type === "profile-switch-accepted") ack.resolve(); });',
					'\t\tprocess.send?.({ type: "profile-switch", profile: "a", cwd: secondCwd });',
					"\t\tawait ack.promise;",
					"\t\tprocess.exit(0);",
					"\t}",
					"\tprocess.exit(7);",
					"}",
					"captureProfileLaunchEnvironment();",
					"declareWorkerHostEntry();",
					`const exitCode = await superviseProfileSwitch("b", ${JSON.stringify(firstCwd)});`,
					'process.stdout.write("EXIT=" + exitCode);',
				].join("\n"),
			);
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: configDir,
				NO_COLOR: "1",
			};
			delete env.OMP_PROFILE;
			delete env.PI_PROFILE;
			delete env.PI_CODING_AGENT_DIR;
			delete env.OMP_PROFILE_SWITCH_SUPERVISED;
			const proc = Bun.spawn([process.execPath, probe], {
				cwd: firstCwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("EXIT=7");
			const children = (await Bun.file(logFile).text())
				.trim()
				.split("\n")
				.map(
					line => JSON.parse(line) as { profile: string; args: string[]; cwd: string; pid: number; ppid: number },
				);
			expect(children.map(child => child.profile)).toEqual(["b", "a"]);
			expect(children.map(child => child.args)).toEqual([
				["--profile", "b", "--cwd", firstCwd],
				["--profile", "a", "--cwd", secondCwd],
			]);
			expect(children.map(child => child.cwd)).toEqual([firstCwd, secondCwd]);
			expect(new Set(children.map(child => child.pid)).size).toBe(2);
			expect(new Set(children.map(child => child.ppid)).size).toBe(1);
		} finally {
			await removeWithRetries(root);
		}
	}, 30_000);

	it("restarts the same profile with a validated setup and rejects an invalid follow-up while it stays live", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-setup-supervisor-"));
		try {
			const home = path.join(root, "home");
			const configDir = ".omp-profile-setup-supervisor";
			const profileAgentDir = path.join(home, configDir, "profiles", "a", "agent");
			const defaultAgentDir = path.join(home, configDir, "agent");
			const firstCwd = path.join(root, "first");
			const secondCwd = path.join(root, "second");
			const setupPath = path.join(profileAgentDir, "setups", "focus.yml");
			const logFile = path.join(root, "children.jsonl");
			const rejectionFile = path.join(root, "invalid-setup-rejected.txt");
			await Promise.all([
				fs.mkdir(path.dirname(setupPath), { recursive: true }),
				fs.mkdir(defaultAgentDir, { recursive: true }),
				fs.mkdir(firstCwd, { recursive: true }),
				fs.mkdir(secondCwd, { recursive: true }),
			]);
			await Promise.all([
				Bun.write(
					path.join(profileAgentDir, "config.yml"),
					"modelRoles:\n  default: anthropic/claude-sonnet-4-5\ndefaultThinkingLevel: low\n",
				),
				Bun.write(
					setupPath,
					"modelRoles:\n  default: anthropic/claude-opus-4-6\ntask:\n  disabledAgents: []\n  agentModelOverrides: {}\ndefaultThinkingLevel: high\n",
				),
				Bun.write(
					path.join(defaultAgentDir, "setups", "focus.yml"),
					"modelRoles:\n  default: openai/gpt-5\ntask:\n  disabledAgents: []\n  agentModelOverrides: {}\ndefaultThinkingLevel: minimal\n",
				),
			]);
			const probe = path.join(root, "setup-supervisor-probe.ts");
			const launchUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "launch.ts"),
			).href;
			const inspectWorkerUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "inspect-worker.ts"),
			).href;
			const settingsUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "config", "settings.ts"),
			).href;
			const bootstrapUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "cli", "profile-bootstrap.ts"),
			).href;
			const dirsUrl = url.pathToFileURL(path.join(repoRoot, "packages", "utils", "src", "dirs.ts")).href;
			const workerHostUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "utils", "src", "worker-host.ts"),
			).href;
			await Bun.write(
				probe,
				[
					'import * as fs from "node:fs/promises";',
					`import { Settings } from ${JSON.stringify(settingsUrl)};`,
					`import { runProfileInspectWorker } from ${JSON.stringify(inspectWorkerUrl)};`,
					`import { superviseProfileSwitch, PROFILE_SWITCH_SUPERVISED_ENV } from ${JSON.stringify(launchUrl)};`,
					`import { captureProfileLaunchEnvironment } from ${JSON.stringify(bootstrapUrl)};`,
					`import { setProfile } from ${JSON.stringify(dirsUrl)};`,
					`import { declareWorkerHostEntry } from ${JSON.stringify(workerHostUrl)};`,
					`const logFile = ${JSON.stringify(logFile)};`,
					`const firstCwd = ${JSON.stringify(firstCwd)};`,
					`const secondCwd = ${JSON.stringify(secondCwd)};`,
					`const rejectionFile = ${JSON.stringify(rejectionFile)};`,
					"const args = process.argv.slice(2);",
					'const profileIndex = args.indexOf("--profile");',
					"const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;",
					"captureProfileLaunchEnvironment();",
					"if (profile) setProfile(profile);",
					"declareWorkerHostEntry();",
					'if (args.includes("__omp_worker_profile_inspect")) {',
					"\tawait runProfileInspectWorker();",
					"\tprocess.exit(0);",
					"}",
					'if (process.env[PROFILE_SWITCH_SUPERVISED_ENV] === "1") {',
					'\tconst configIndex = args.indexOf("--config");',
					"\tconst configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;",
					"\tconst settings = await Settings.init({ readOnly: true, cwd: process.cwd(), configFiles: configPath ? [configPath] : undefined });",
					"\tawait fs.appendFile(logFile, JSON.stringify({",
					"\t\tprofile, args, cwd: process.cwd(), pid: process.pid, ppid: process.ppid,",
					"\t\tagentDir: settings.getAgentDir(),",
					'\t\tdefaultModel: settings.getModelRole("default"),',
					'\t\tthinking: settings.get("defaultThinkingLevel"),',
					'\t}) + "\\n");',
					"\tif (process.cwd() === firstCwd) {",
					"\t\tconst ack = Promise.withResolvers();",
					'\t\tprocess.on("message", message => { if (message?.type === "profile-switch-accepted") ack.resolve(); });',
					'\t\tprocess.send?.({ type: "profile-switch", profile: "a", cwd: secondCwd, setup: "focus" });',
					"\t\tawait ack.promise;",
					"\t\tprocess.exit(0);",
					"\t}",
					"\tconst rejected = Promise.withResolvers();",
					'\tprocess.on("message", message => { if (message?.type === "profile-switch-rejected") rejected.resolve(); });',
					'\tprocess.send?.({ type: "profile-switch", profile: "a", cwd: secondCwd, setup: "missing" });',
					"\tawait rejected.promise;",
					'\tawait fs.writeFile(rejectionFile, "still-live");',
					"\tprocess.exit(7);",
					"}",
					`const exitCode = await superviseProfileSwitch("a", ${JSON.stringify(firstCwd)}, "focus");`,
					'process.stdout.write("EXIT=" + exitCode);',
				].join("\n"),
			);
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: configDir,
				NO_COLOR: "1",
			};
			delete env.OMP_PROFILE;
			delete env.PI_PROFILE;
			delete env.PI_CODING_AGENT_DIR;
			delete env.PI_CONFIG_FILES;
			delete env.OMP_PROFILE_SWITCH_SUPERVISED;
			const proc = Bun.spawn([process.execPath, probe], {
				cwd: firstCwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("EXIT=7");
			const children = (await Bun.file(logFile).text())
				.trim()
				.split("\n")
				.map(
					line =>
						JSON.parse(line) as {
							profile: string;
							args: string[];
							cwd: string;
							pid: number;
							ppid: number;
							agentDir: string;
							defaultModel?: string;
							thinking?: string;
						},
				);
			expect(children.map(child => child.profile)).toEqual(["a", "a"]);
			expect(children.map(child => child.args)).toEqual([
				["--profile", "a", "--cwd", firstCwd, "--config", setupPath],
				["--profile", "a", "--cwd", secondCwd, "--config", setupPath],
			]);
			expect(children.map(child => child.cwd)).toEqual([firstCwd, secondCwd]);
			expect(children.map(child => child.agentDir)).toEqual([profileAgentDir, profileAgentDir]);
			expect(children.map(child => child.agentDir)).not.toContain(defaultAgentDir);
			expect(children.map(child => child.defaultModel)).toEqual([
				"anthropic/claude-opus-4-6",
				"anthropic/claude-opus-4-6",
			]);
			expect(children.map(child => child.thinking)).toEqual(["high", "high"]);
			expect(await Bun.file(rejectionFile).text()).toBe("still-live");
			expect(new Set(children.map(child => child.pid)).size).toBe(2);
			expect(new Set(children.map(child => child.ppid)).size).toBe(1);
		} finally {
			await removeWithRetries(root);
		}
	}, 60_000);

	it("keeps launch config overlays as the base while repeated setup switches replace the generated overlay", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-setup-layering-"));
		try {
			const home = path.join(root, "home");
			const configDir = ".omp-profile-setup-layering";
			const profileAgentDir = path.join(home, configDir, "profiles", "a", "agent");
			const cwd = path.join(root, "workspace");
			const contextSetupPath = path.join(profileAgentDir, "setups", "context.yml");
			const modelsOnlySetupPath = path.join(profileAgentDir, "setups", "models-only.yml");
			const baseConfigPath = path.join(root, "base.yml");
			const logFile = path.join(root, "children.jsonl");
			await Promise.all([
				fs.mkdir(path.dirname(contextSetupPath), { recursive: true }),
				fs.mkdir(cwd, { recursive: true }),
			]);
			await Promise.all([
				Bun.write(baseConfigPath, "compaction:\n  enabled: true\n"),
				Bun.write(
					contextSetupPath,
					[
						"$setup:",
						"  version: 1",
						"  enabledGroups: [context]",
						"modelRoles:",
						"  default: anthropic/claude-opus-4-6",
						"compaction:",
						"  enabled: false",
						"",
					].join("\n"),
				),
				Bun.write(
					modelsOnlySetupPath,
					[
						"$setup:",
						"  version: 1",
						"  enabledGroups: []",
						"modelRoles:",
						"  default: anthropic/claude-sonnet-4-5",
						"",
					].join("\n"),
				),
			]);

			const probe = path.join(root, "setup-layering-probe.ts");
			const launchUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "launch.ts"),
			).href;
			const inspectWorkerUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "inspect-worker.ts"),
			).href;
			const settingsUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "config", "settings.ts"),
			).href;
			const bootstrapUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "cli", "profile-bootstrap.ts"),
			).href;
			const dirsUrl = url.pathToFileURL(path.join(repoRoot, "packages", "utils", "src", "dirs.ts")).href;
			const workerHostUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "utils", "src", "worker-host.ts"),
			).href;
			await Bun.write(
				probe,
				[
					'import * as fs from "node:fs/promises";',
					`import { Settings } from ${JSON.stringify(settingsUrl)};`,
					`import { runProfileInspectWorker } from ${JSON.stringify(inspectWorkerUrl)};`,
					`import { superviseProfileSwitch, PROFILE_SWITCH_SUPERVISED_ENV } from ${JSON.stringify(launchUrl)};`,
					`import { captureProfileLaunchEnvironment } from ${JSON.stringify(bootstrapUrl)};`,
					`import { setProfile } from ${JSON.stringify(dirsUrl)};`,
					`import { declareWorkerHostEntry } from ${JSON.stringify(workerHostUrl)};`,
					`const logFile = ${JSON.stringify(logFile)};`,
					`const cwd = ${JSON.stringify(cwd)};`,
					"const args = process.argv.slice(2);",
					'const profileIndex = args.indexOf("--profile");',
					"const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;",
					"captureProfileLaunchEnvironment();",
					"if (profile) setProfile(profile);",
					"declareWorkerHostEntry();",
					'if (args.includes("__omp_worker_profile_inspect")) {',
					"\tawait runProfileInspectWorker();",
					"\tprocess.exit(0);",
					"}",
					'if (process.env[PROFILE_SWITCH_SUPERVISED_ENV] === "1") {',
					"\tconst configFiles = [];",
					'\tfor (let index = 0; index < args.length; index++) { if (args[index] === "--config") configFiles.push(args[++index]); }',
					"\tconst settings = await Settings.init({",
					"\t\treadOnly: true,",
					"\t\tcwd: process.cwd(),",
					"\t\tconfigFiles,",
					"\t});",
					'\tconst prior = await fs.readFile(logFile, "utf8").catch(() => "");',
					'\tconst generation = prior.trim() ? prior.trim().split("\\n").length : 0;',
					"\tawait fs.appendFile(logFile, JSON.stringify({",
					"\t\targs,",
					"\t\tconfigFiles,",
					'\t\tcompactionEnabled: settings.get("compaction.enabled"),',
					'\t}) + "\\n");',
					"\tif (generation < 2) {",
					"\t\tconst ack = Promise.withResolvers();",
					'\t\tprocess.on("message", message => { if (message?.type === "profile-switch-accepted") ack.resolve(); });',
					'\t\tconst setup = generation === 0 ? "models-only" : "context";',
					'\t\tprocess.send?.({ type: "profile-switch", profile: "a", cwd, setup });',
					"\t\tawait ack.promise;",
					"\t\tprocess.exit(0);",
					"\t}",
					"\tprocess.exit(7);",
					"}",
					`const exitCode = await superviseProfileSwitch("a", cwd, "context");`,
					'process.stdout.write("EXIT=" + exitCode);',
				].join("\n"),
			);

			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: configDir,
				NO_COLOR: "1",
			};
			delete env.OMP_PROFILE;
			delete env.PI_PROFILE;
			delete env.PI_CODING_AGENT_DIR;
			delete env.PI_CONFIG_FILES;
			delete env.OMP_PROFILE_SWITCH_SUPERVISED;
			delete env.OMP_PROFILE_LAUNCH_CONFIG_FILES;
			const relativeBaseConfigPath = path.relative(cwd, baseConfigPath);
			const proc = Bun.spawn([process.execPath, probe, "--config", relativeBaseConfigPath], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("EXIT=7");
			const children = (await Bun.file(logFile).text())
				.trim()
				.split("\n")
				.map(
					line =>
						JSON.parse(line) as {
							args: string[];
							configFiles: string[];
							compactionEnabled: boolean;
						},
				);
			expect(children.map(child => child.compactionEnabled)).toEqual([false, true, false]);
			expect(children.map(child => child.configFiles)).toEqual([
				[baseConfigPath, contextSetupPath],
				[baseConfigPath, modelsOnlySetupPath],
				[baseConfigPath, contextSetupPath],
			]);
		} finally {
			await removeWithRetries(root);
		}
	}, 90_000);

	it("does not treat the supervision marker alone as a live handoff channel", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-marker-only-"));
		try {
			const probe = path.join(root, "marker-probe.ts");
			const launchUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "launch.ts"),
			).href;
			await Bun.write(
				probe,
				[
					`import { isSupervisedProfileSwitchChild } from ${JSON.stringify(launchUrl)};`,
					'process.stdout.write("SUPERVISED=" + isSupervisedProfileSwitchChild());',
				].join("\n"),
			);
			const proc = Bun.spawn([process.execPath, probe], {
				cwd: root,
				env: { ...process.env, OMP_PROFILE_SWITCH_SUPERVISED: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toBe("SUPERVISED=false");
		} finally {
			await removeWithRetries(root);
		}
	}, 30_000);

	// Integration boundary: the production five-second IPC deadline is the
	// behavior under test, and the child has an independent process clock.
	it("times out an unacknowledged supervised handoff without exiting the live child", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-supervisor-timeout-"));
		try {
			const probe = path.join(root, "timeout-probe.ts");
			const launchUrl = url.pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "profiles", "launch.ts"),
			).href;
			await Bun.write(
				probe,
				[
					`import { requestSupervisedProfileSwitch } from ${JSON.stringify(launchUrl)};`,
					"try {",
					`\tawait requestSupervisedProfileSwitch("default", ${JSON.stringify(root)});`,
					"} catch (error) { process.stdout.write(error instanceof Error ? error.message : String(error)); }",
					"process.disconnect?.();",
				].join("\n"),
			);
			const proc = Bun.spawn([process.execPath, probe], {
				cwd: root,
				env: { ...process.env, OMP_PROFILE_SWITCH_SUPERVISED: "1" },
				ipc() {},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("did not acknowledge");
		} finally {
			await removeWithRetries(root);
		}
	}, 15_000);
});

describe("interactive profile switch safety", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: TempDir;
	let testJobManager: AsyncJobManager | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir = TempDir.createSync("@omp-profile-switch-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(profileClient, "hasProfileLaunchContext").mockReturnValue(true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode.stop();
		await session.dispose();
		if (testJobManager) await testJobManager.dispose({ timeoutMs: 100 });
		AsyncJobManager.resetForTests();
		AgentRegistry.resetGlobalForTests();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("blocks switching while the active response is streaming", () => {
		session.agent.state.isStreaming = true;
		expect(mode.getProfileSwitchBlockReason()).toContain("active response");
	});

	it("blocks switching while a background job is running", () => {
		testJobManager = new AsyncJobManager({});
		AsyncJobManager.setInstance(testJobManager);
		vi.spyOn(testJobManager, "getRunningJobs").mockReturnValue([{} as never]);
		expect(mode.getProfileSwitchBlockReason()).toContain("background jobs");
	});

	it("blocks switching while an async result is awaiting delivery", () => {
		testJobManager = new AsyncJobManager({});
		AsyncJobManager.setInstance(testJobManager);
		vi.spyOn(testJobManager, "getRunningJobs").mockReturnValue([]);
		vi.spyOn(testJobManager, "hasPendingDeliveries").mockReturnValue(true);
		expect(mode.getProfileSwitchBlockReason()).toContain("pending background results");
	});

	it("blocks switching while a non-main, non-advisor agent is running", () => {
		AgentRegistry.global().register({
			id: "ProfileSwitchWorker",
			displayName: "Profile switch worker",
			kind: "sub",
			session: null,
			status: "running",
		});
		expect(mode.getProfileSwitchBlockReason()).toContain("running subagents");
	});

	it("keeps the current session usable when target configuration preflight fails", async () => {
		const target = (getActiveProfile() ?? "default") === "broken-target" ? "other-target" : "broken-target";
		vi.spyOn(profileClient, "listProfiles").mockResolvedValue([
			{ name: getActiveProfile() ?? "default", active: true },
			{ name: target, active: false },
		]);
		vi.spyOn(profileClient, "inspectProfile").mockRejectedValue(new Error("malformed target settings"));
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		const showError = vi.spyOn(mode, "showError").mockImplementation(() => {});
		const settingsFlush = vi.spyOn(mode.settings, "flush");
		const sessionFlush = vi.spyOn(sessionManager, "flush");
		const dispose = vi.spyOn(session, "dispose");
		const entriesBefore = sessionManager.getEntries().length;

		await mode.requestProfileSwitch(target);

		expect(showError).toHaveBeenCalledWith(`Could not inspect profile ${target}. The current session is unchanged.`);
		expect(settingsFlush).not.toHaveBeenCalled();
		expect(sessionFlush).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(session.isDisposed).toBe(false);
		sessionManager.appendMessage({ role: "user", content: "still usable", timestamp: Date.now() });
		expect(sessionManager.getEntries()).toHaveLength(entriesBefore + 1);
	});

	it("keeps the current session live when a saved setup in the active profile fails preflight", async () => {
		const active = getActiveProfile() ?? "default";
		vi.spyOn(profileClient, "listProfiles").mockResolvedValue([{ name: active, active: true }]);
		const inspect = vi.spyOn(profileClient, "inspectProfile").mockRejectedValue(new Error("unsafe setup"));
		const confirm = vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		const showError = vi.spyOn(mode, "showError").mockImplementation(() => {});
		const settingsFlush = vi.spyOn(mode.settings, "flush");
		const sessionFlush = vi.spyOn(sessionManager, "flush");
		const dispose = vi.spyOn(session, "dispose");

		await mode.requestProfileSwitch(active, "focus");

		expect(inspect).toHaveBeenCalledWith(
			active,
			{ cwd: tempDir.path(), usage: false, setup: "focus" },
			expect.any(AbortSignal),
		);
		expect(confirm).toHaveBeenCalledWith(
			"Load setup focus?",
			"This saves the current session and starts a fresh session using the current accounts. Current session-only overrides are not carried.",
		);
		expect(showError).toHaveBeenCalledWith("Could not load setup focus. The current session is unchanged.");
		expect(settingsFlush).not.toHaveBeenCalled();
		expect(sessionFlush).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(session.isDisposed).toBe(false);
	});

	it("persists a nonempty draft and prints the old-profile resume command before a successful handoff", async () => {
		const target = (getActiveProfile() ?? "default") === "handoff-target" ? "other-target" : "handoff-target";
		const snapshot = {
			profile: target,
			generatedAt: Date.now(),
			agentDir: path.join(tempDir.path(), "target-agent"),
			credentialSources: {},
			roles: [],
			agents: [],
			memory: { backend: "off", storageLabel: "Profile-local default storage" },
			settings: [],
			warnings: [],
		};
		vi.spyOn(profileClient, "listProfiles").mockResolvedValue([
			{ name: getActiveProfile() ?? "default", active: true },
			{ name: target, active: false },
		]);
		vi.spyOn(profileClient, "inspectProfile").mockResolvedValue(snapshot);
		vi.spyOn(profileLaunch, "isSupervisedProfileSwitchChild").mockReturnValue(true);
		vi.spyOn(profileLaunch, "requestSupervisedProfileSwitch").mockResolvedValue();
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await mode.init({ suppressWelcomeIntro: true });
		mode.editor.setText("unfinished profile handoff draft");
		const oldSessionId = sessionManager.getSessionId();

		await mode.requestProfileSwitch(target);

		expect(await sessionManager.consumeDraft()).toBe("unfinished profile handoff draft");
		const output = stderr.mock.calls.map(call => String(call[0] ?? "")).join("");
		expect(output).toContain(`Resume this session with ${resumeCommand(oldSessionId)}`);
		expect(session.isDisposed).toBe(true);
	});
});
