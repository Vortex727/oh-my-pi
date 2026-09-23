import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createSetupDraft,
	listSavedSetups,
	loadSavedSetup,
	modelsOnlyDraft,
	parseProfileText,
	readProfileFile,
	renameSavedSetup,
	SetupError,
	saveSetup,
	serializeSetup,
	setDraftGroup,
	writeProfileFile,
} from "@oh-my-pi/pi-coding-agent/profiles/setups";
import type { ProfileDraft } from "@oh-my-pi/pi-coding-agent/profiles/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function draft(
	config: ProfileDraft["config"],
	enabledGroups: ProfileDraft["metadata"]["enabledGroups"] = [],
): ProfileDraft {
	return { metadata: { version: 1, enabledGroups }, config };
}

async function expectSetupError(promise: Promise<unknown>, kind: SetupError["kind"]): Promise<void> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(SetupError);
	expect((error as SetupError).kind).toBe(kind);
}

describe("saved setups storage", () => {
	it("round-trips a human-named setup through save, list, and load", async () => {
		using dir = TempDir.createSync("@omp-setups-roundtrip-");
		const saved = draft(
			{ modelRoles: { default: "openai/gpt-5.4:low", smol: null }, compaction: { enabled: false } },
			["context"],
		);
		saved.metadata.emoji = "🧠";

		await saveSetup("  Daily Focus 测试  ", saved, { agentDir: dir.path() });

		const listed = await listSavedSetups(dir.path());
		expect(listed.map(item => [item.name, item.metadata?.emoji, item.error])).toEqual([
			["Daily Focus 测试", "🧠", undefined],
		]);
		const loaded = await loadSavedSetup("Daily Focus 测试", dir.path());
		expect(loaded.config).toEqual(saved.config);
		expect(loaded.metadata.enabledGroups).toEqual(["context"]);
		expect(loaded.warnings).toEqual([]);
	});

	it("never replaces an existing setup unless overwrite is requested", async () => {
		using dir = TempDir.createSync("@omp-setups-create-only-");
		await saveSetup("focus", draft({ modelRoles: { default: "first/model" } }), { agentDir: dir.path() });

		await expectSetupError(
			saveSetup("focus", draft({ modelRoles: { default: "second/model" } }), { agentDir: dir.path() }),
			"exists",
		);
		expect((await loadSavedSetup("focus", dir.path())).config.modelRoles).toEqual({ default: "first/model" });

		await saveSetup("focus", draft({ modelRoles: { default: "second/model" } }), {
			agentDir: dir.path(),
			overwrite: true,
		});
		expect((await loadSavedSetup("focus", dir.path())).config.modelRoles).toEqual({ default: "second/model" });
	});

	it("loads what it can from a setup written by another omp version and names every skipped entry", async () => {
		using dir = TempDir.createSync("@omp-setups-tolerant-");
		await fs.mkdir(dir.join("setups"));
		await Bun.write(
			dir.join("setups", "legacy.yml"),
			[
				"$setup:",
				"  version: 1",
				"  enabledGroups: [appearance, retired-group]",
				"modelRoles:",
				"  default: anthropic/claude-sonnet-4-5",
				"  smol: 42",
				"compaction:",
				"  enabled: false",
				"tui:",
				"  vimMode: sometimes",
				"removedSection:",
				"  flag: true",
				"",
			].join("\n"),
		);

		const loaded = await loadSavedSetup("legacy", dir.path());

		expect(loaded.config).toEqual({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			compaction: { enabled: false },
		});
		// `compaction.enabled` keeps its value even though metadata did not list its group.
		expect(loaded.metadata.enabledGroups).toEqual(["appearance", "context"]);
		// Each skipped entry is named so the user can find it in the file.
		expect(loaded.warnings).toHaveLength(4);
		for (const [index, entry] of ["retired-group", "smol", "tui.vimMode", "removedSection"].entries()) {
			expect(loaded.warnings[index]).toContain(entry);
		}
	});

	it("lists a setup from a newer format version with its error instead of failing discovery", async () => {
		using dir = TempDir.createSync("@omp-setups-version-");
		await saveSetup("current", draft({ modelRoles: {} }), { agentDir: dir.path() });
		await Bun.write(dir.join("setups", "future.yml"), "$setup:\n  version: 2\nmodelRoles: {}\n");

		const listed = await listSavedSetups(dir.path());
		expect(listed.map(item => item.name)).toEqual(["current", "future"]);
		expect(listed[0]?.error).toBeUndefined();
		expect(listed[1]?.error).toContain("version 2");
		await expectSetupError(loadSavedSetup("future", dir.path()), "unsupported-version");
	});

	it("rejects traversal and reserved names before creating storage", async () => {
		using dir = TempDir.createSync("@omp-setups-names-");
		for (const name of ["", "..", "../escape", "nested/name", "CON", "trailing.", "__proto__"]) {
			await expectSetupError(saveSetup(name, draft({ modelRoles: {} }), { agentDir: dir.path() }), "invalid-name");
		}
		expect(await fs.readdir(dir.path())).toEqual([]);
	});

	it("renames without replacing another setup and allows case-only renames", async () => {
		using dir = TempDir.createSync("@omp-setups-rename-");
		await saveSetup("alpha", draft({ modelRoles: { default: "a/model" } }), { agentDir: dir.path() });
		await saveSetup("beta", draft({ modelRoles: { default: "b/model" } }), { agentDir: dir.path() });

		await expectSetupError(renameSavedSetup("alpha", "beta", dir.path()), "exists");
		expect((await loadSavedSetup("beta", dir.path())).config.modelRoles).toEqual({ default: "b/model" });

		await renameSavedSetup("alpha", "Alpha", dir.path());
		expect((await listSavedSetups(dir.path())).map(item => item.name)).toEqual(["Alpha", "beta"]);
		expect((await fs.readdir(path.join(dir.path(), "setups"))).sort()).toEqual(["Alpha.yml", "beta.yml"]);
	});
});

describe("setup drafts", () => {
	it("includes only explicitly configured group settings and never machine-local ones", () => {
		const settings = Settings.isolated({});
		settings.set("compaction.enabled", false);
		settings.set("providers.fireworksTier", "priority");

		let setup = createSetupDraft(settings);
		setup = setDraftGroup(setup, "context", true, settings);
		setup = setDraftGroup(setup, "providers", true, settings);

		expect(setup.config.compaction).toEqual({ enabled: false });
		// Unset context settings keep following omp defaults instead of being frozen into the setup.
		expect(Object.keys(setup.config.compaction as object)).toEqual(["enabled"]);
		expect(setup.config.providers).toBeUndefined();
		expect(setup.metadata.enabledGroups).toEqual(["context", "providers"]);

		setup = setDraftGroup(setup, "context", false, settings);
		expect(setup.config.compaction).toBeUndefined();
		expect(setup.metadata.enabledGroups).toEqual(["providers"]);
	});

	it("saves the live session model and its configured thinking as the default role", () => {
		const settings = Settings.isolated({});
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		settings.setModelRole("smol", "openai/gpt-5.4-mini");

		const setup = createSetupDraft(settings, { provider: "openai", id: "gpt-5.4", thinkingLevel: "auto" });

		expect(setup.config.modelRoles).toEqual({ default: "openai/gpt-5.4:auto", smol: "openai/gpt-5.4-mini" });
	});
});

describe("profile sharing", () => {
	const shared: ProfileDraft = {
		metadata: { version: 1, emoji: "⚡", enabledGroups: ["context", "tasks"] },
		config: {
			modelRoles: { default: "anthropic/claude-sonnet-4-5:high", smol: null, task: "@default" },
			compaction: { enabled: false },
			task: { disabledAgents: ["reviewer"], agentModelOverrides: { scout: ["openai/gpt-5.4-mini", "@smol"] } },
		},
	};

	it("round-trips an exported profile through a file exactly, and a models-only export keeps only roles", async () => {
		using dir = TempDir.createSync("@omp-profile-share-");
		const file = dir.join("focus.profile.yml");
		await writeProfileFile(file, shared);
		expect(await readProfileFile(file)).toEqual({ ...shared, warnings: [] });

		expect(parseProfileText(serializeSetup(modelsOnlyDraft(shared)))).toEqual({
			metadata: { version: 1, emoji: "⚡", enabledGroups: [] },
			config: { modelRoles: shared.config.modelRoles },
			warnings: [],
		});
	});

	it("never replaces an existing file on export", async () => {
		using dir = TempDir.createSync("@omp-profile-share-exists-");
		const file = dir.join("taken.yml");
		await Bun.write(file, "keep me\n");
		await expectSetupError(writeProfileFile(file, shared), "exists");
		expect(await Bun.file(file).text()).toBe("keep me\n");
	});

	it("imports a plain config.yml-style document without letting credentials or machine-local settings in", () => {
		const imported = parseProfileText(
			[
				"modelRoles:",
				"  smol: openai/gpt-5.4-mini",
				"compaction:",
				"  enabled: true",
				"auth:",
				"  broker:",
				"    token: broker-secret",
				"providers:",
				"  fireworksTier: priority",
				"",
			].join("\n"),
		);
		expect(imported.config).toEqual({ modelRoles: { smol: "openai/gpt-5.4-mini" }, compaction: { enabled: true } });
		expect(imported.metadata.enabledGroups).toEqual(["context"]);
		// Skipped entries are named where they leave the profile's own settings, so users can find them.
		expect(imported.warnings.some(warning => warning.startsWith("Ignored auth:"))).toBe(true);
		expect(imported.warnings.some(warning => warning.includes("providers.fireworksTier"))).toBe(true);
	});

	it("rejects model roles whose aliases fan out past the safety budget, but keeps ordinary alias chains", () => {
		const roles = Array.from({ length: 12 }, (_, index) => `r${index}`);
		const crafted = roles.map(role => `  ${role}: "${roles.map(other => `@${other}`).join(",")}"`);
		expect(() => parseProfileText(["modelRoles:", ...crafted, ""].join("\n"))).toThrow(SetupError);

		const chain = parseProfileText(
			'modelRoles:\n  default: anthropic/claude-sonnet-4-5\n  task: "@default"\n  scout: "@task,*"\n',
		);
		expect(chain.config.modelRoles).toEqual({
			default: "anthropic/claude-sonnet-4-5",
			task: "@default",
			scout: "@task,*",
		});
	});
});
