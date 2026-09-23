import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getAgentDbPath, removeWithRetries, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import {
	applyProfileModelPerformance,
	buildProfileSnapshot,
	sanitizeCredentialSourceLabel,
} from "../src/profiles/snapshot";
import type { ProfileInspectResponse, ProfileRoleRow } from "../src/profiles/types";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
const PROFILE_BOOTSTRAP_URL = url.pathToFileURL(
	path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli", "profile-bootstrap.ts"),
).href;
const DIRS_URL = url.pathToFileURL(path.join(REPO_ROOT, "packages", "utils", "src", "dirs.ts")).href;
const ENV_MODULE_PATH = path.join(REPO_ROOT, "packages", "utils", "src", "env.ts");

describe("profile snapshots", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@omp-profile-snapshot-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		setAgentDir(agentDir);
		setProjectDir(projectDir);
		delete process.env.PI_CONFIG_FILES;
		delete Bun.env.PI_CONFIG_FILES;
	});

	afterEach(async () => {
		restoreSettingsTestState(state);
		state = undefined;
		await tempDir.remove();
	});

	it("loads global and project settings through the read-only singleton without creating storage", async () => {
		const globalPath = path.join(agentDir, "config.yml");
		const projectPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(
			globalPath,
			YAML.stringify({ compaction: { enabled: false }, modelRoles: { default: "anthropic/global" } }, null, 2),
		);
		await Bun.write(
			projectPath,
			YAML.stringify({ compaction: { enabled: true }, modelRoles: { default: "anthropic/project" } }, null, 2),
		);
		const before = fs.readdirSync(tempDir.path(), { recursive: true }).map(String).sort();

		const settings = await Settings.init({ readOnly: true, cwd: projectDir, agentDir });

		expect(settings.get("compaction.enabled")).toBe(true);
		expect(settings.getModelRole("default")).toBe("anthropic/project");
		expect(await Bun.file(getAgentDbPath(agentDir)).exists()).toBe(false);
		expect(fs.readdirSync(tempDir.path(), { recursive: true }).map(String).sort()).toEqual(before);
	});

	it("surfaces malformed project YAML without quarantining or rewriting it", async () => {
		const projectPath = path.join(projectDir, ".omp", "config.yml");
		const malformed = 'modelRoles:\n  default: "unterminated\n';
		await Bun.write(projectPath, malformed);

		await expect(Settings.init({ readOnly: true, cwd: projectDir, agentDir })).rejects.toThrow(
			"Settings config is invalid",
		);

		expect(await Bun.file(projectPath).text()).toBe(malformed);
		expect(fs.readdirSync(path.dirname(projectPath)).filter(name => name.startsWith("config.yml.broken-"))).toEqual(
			[],
		);
		expect(await Bun.file(getAgentDbPath(agentDir)).exists()).toBe(false);
	});

	it("reports legacy config sources without migrating or opening them", async () => {
		const legacyJson = path.join(agentDir, "settings.json");
		const legacyDb = getAgentDbPath(agentDir);
		await Bun.write(legacyJson, JSON.stringify({ modelRoles: { default: "secret/legacy-model" } }));
		await Bun.write(legacyDb, "legacy database bytes");
		const settings = await Settings.init({ readOnly: true, cwd: projectDir, agentDir });
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		try {
			const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
			const snapshot = await buildProfileSnapshot({
				profile: "legacy",
				cwd: projectDir,
				settings,
				modelRegistry,
				authStorage,
			});
			expect(settings.getModelRole("default")).toBeUndefined();
			expect(snapshot.warnings).toContain(
				"Legacy configuration: launch this profile once to initialize its saved settings",
			);
			expect(snapshot.warnings).toContain("No native YAML; startup may migrate legacy database settings");
			expect(await Bun.file(legacyJson).text()).toContain("secret/legacy-model");
			expect(await Bun.file(legacyDb).text()).toBe("legacy database bytes");
		} finally {
			authStorage.close();
		}
	});

	it("inspects profile B from the original shell environment after profile A dotenv initialization", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-profile-inspect-env-"));
		try {
			const home = path.join(root, "home");
			const configDir = ".omp-profile-inspect-env";
			const profileRoot = path.join(home, configDir, "profiles");
			const aAgentDir = path.join(profileRoot, "a", "agent");
			const bAgentDir = path.join(profileRoot, "b", "agent");
			const workspace = path.join(root, "workspace");
			await fs.promises.mkdir(aAgentDir, { recursive: true });
			await fs.promises.mkdir(bAgentDir, { recursive: true });
			await fs.promises.mkdir(workspace, { recursive: true });
			await Bun.write(
				path.join(aAgentDir, ".env"),
				[
					"OPENAI_API_KEY=a-profile-fake-key",
					"PI_PLAN_MODEL=openai/a-dotenv-model",
					"PI_SMOL_MODEL=openai/a-dotenv-model",
				].join("\n"),
			);
			await Bun.write(
				path.join(bAgentDir, ".env"),
				[
					"ANTHROPIC_API_KEY=b-profile-fake-key",
					"PI_PLAN_MODEL=anthropic/b-dotenv-model",
					"PI_SMOL_MODEL=anthropic/b-should-lose-to-shell",
				].join("\n"),
			);
			await Bun.write(
				path.join(bAgentDir, "config.yml"),
				YAML.stringify(
					{
						modelRoles: {
							default: "anthropic/claude-sonnet-4-5",
							review: "openai/gpt-5",
						},
					},
					null,
					2,
				),
			);
			const probe = path.join(root, "probe.ts");
			await Bun.write(
				probe,
				[
					`import { captureProfileLaunchEnvironment, getProfileLaunchEnvironment } from ${JSON.stringify(PROFILE_BOOTSTRAP_URL)};`,
					`import { setProfile } from ${JSON.stringify(DIRS_URL)};`,
					"captureProfileLaunchEnvironment();",
					'setProfile("a");',
					`require(${JSON.stringify(ENV_MODULE_PATH)});`,
					'const aLoaded = Bun.env.OPENAI_API_KEY === "a-profile-fake-key";',
					'const aPlanLoaded = Bun.env.PI_PLAN_MODEL === "openai/a-dotenv-model";',
					"const baseline = getProfileLaunchEnvironment();",
					'if (!baseline) throw new Error("missing captured launch environment");',
					`const child = Bun.spawn([process.execPath, ${JSON.stringify(CLI_ENTRY)}, "--profile", "b", "__omp_worker_profile_inspect"], {`,
					`  cwd: ${JSON.stringify(workspace)},`,
					"  env: baseline,",
					'  stdin: "pipe",',
					'  stdout: "pipe",',
					'  stderr: "pipe",',
					"});",
					`child.stdin.write(JSON.stringify({ cwd: ${JSON.stringify(workspace)}, usage: false }));`,
					"child.stdin.end();",
					"const [workerOut, workerErr, workerExit] = await Promise.all([",
					"  new Response(child.stdout).text(),",
					"  new Response(child.stderr).text(),",
					"  child.exited,",
					"]);",
					"process.stdout.write(JSON.stringify({",
					"  aLoaded,",
					"  aPlanLoaded,",
					"  workerExit,",
					"  workerErr,",
					"  worker: JSON.parse(workerOut),",
					"}));",
				].join("\n"),
			);
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: configDir,
				PI_SMOL_MODEL: "anthropic/original-shell-model",
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
			};
			for (const name of [
				"OMP_PROFILE",
				"PI_PROFILE",
				"PI_CODING_AGENT_DIR",
				"OPENAI_API_KEY",
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_OAUTH_TOKEN",
				"ANTHROPIC_FOUNDRY_API_KEY",
				"OMP_AUTH_BROKER_URL",
				"OMP_AUTH_BROKER_TOKEN",
				"PI_CONFIG_FILES",
				"OMP_SMOL_MODEL",
				"OMP_SLOW_MODEL",
				"OMP_PLAN_MODEL",
				"PI_SLOW_MODEL",
				"PI_PLAN_MODEL",
			]) {
				delete env[name];
			}
			const proc = Bun.spawn([process.execPath, probe], {
				cwd: REPO_ROOT,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const result = JSON.parse(stdout) as {
				aLoaded: boolean;
				aPlanLoaded: boolean;
				workerExit: number;
				workerErr: string;
				worker: ProfileInspectResponse;
			};
			expect(result.aLoaded).toBe(true);
			expect(result.aPlanLoaded).toBe(true);
			expect(result.workerExit, result.workerErr).toBe(0);
			if (!result.worker.ok) throw new Error(result.worker.message);
			const snapshot = result.worker.snapshot;
			expect(snapshot.profile).toBe("b");
			expect(snapshot.roles.find(row => row.role === "plan")?.selector).toBe("anthropic/b-dotenv-model");
			expect(snapshot.roles.find(row => row.role === "smol")?.selector).toBe("anthropic/original-shell-model");
			expect(snapshot.credentialSources.anthropic).toContain("env");
			expect(snapshot.credentialSources.openai).toBe("No authenticated account");
			const serialized = JSON.stringify(snapshot);
			expect(serialized).not.toContain("a-profile-fake-key");
			expect(serialized).not.toContain("a-dotenv-model");
			expect(serialized).not.toContain("b-profile-fake-key");
		} finally {
			await removeWithRetries(root);
		}
	}, 60_000);

	it("projects only meaningful finite nonnegative token prices", async () => {
		const settings = await Settings.init({ readOnly: true, cwd: projectDir, agentDir });
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		try {
			const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
			const baseModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!baseModel) throw new Error("Expected the pricing fixture in the bundled catalog");
			const costs = [
				{ input: 0, output: 15, cacheRead: 0, cacheWrite: 0 },
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				{ input: -1, output: 15, cacheRead: 0, cacheWrite: 0 },
				{ input: 3, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 },
			];
			const snapshots = await Promise.all(
				costs.map(cost =>
					buildProfileSnapshot({
						profile: "pricing",
						cwd: projectDir,
						settings,
						modelRegistry,
						authStorage,
						currentModel: { ...baseModel, cost },
					}),
				),
			);
			expect(snapshots[0]?.roles.find(row => row.role === "default")?.cost).toEqual(costs[0]);
			for (const snapshot of snapshots.slice(1)) {
				expect(snapshot.roles.find(row => row.role === "default")?.cost).toBeUndefined();
			}
		} finally {
			authStorage.close();
		}
	});

	it("replaces stale measured performance only with valid keyed samples", () => {
		const roles: ProfileRoleRow[] = [
			{
				role: "default",
				provider: "anthropic",
				modelId: "measured",
				tps: 42,
				perf: { samples: 1, tps: 1, ttftMs: null },
				automatic: false,
			},
			{
				role: "smol",
				provider: "anthropic",
				modelId: "invalid",
				tps: 55,
				perf: { samples: 1, tps: 2, ttftMs: 100 },
				automatic: false,
			},
			{
				role: "review",
				provider: "anthropic",
				modelId: "missing",
				perf: { samples: 1, tps: 3, ttftMs: 200 },
				automatic: false,
			},
		];

		applyProfileModelPerformance(
			roles,
			new Map([
				["anthropic/measured", { samples: 4, tps: 120, ttftMs: 800 }],
				["anthropic/invalid", { samples: 1, tps: Number.NaN, ttftMs: -1 }],
			]),
		);

		expect(roles[0]).toMatchObject({
			tps: 42,
			perf: { samples: 4, tps: 120, ttftMs: 800 },
		});
		expect(roles[1]).toMatchObject({ tps: 55 });
		expect(roles[1]?.perf).toBeUndefined();
		expect(roles[2]?.perf).toBeUndefined();
	});

	it("projects non-chat roles and a prototype-named project agent from canonical pools", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify(
				{
					modelRoles: {
						image: "openai/chatgpt-image-latest",
						speech: "local/kokoro",
						dictation: "local/whisper-base",
						tiny: "local/falcon-h1-90m",
					},
				},
				null,
				2,
			),
		);
		const agentsDir = path.join(projectDir, ".omp", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		await Bun.write(
			path.join(agentsDir, "toString.md"),
			[
				"---",
				"name: toString",
				"description: Prototype-named fixture",
				"model: anthropic/claude-sonnet-4-5",
				"---",
				"Fixture prompt.",
			].join("\n"),
		);
		const settings = await Settings.init({ readOnly: true, cwd: projectDir, agentDir });
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		authStorage.setRuntimeApiKey("openai", "fixture-key");
		authStorage.setRuntimeApiKey("anthropic", "fixture-key");
		try {
			const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
			const currentModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!currentModel) throw new Error("Expected bundled chat model fixture");

			const snapshot = await buildProfileSnapshot({
				profile: "role-kinds",
				cwd: projectDir,
				settings,
				modelRegistry,
				authStorage,
				currentModel,
			});

			expect(snapshot.roles.find(row => row.role === "default")).toMatchObject({
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(snapshot.roles.find(row => row.role === "image")).toMatchObject({
				provider: "openai",
				modelId: "chatgpt-image-latest",
			});
			expect(snapshot.roles.find(row => row.role === "speech")).toMatchObject({
				provider: "local",
				modelId: "kokoro",
			});
			expect(snapshot.roles.find(row => row.role === "dictation")).toMatchObject({
				provider: "local",
				modelId: "whisper-base",
			});
			expect(snapshot.roles.find(row => row.role === "tiny")).toMatchObject({
				provider: "local",
				modelId: "falcon-h1-90m",
			});
			expect(snapshot.agents.find(row => row.name === "toString")).toMatchObject({
				selector: "anthropic/claude-sonnet-4-5",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
		} finally {
			authStorage.close();
		}
	});

	it("projects selectors, agents, memory, settings, and credential labels without secrets", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify(
				{
					auth: { broker: { url: "https://broker.example.test/path?token=url-secret", token: "broker-secret" } },
					modelRoles: {
						default: "anthropic/claude-sonnet-4-5:high",
						smol: "anthropic/claude-sonnet-4-5",
						review: "extension-provider/private-extension-model",
					},
					task: {
						disabledAgents: ["fixture"],
						agentModelOverrides: { fixture: "anthropic/claude-sonnet-4-5" },
					},
					memory: { backend: "hindsight" },
					hindsight: {
						apiToken: "hindsight-secret",
						bankId: "shared-bank",
						scoping: "global",
					},
					compaction: { enabled: false },
				},
				null,
				2,
			),
		);
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await Bun.write(
			path.join(agentsDir, "fixture.md"),
			[
				"---",
				"name: fixture",
				"description: Fixture agent",
				"model: anthropic/claude-sonnet-4-5",
				"---",
				"Fixture prompt.",
			].join("\n"),
		);
		const settings = await Settings.init({ readOnly: true, cwd: projectDir, agentDir });
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			sourceLabel: "broker https://user:url-password@broker.example.test/path?token=source-secret",
		});
		try {
			await authStorage.set("anthropic", {
				type: "oauth",
				access: "access-secret",
				refresh: "refresh-secret",
				expires: Date.now() + 60_000,
				email: "person@example.test",
				accountId: "account-secret-id",
				orgId: "organization-secret-id",
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
			const currentModel = modelRegistry.find("anthropic", "claude-opus-4-5");
			if (!currentModel) throw new Error("Expected the active-model fixture in the bundled catalog");
			const inactiveSnapshot = await buildProfileSnapshot({
				profile: "fixture-profile",
				cwd: projectDir,
				settings,
				modelRegistry,
				authStorage,
			});
			expect(inactiveSnapshot.roles.find(row => row.role === "default")).toMatchObject({
				selector: "anthropic/claude-sonnet-4-5:high",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
				thinkingLevel: "high",
				automatic: false,
			});

			const snapshot = await buildProfileSnapshot({
				profile: "fixture-profile",
				cwd: projectDir,
				settings,
				modelRegistry,
				authStorage,
				currentModel,
				currentThinkingLevel: AUTO_THINKING,
			});

			const defaultRole = snapshot.roles.find(row => row.role === "default");
			expect(defaultRole).toMatchObject({
				selector: "anthropic/claude-sonnet-4-5:high",
				provider: "anthropic",
				modelId: "claude-opus-4-5",
				automatic: false,
			});
			expect(defaultRole?.thinkingLevel).toBe(AUTO_THINKING);
			expect(snapshot.roles.find(row => row.role === "smol")).toMatchObject({
				selector: "anthropic/claude-sonnet-4-5",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
				automatic: false,
			});
			const unresolvedRole = snapshot.roles.find(row => row.role === "review");
			expect(unresolvedRole?.warning).toContain("offline preview");
			expect(snapshot.agents.find(row => row.name === "fixture")).toMatchObject({
				enabled: false,
				selector: "anthropic/claude-sonnet-4-5",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(snapshot.memory).toEqual({
				backend: "hindsight",
				scope: "global",
				storageLabel: "Custom storage — may be shared · Bank shared-bank",
			});
			expect(snapshot.settings.find(row => row.path === "compaction.enabled")).toMatchObject({
				value: false,
				hidden: false,
				configured: true,
			});
			expect(sanitizeCredentialSourceLabel("broker https://[broken", authStorage)).toBe("broker [endpoint hidden]");
			expect(sanitizeCredentialSourceLabel("local store · oauth #2 (account-secret-id)", authStorage)).not.toContain(
				"account-secret-id",
			);
			expect(snapshot.settings.find(row => row.path === "auth.broker.token")).toMatchObject({
				value: null,
				hidden: true,
				configured: true,
			});
			expect(snapshot.credentialSources.anthropic).toContain("broker.example.test");
			expect(snapshot.credentialSources.anthropic).not.toContain("https://");
			expect(snapshot.credentialSources.anthropic).not.toContain("person@example.test");
			const serialized = JSON.stringify(snapshot);
			for (const secret of [
				"broker-secret",
				"url-secret",
				"source-secret",
				"url-password",
				"hindsight-secret",
				"access-secret",
				"refresh-secret",
			]) {
				expect(serialized).not.toContain(secret);
			}
		} finally {
			authStorage.close();
		}
	});
});
