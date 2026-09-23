import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { YAML } from "bun";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import {
	createProfileDraft,
	deleteSavedSetup,
	getProfileConfigPath,
	getSetupModelRoles,
	listSavedSetups,
	loadSavedSetup,
	normalizeSetupName,
	renameSavedSetup,
	saveModelRolesSetup,
	saveProfileDraft,
	setProfileConfigPath,
	saveSetup,
	setProfileDraftGroup,
	updateSavedSetupRole,
} from "../src/profiles/setups";
import { serializeProfile } from "../src/profiles/profile-sharing";
import { buildProfileSnapshot } from "../src/profiles/snapshot";
import type { ProfileSettingRow, ProfileSnapshot } from "../src/profiles/types";

function setting(
	path: ProfileSettingRow["path"],
	value: ProfileSettingRow["value"],
	hidden = false,
): ProfileSettingRow {
	return { path, label: path, value, hidden, configured: true };
}

function snapshot(agentDir: string, scalarSettings: ProfileSettingRow[] = []): ProfileSnapshot {
	return {
		profile: "default",
		generatedAt: Date.now(),
		agentDir,
		credentialSources: { anthropic: "oauth:user@example.com" },
		roles: [
			{
				role: "default",
				selector: "anthropic/stale-configured:high",
				provider: "openai",
				modelId: "gpt-5.4",
				thinkingLevel: ThinkingLevel.Low,
				automatic: false,
			},
			{ role: "smol", selector: "fast/one", automatic: false },
			{ role: "slow", automatic: true },
		],
		agents: [
			{ name: "scout", enabled: true, source: "builtin", selector: "fast/one" },
			{ name: "reviewer", enabled: true, source: "builtin" },
		],
		memory: { backend: "hindsight", scope: "per-project", storageLabel: "configured" },
		settings: scalarSettings,
		warnings: [],
	};
}

describe("saved profile setups", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-profile-setups-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("creates a canonical models-only profile without inheriting task or scalar settings", async () => {
		const basePath = path.join(agentDir, "config.yml");
		const originalBase = YAML.stringify(
			{
				auth: { broker: { token: "never-copy-this-token", url: "https://broker.invalid" } },
				modelRoles: { default: "anthropic/stale-configured:high", smol: "fast/one" },
				task: {
					disabledAgents: ["sonic"],
					agentModelOverrides: { scout: ["fast/one", "fast/two"] },
				},
				mnemopi: { dbPath: "C:/private/memory.db" },
			},
			null,
			2,
		);
		await Bun.write(basePath, originalBase);
		const active = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		await saveSetup("focused", {
			settings: active,
			snapshot: snapshot(agentDir, [
				setting("defaultThinkingLevel", ThinkingLevel.Medium),
				setting("display.showTokenUsage", true),
			]),
		});
		expect(await Bun.file(basePath).text()).toBe(originalBase);

		const saved = await loadSavedSetup("focused", agentDir);
		expect(saved.metadata).toEqual({ version: 1, enabledGroups: [] });
		const raw = YAML.parse(await Bun.file(saved.path).text()) as Record<string, unknown>;
		expect(Object.keys(raw)).toEqual(["$setup", "modelRoles"]);
		const rawText = await Bun.file(saved.path).text();
		expect(rawText).not.toContain("never-copy-this-token");
		expect(rawText).not.toContain("broker.invalid");
		expect(rawText).not.toContain("disabledAgents");
		expect(rawText).not.toContain("defaultThinkingLevel");

		const loaded = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [saved.path] });
		expect(loaded.getModelRole("default")).toBe("openai/gpt-5.4:low");
		expect(loaded.getModelRole("smol")).toBe("fast/one");
		expect(loaded.get("task.disabledAgents")).toEqual(["sonic"]);
		expect(loaded.get("task.agentModelOverrides").scout).toEqual(["fast/one", "fast/two"]);
	});

	it("captures enabled groups exactly and deletes their owned values when disabled", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				modelRoles: { default: "openai/gpt-5.4", smol: "@default:low" },
				compaction: { enabled: false },
				task: {
					disabledAgents: ["sonic"],
					agentModelOverrides: { reviewer: ["@default:low", "openai/gpt-5.4"] },
				},
				retry: { fallbackChains: { default: ["openai/gpt-5.4-mini", "@smol"] } },
			}),
		);
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		let draft = createProfileDraft(settings, snapshot(agentDir));
		draft = setProfileDraftGroup(draft, "context", true, settings);
		draft = setProfileDraftGroup(draft, "tasks", true, settings);
		draft = setProfileDraftGroup(draft, "model", true, settings);
		expect(draft.metadata.enabledGroups).toEqual(["model", "context", "tasks"]);
		expect(getProfileConfigPath(draft.config, "compaction.enabled")).toEqual({ present: true, value: false });
		expect(getProfileConfigPath(draft.config, "task.disabledAgents")).toEqual({
			present: true,
			value: ["sonic"],
		});
		expect(getProfileConfigPath(draft.config, "task.agentModelOverrides")).toEqual({
			present: true,
			value: { reviewer: ["@default:low", "openai/gpt-5.4"] },
		});
		expect(getProfileConfigPath(draft.config, "retry.fallbackChains")).toEqual({
			present: true,
			value: { default: ["openai/gpt-5.4-mini", "@smol"] },
		});

		draft = setProfileDraftGroup(draft, "tasks", false, settings);
		expect(draft.metadata.enabledGroups).toEqual(["model", "context"]);
		expect(getProfileConfigPath(draft.config, "task.disabledAgents").present).toBe(false);
		expect(getProfileConfigPath(draft.config, "task.agentModelOverrides").present).toBe(false);
		await saveProfileDraft("grouped", draft, { agentDir });
		const saved = await loadSavedSetup("grouped", agentDir);
		expect(saved.metadata).toEqual({ version: 1, enabledGroups: ["model", "context"] });
		expect(getProfileConfigPath(saved.config, "task.disabledAgents").present).toBe(false);
	});

	it("excludes automatic credit spending when capturing and exporting Providers settings", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				modelRoles: { default: "openai/gpt-5.4" },
				codexResets: {
					autoRedeem: "yes",
					minBlockedMinutes: 240,
					keepCredits: 2,
					salvageHorizonHours: 8,
				},
				provider: { appendOnlyContext: "on" },
			}),
		);
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const draft = setProfileDraftGroup(createProfileDraft(settings, snapshot(agentDir)), "providers", true, settings);
		const exported = YAML.parse(serializeProfile(draft)) as { settings: Record<string, unknown> };

		expect(draft.metadata.enabledGroups).toEqual(["providers"]);
		expect(getProfileConfigPath(exported.settings, "provider.appendOnlyContext")).toEqual({
			present: true,
			value: "on",
		});
		expect(getProfileConfigPath(exported.settings, "codexResets").present).toBe(false);
	});

	it("excludes Claude saved-reset spending policy from saved setups and profile exports", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				modelRoles: { default: "anthropic/claude-sonnet-4-6" },
				claudeResets: {
					autoRedeem: "yes",
					minBlockedMinutes: 240,
					keepCredits: 2,
					salvageHorizonHours: 8,
				},
				provider: { appendOnlyContext: "on" },
			}),
		);
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const draft = setProfileDraftGroup(createProfileDraft(settings, snapshot(agentDir)), "providers", true, settings);
		await saveProfileDraft("claude-local-policy", draft, { agentDir });
		const saved = await loadSavedSetup("claude-local-policy", agentDir);
		const exported = YAML.parse(serializeProfile(draft)) as { settings: Record<string, unknown> };

		expect(getProfileConfigPath(draft.config, "claudeResets").present).toBe(false);
		expect(getProfileConfigPath(saved.config, "claudeResets").present).toBe(false);
		expect(getProfileConfigPath(exported.settings, "claudeResets").present).toBe(false);
		expect(getProfileConfigPath(exported.settings, "provider.appendOnlyContext")).toEqual({
			present: true,
			value: "on",
		});
	});

	it("continues loading scalar settings from existing setup files", async () => {
		const setupsDir = path.join(agentDir, "setups");
		await fs.mkdir(setupsDir, { recursive: true });
		await Bun.write(
			path.join(setupsDir, "legacy.yml"),
			YAML.stringify(
				{
					modelRoles: { default: "legacy/default" },
					task: { disabledAgents: ["reviewer"], agentModelOverrides: { scout: "legacy/scout" } },
					defaultThinkingLevel: ThinkingLevel.Medium,
					display: { showTurnTime: false },
				},
				null,
				2,
			),
		);

		const saved = await loadSavedSetup("legacy", agentDir);
		expect(saved.metadata).toEqual({ version: 1, enabledGroups: ["model", "appearance", "tasks"] });
		const loaded = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [saved.path] });
		expect(loaded.getModelRole("default")).toBe("legacy/default");
		expect(loaded.get("task.disabledAgents")).toEqual(["reviewer"]);
		expect(loaded.get("task.agentModelOverrides").scout).toBe("legacy/scout");
		expect(loaded.get("defaultThinkingLevel")).toBe(ThinkingLevel.Medium);
		expect(loaded.get("display.showTurnTime")).toBe(false);
	});

	it("loads legacy boolean Find setup values and rewrites them as canonical modes", async () => {
		const setupsDir = path.join(agentDir, "setups");
		await fs.mkdir(setupsDir, { recursive: true });
		const filePath = path.join(setupsDir, "legacy-find.yml");
		await Bun.write(
			filePath,
			YAML.stringify({
				$setup: { version: 1, enabledGroups: ["tools"] },
				modelRoles: { default: "openai/gpt-5.4" },
				find: { enabled: false },
			}),
		);

		const saved = await loadSavedSetup("legacy-find", agentDir);
		expect(getProfileConfigPath(saved.config, "find.enabled")).toEqual({ present: true, value: "off" });
		const loaded = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [saved.path] });
		expect(loaded.get("find.enabled")).toBe("off");

		await saveProfileDraft(
			"legacy-find",
			{ metadata: saved.metadata, config: saved.config },
			{ agentDir, overwrite: true },
		);
		expect(YAML.parse(await Bun.file(filePath).text())).toEqual({
			$setup: { version: 1, enabledGroups: ["tools"] },
			modelRoles: { default: "openai/gpt-5.4" },
			find: { enabled: "off" },
		});
	});

	it("canonicalizes legacy local-only values only when overwrite preserves them exactly", async () => {
		const setupsDir = path.join(agentDir, "setups");
		await fs.mkdir(setupsDir, { recursive: true });
		const filePath = path.join(setupsDir, "legacy-tier.yml");
		await Bun.write(
			filePath,
			YAML.stringify({ modelRoles: { default: "openai/gpt-5.4" }, tier: { openai: "priority" } }),
		);

		const legacy = await loadSavedSetup("legacy-tier", agentDir);
		expect(legacy.metadata).toEqual({ version: 1, enabledGroups: ["model"] });
		await saveProfileDraft(
			"legacy-tier",
			{ metadata: legacy.metadata, config: legacy.config },
			{ agentDir, overwrite: true },
		);
		const preserved = {
			$setup: { version: 1, enabledGroups: ["model"] },
			modelRoles: { default: "openai/gpt-5.4" },
			tier: { openai: "priority" },
		};
		expect(YAML.parse(await Bun.file(filePath).text())).toEqual(preserved);

		setProfileConfigPath(legacy.config, "tier.openai", "flex");
		await expect(
			saveProfileDraft(
				"legacy-tier",
				{ metadata: legacy.metadata, config: legacy.config },
				{ agentDir, overwrite: true },
			),
		).rejects.toThrow('Saved setup cannot introduce local-only setting "tier.openai"');
		await expect(
			saveProfileDraft("legacy-tier-copy", { metadata: legacy.metadata, config: legacy.config }, { agentDir }),
		).rejects.toThrow('Saved setup cannot introduce local-only setting "tier.openai"');
		expect(YAML.parse(await Bun.file(filePath).text())).toEqual(preserved);
	});

	it("preserves legacy Codex reset spending policy through load and an unrelated role save", async () => {
		const setupsDir = path.join(agentDir, "setups");
		await fs.mkdir(setupsDir, { recursive: true });
		const filePath = path.join(setupsDir, "legacy-codex-resets.yml");
		const codexResets = {
			autoRedeem: "yes",
			minBlockedMinutes: 240,
			keepCredits: 2,
			salvageHorizonHours: 8,
		};
		await Bun.write(filePath, YAML.stringify({ modelRoles: { default: "openai/gpt-5.4" }, codexResets }));

		const legacy = await loadSavedSetup("legacy-codex-resets", agentDir);
		expect(legacy.metadata).toEqual({ version: 1, enabledGroups: ["providers"] });
		expect(getProfileConfigPath(legacy.config, "codexResets.autoRedeem")).toEqual({
			present: true,
			value: "yes",
		});
		const loaded = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [legacy.path] });
		expect(loaded.get("codexResets.autoRedeem")).toBe("yes");
		expect(loaded.get("codexResets.minBlockedMinutes")).toBe(240);
		expect(loaded.get("codexResets.keepCredits")).toBe(2);
		expect(loaded.get("codexResets.salvageHorizonHours")).toBe(8);

		await updateSavedSetupRole("legacy-codex-resets", "default", "openai/gpt-5.4-mini", agentDir);
		expect(YAML.parse(await Bun.file(filePath).text())).toEqual({
			$setup: { version: 1, enabledGroups: ["providers"] },
			modelRoles: { default: "openai/gpt-5.4-mini" },
			codexResets,
		});
	});

	it("round-trips the live model and configured thinking from a real snapshot", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify(
				{
					modelRoles: { default: "anthropic/claude-sonnet-4-5:high" },
					defaultThinkingLevel: "low",
				},
				null,
				2,
			),
		);
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		try {
			await authStorage.set("anthropic", {
				type: "oauth",
				access: "fixture-access",
				refresh: "fixture-refresh",
				expires: Date.now() + 60_000,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
			const currentModel = modelRegistry.find("anthropic", "claude-opus-4-5");
			if (!currentModel) throw new Error("Expected the runtime-model fixture in the bundled catalog");

			const currentSnapshot = await buildProfileSnapshot({
				profile: "default",
				cwd: projectDir,
				settings,
				modelRegistry,
				authStorage,
				currentModel,
				currentThinkingLevel: ThinkingLevel.High,
			});
			await saveSetup("runtime-selection", { settings, snapshot: currentSnapshot });

			const saved = await loadSavedSetup("runtime-selection", agentDir);
			const loaded = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [saved.path] });
			expect(loaded.getModelRole("default")).toBe("anthropic/claude-opus-4-5:high");
			expect(loaded.get("defaultThinkingLevel")).toBe(ThinkingLevel.Low);

			const autoSnapshot = await buildProfileSnapshot({
				profile: "default",
				cwd: projectDir,
				settings,
				modelRegistry,
				authStorage,
				currentModel,
				currentThinkingLevel: AUTO_THINKING,
			});
			await saveSetup("runtime-selection", { settings, snapshot: autoSnapshot, overwrite: true });
			const autoSaved = await loadSavedSetup("runtime-selection", agentDir);
			const autoLoaded = await Settings.loadReadOnly({
				cwd: projectDir,
				agentDir,
				configFiles: [autoSaved.path],
			});
			expect(autoLoaded.getModelRole("default")).toBe("anthropic/claude-opus-4-5:auto");
		} finally {
			authStorage.close();
		}
	});

	it("updates and clears one saved role while preserving the rest of the overlay", async () => {
		const setupsDir = path.join(agentDir, "setups");
		const filePath = path.join(setupsDir, "custom.yml");
		await fs.mkdir(setupsDir, { recursive: true });
		const original = {
			modelRoles: { default: "anthropic/claude:medium", smol: "fast/one", slow: "deep/one:high" },
			task: {
				disabledAgents: ["scout"],
				agentModelOverrides: { reviewer: ["fast/one", "fast/two"], sonic: null },
			},
			defaultThinkingLevel: ThinkingLevel.Medium,
			display: { showTurnTime: false },
		};
		await Bun.write(filePath, YAML.stringify(original, null, 2));

		await updateSavedSetupRole("custom", "smol", "custom/new-smol:high", agentDir);
		expect(YAML.parse(await Bun.file(filePath).text())).toEqual({
			$setup: { version: 1, enabledGroups: ["model", "appearance", "tasks"] },
			...original,
			modelRoles: { ...original.modelRoles, smol: "custom/new-smol:high" },
		});

		await updateSavedSetupRole("custom", "smol", null, agentDir);
		expect(YAML.parse(await Bun.file(filePath).text())).toEqual({
			$setup: { version: 1, enabledGroups: ["model", "appearance", "tasks"] },
			...original,
			modelRoles: { ...original.modelRoles, smol: null },
		});

		await expect(updateSavedSetupRole("missing", "smol", "fast/two", agentDir)).rejects.toThrow(
			'Saved setup "missing" was not found',
		);
		expect(await Bun.file(path.join(setupsDir, "missing.yml")).exists()).toBe(false);
	});

	it("loads roles-only setups as overlays that inherit recipient tasks and settings", async () => {
		const basePath = path.join(agentDir, "config.yml");
		await Bun.write(
			basePath,
			YAML.stringify({
				modelRoles: { default: "base/default", slow: "base/slow" },
				task: {
					disabledAgents: ["reviewer"],
					agentModelOverrides: { scout: "base/scout" },
				},
				display: { showTurnTime: false },
			}),
		);

		const active = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const exported = getSetupModelRoles(active, snapshot(agentDir));
		expect(exported.default).toBe("openai/gpt-5.4:low");
		expect(exported.slow).toBe("base/slow");

		await saveModelRolesSetup(
			"portable",
			{ default: "@slow:high", smol: null, literal: "nanogpt/coding-router:max" },
			agentDir,
		);
		await expect(saveModelRolesSetup("portable", { default: "must/not-replace" }, agentDir)).rejects.toThrow(
			'A saved setup named "portable" already exists',
		);

		const saved = await loadSavedSetup("portable", agentDir);
		const raw = YAML.parse(await Bun.file(saved.path).text()) as Record<string, unknown>;
		expect(Object.keys(raw)).toEqual(["$setup", "modelRoles"]);
		const loaded = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [saved.path] });
		expect(loaded.getModelRole("default")).toBe("@slow:high");
		expect(loaded.getModelRole("smol")).toBeUndefined();
		expect(loaded.getModelRole("literal")).toBe("nanogpt/coding-router:max");
		expect(loaded.get("task.disabledAgents")).toEqual(["reviewer"]);
		expect(loaded.get("task.agentModelOverrides").scout).toBe("base/scout");
		expect(loaded.get("display.showTurnTime")).toBe(false);
	});

	it("does not create storage while listing and requires explicit overwrite", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ display: { showTurnTime: false } }, null, 2));
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const setupsDir = path.join(agentDir, "setups");
		expect(await listSavedSetups(agentDir)).toEqual([]);
		await expect(fs.stat(setupsDir)).rejects.toMatchObject({ code: "ENOENT" });

		let draft = createProfileDraft(settings, snapshot(agentDir));
		draft = setProfileDraftGroup(draft, "appearance", true, settings);
		await saveProfileDraft("daily", draft, { agentDir });
		await expect(saveProfileDraft("daily", draft, { agentDir })).rejects.toThrow(
			'A saved setup named "daily" already exists',
		);

		setProfileConfigPath(draft.config, "display.showTurnTime", true);
		await saveProfileDraft("daily", draft, { agentDir, overwrite: true });
		const loaded = await loadSavedSetup("daily", agentDir);
		const overlay = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [loaded.path] });
		expect(overlay.get("display.showTurnTime")).toBe(true);
		expect((await listSavedSetups(agentDir)).map(item => item.name)).toEqual(["daily"]);
	});

	it("preserves human setup names across save, discovery, and load", async () => {
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const humanName = "Daily Focus 测试";
		const saved = await saveSetup(`  ${humanName}  `, { settings, snapshot: snapshot(agentDir) });
		await saveSetup("default", { settings, snapshot: snapshot(agentDir) });

		expect(saved.name).toBe(humanName);
		const listedNames = (await listSavedSetups(agentDir)).map(item => item.name);
		expect(listedNames).toHaveLength(2);
		expect(listedNames).toContain(humanName);
		expect(listedNames).toContain("default");
		const loaded = await loadSavedSetup(humanName, agentDir);
		const overlay = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [loaded.path] });
		expect(overlay.getModelRole("default")).toBe("openai/gpt-5.4:low");
	});

	it("renames exact setup bytes without overwriting an occupied destination", async () => {
		const setupsDir = path.join(agentDir, "setups");
		await fs.mkdir(setupsDir, { recursive: true });
		const originalBytes = "# retain this comment\r\nmodelRoles:\r\n  default: openai/gpt-5.4\r\n";
		const renamedPath = path.join(setupsDir, "Renamed 名.yml");
		await Bun.write(path.join(setupsDir, "Source Name.yml"), originalBytes);

		const renamed = await renameSavedSetup("Source Name", "Renamed 名", agentDir);
		expect(renamed.name).toBe("Renamed 名");
		expect(await Bun.file(renamedPath).text()).toBe(originalBytes);
		expect(await Bun.file(path.join(setupsDir, "Source Name.yml")).exists()).toBe(false);

		await renameSavedSetup("Renamed 名", "  Renamed 名  ", agentDir);
		expect(await Bun.file(renamedPath).text()).toBe(originalBytes);

		const collisionSourcePath = path.join(setupsDir, "Collision Source.yml");
		const occupiedPath = path.join(setupsDir, "Occupied.yml");
		const collisionSourceBytes = "source bytes\n";
		const occupiedBytes = "destination bytes\n";
		await Bun.write(collisionSourcePath, collisionSourceBytes);
		await Bun.write(occupiedPath, occupiedBytes);
		await expect(renameSavedSetup("Collision Source", "Occupied", agentDir)).rejects.toThrow(
			'A saved setup named "Occupied" already exists',
		);
		expect(await Bun.file(collisionSourcePath).text()).toBe(collisionSourceBytes);
		expect(await Bun.file(occupiedPath).text()).toBe(occupiedBytes);

		await expect(renameSavedSetup("Collision Source", "../outside", agentDir)).rejects.toThrow(
			"Invalid saved setup name",
		);
		expect(await Bun.file(collisionSourcePath).text()).toBe(collisionSourceBytes);
		expect(await Bun.file(tempDir.join("outside.yml")).exists()).toBe(false);
	});

	it("renames filename casing or preserves source data when the filesystem cannot apply it", async () => {
		const setupsDir = path.join(agentDir, "setups");
		const sourcePath = path.join(setupsDir, "Case Only.yml");
		const destinationPath = path.join(setupsDir, "case only.yml");
		const originalBytes = "case-only bytes\n";
		await fs.mkdir(setupsDir, { recursive: true });
		await Bun.write(sourcePath, originalBytes);
		const destinationAddressesSource = await Bun.file(destinationPath).exists();

		let renameError: Error | undefined;
		try {
			await renameSavedSetup("Case Only", "case only", agentDir);
		} catch (error) {
			renameError = error as Error;
		}

		const entries = await fs.readdir(setupsDir);
		if (renameError) {
			expect(destinationAddressesSource).toBe(true);
			expect(renameError.message).toContain("without overwriting");
			expect(entries).toContain("Case Only.yml");
			expect(await Bun.file(sourcePath).text()).toBe(originalBytes);
		} else {
			expect(entries).toContain("case only.yml");
			expect(entries).not.toContain("Case Only.yml");
			expect(await Bun.file(destinationPath).text()).toBe(originalBytes);
		}
	});

	it("preserves distinct hardlink names when the rename destination already exists", async () => {
		const setupsDir = path.join(agentDir, "setups");
		const sourceName = "Hardlink Source";
		const caseVariantName = "hardlink source";
		const sourcePath = path.join(setupsDir, `${sourceName}.yml`);
		const caseVariantPath = path.join(setupsDir, `${caseVariantName}.yml`);
		const originalBytes = "shared inode bytes\n";
		await fs.mkdir(setupsDir, { recursive: true });
		await Bun.write(sourcePath, originalBytes);
		const destinationName = (await Bun.file(caseVariantPath).exists()) ? "Hardlink Destination" : caseVariantName;
		const destinationPath = path.join(setupsDir, `${destinationName}.yml`);
		await fs.link(sourcePath, destinationPath);

		await expect(renameSavedSetup(sourceName, destinationName, agentDir)).rejects.toThrow(
			`A saved setup named "${destinationName}" already exists`,
		);
		expect(await Bun.file(sourcePath).text()).toBe(originalBytes);
		expect(await Bun.file(destinationPath).text()).toBe(originalBytes);
	});

	it("deletes only the selected setup file", async () => {
		const setupsDir = path.join(agentDir, "setups");
		const configPath = path.join(agentDir, "config.yml");
		const configBytes = "modelRoles:\n  default: live/model\n";
		const siblingPath = path.join(setupsDir, "Sibling.yml");
		const siblingBytes = "modelRoles:\n  default: sibling/model\n";
		await Bun.write(configPath, configBytes);
		await Bun.write(path.join(setupsDir, "Delete Me.yml"), "modelRoles:\n  default: delete/model\n");
		await Bun.write(siblingPath, siblingBytes);

		await deleteSavedSetup("Delete Me", agentDir);

		expect(await Bun.file(path.join(setupsDir, "Delete Me.yml")).exists()).toBe(false);
		expect(await Bun.file(siblingPath).text()).toBe(siblingBytes);
		expect(await Bun.file(configPath).text()).toBe(configBytes);
	});

	it("rejects traversal, reserved, and invalid filename names before creating storage", async () => {
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const current = snapshot(agentDir);
		const invalidNames = [
			"",
			".",
			"..",
			"../outside",
			"trailing.",
			"bad\u0000name",
			"bidirectional\u202ename",
			"CON.txt",
			"__proto__",
			"x".repeat(65),
		];
		for (const name of invalidNames) {
			expect(() => normalizeSetupName(name)).toThrow("Invalid saved setup name");
			await expect(saveSetup(name, { settings, snapshot: current })).rejects.toThrow("Invalid saved setup name");
		}
		expect(await Bun.file(path.join(agentDir, "setups")).exists()).toBe(false);
		expect(await Bun.file(tempDir.join("outside.yml")).exists()).toBe(false);
	});

	it("rejects unsafe setup storage and non-regular setup entries", async () => {
		const setupsDir = path.join(agentDir, "setups");
		await Bun.write(setupsDir, "not a directory");
		await expect(deleteSavedSetup("Target", agentDir)).rejects.toThrow("Saved setup storage is invalid");
		await fs.rm(setupsDir);
		await fs.mkdir(path.join(setupsDir, "Target.yml"), { recursive: true });
		await expect(renameSavedSetup("Target", "Renamed", agentDir)).rejects.toThrow(
			"Saved setup is not a regular file",
		);
		await expect(deleteSavedSetup("Target", agentDir)).rejects.toThrow("Saved setup is not a regular file");
	});

	it("accepts partial legacy task fields but rejects unsafe overlays without leaking parser excerpts", async () => {
		const setupsDir = path.join(agentDir, "setups");
		await fs.mkdir(setupsDir, { recursive: true });
		await Bun.write(path.join(setupsDir, "broken.yml"), 'modelRoles:\n  default: "unterminated\nsecret excerpt');
		await Bun.write(
			path.join(setupsDir, "unsafe.yml"),
			YAML.stringify({
				modelRoles: { default: "openai/gpt" },
				auth: { broker: { token: "secret" } },
			}),
		);
		await Bun.write(
			path.join(setupsDir, "proto-key.yml"),
			"modelRoles:\n  __proto__: openai/gpt\ntask:\n  disabledAgents: []\n",
		);
		await Bun.write(
			path.join(setupsDir, "partial-task.yml"),
			YAML.stringify({ modelRoles: { default: "openai/gpt" }, task: { disabledAgents: [] } }),
		);
		await Bun.write(
			path.join(setupsDir, "metadata-extra.yml"),
			YAML.stringify({
				$setup: { version: 1, enabledGroups: [], secret: "do-not-echo" },
				modelRoles: { default: "openai/gpt" },
			}),
		);
		await Bun.write(
			path.join(setupsDir, "metadata-emoji.yml"),
			YAML.stringify({
				$setup: { version: 1, emoji: "🔥", enabledGroups: [] },
				modelRoles: { default: "openai/gpt" },
			}),
		);
		await Bun.write(
			path.join(setupsDir, "off-group-payload.yml"),
			YAML.stringify({
				$setup: { version: 1, enabledGroups: [] },
				modelRoles: { default: "openai/gpt" },
				compaction: { enabled: true },
			}),
		);
		await Bun.write(
			path.join(setupsDir, "duplicate-group.yml"),
			YAML.stringify({
				$setup: { version: 1, enabledGroups: ["context", "context"] },
				modelRoles: { default: "openai/gpt" },
			}),
		);
		await Bun.write(
			path.join(setupsDir, "invalid-find.yml"),
			YAML.stringify({
				$setup: { version: 1, enabledGroups: ["tools"] },
				modelRoles: { default: "openai/gpt" },
				find: { enabled: "automatic" },
			}),
		);

		const partial = await loadSavedSetup("partial-task", agentDir);
		expect(partial.metadata).toEqual({ version: 1, enabledGroups: ["tasks"] });
		expect(getProfileConfigPath(partial.config, "task.disabledAgents")).toEqual({ present: true, value: [] });
		expect(getProfileConfigPath(partial.config, "task.agentModelOverrides").present).toBe(false);

		for (const name of [
			"broken",
			"unsafe",
			"proto-key",
			"metadata-extra",
			"metadata-emoji",
			"off-group-payload",
			"duplicate-group",
			"invalid-find",
		]) {
			try {
				await loadSavedSetup(name, agentDir);
				expect.unreachable("expected invalid setup rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("Saved setup is invalid");
				expect((error as Error).message).not.toContain("secret");
				expect((error as Error).message).not.toContain("unterminated");
			}
		}
	});

	it("bounds native setup reads and refuses to persist output larger than the read contract", async () => {
		const setupsDir = path.join(agentDir, "setups");
		await fs.mkdir(setupsDir, { recursive: true });
		await Bun.write(path.join(setupsDir, "oversized.yml"), "x".repeat(1024 * 1024 + 1));
		await expect(loadSavedSetup("oversized", agentDir)).rejects.toThrow("Saved setup is too large");

		const modelRoles: Record<string, string> = {};
		for (let index = 0; index < 1_000; index++) {
			const role = `r${index.toString().padStart(4, "0")}${"k".repeat(245)}`;
			modelRoles[role] = `p/${"m".repeat(794)}`;
		}
		await expect(
			saveProfileDraft(
				"serialized-too-large",
				{ metadata: { version: 1, enabledGroups: [] }, config: { modelRoles } },
				{ agentDir },
			),
		).rejects.toThrow("Saved setup is too large");
		expect(await Bun.file(path.join(setupsDir, "serialized-too-large.yml")).exists()).toBe(false);
	});
});
