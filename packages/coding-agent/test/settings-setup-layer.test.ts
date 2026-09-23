import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("Settings saved-setup layer", () => {
	it("outranks persisted layers, yields to runtime overrides, and clears back to them", () => {
		const settings = Settings.isolated({});
		settings.set("compaction.enabled", false);
		settings.setModelRole("smol", "base/smol");
		settings.setModelRole("slow", "base/slow");

		settings.applySetupLayer({ compaction: { enabled: true }, modelRoles: { smol: "setup/smol", slow: null } });
		expect(settings.get("compaction.enabled")).toBe(true);
		expect(settings.getModelRole("smol")).toBe("setup/smol");
		// A null setup role masks the persisted role, like an overlay tombstone.
		expect(settings.getModelRole("slow")).toBeUndefined();
		// Unlike an overlay role, a setup role is released by editing it; callers
		// judge shadowing by the layer that supplies the role once released.
		expect(settings.getModelRoleProvenance("smol")).toBe("setup");
		expect(settings.getModelRoleProvenance("smol", { ignoreSetup: true })).toBe("global");

		settings.overrideModelRoles({ smol: "runtime/smol" });
		expect(settings.getModelRole("smol")).toBe("runtime/smol");
		settings.clearOverride("modelRoles");

		settings.applySetupLayer(undefined);
		expect(settings.get("compaction.enabled")).toBe(false);
		expect(settings.getModelRole("smol")).toBe("base/smol");
		expect(settings.getModelRole("slow")).toBe("base/slow");
	});

	it("lets an explicit edit of a setup-owned setting take effect while the rest of the setup stays applied", () => {
		const settings = Settings.isolated({});
		settings.applySetupLayer({
			compaction: { enabled: false },
			tui: { vimMode: true },
			modelRoles: { smol: "setup/smol", slow: "setup/slow" },
		});

		settings.set("compaction.enabled", true);
		settings.setModelRole("smol", "user/smol");

		expect(settings.get("compaction.enabled")).toBe(true);
		expect(settings.getModelRole("smol")).toBe("user/smol");
		expect(settings.getModelRoleProvenance("smol")).toBe("global");
		expect(settings.get("tui.vimMode")).toBe(true);
		expect(settings.getModelRole("slow")).toBe("setup/slow");
	});

	it("reports and signals only the settings whose effective value the setup changes", () => {
		const settings = Settings.isolated({});
		const browserEnabled = settings.get("browser.enabled");
		const changed: string[] = [];
		const unsubscribe = settings.onEffectiveChange(path => changed.push(path));
		try {
			const setup = {
				browser: { enabled: !browserEnabled },
				compaction: { enabled: settings.get("compaction.enabled") },
			};
			expect(settings.applySetupLayer(setup)).toEqual(["browser.enabled"]);
			expect(changed).toEqual(["browser.enabled"]);

			changed.length = 0;
			expect(settings.applySetupLayer(setup)).toEqual([]);
			expect(changed).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	it("carries the applied setup into settings cloned for another working directory", async () => {
		const settings = Settings.isolated({});
		settings.applySetupLayer({ modelRoles: { smol: "setup/smol" } });

		const cloned = await settings.cloneForCwd(os.tmpdir());
		expect(cloned.getModelRole("smol")).toBe("setup/smol");
	});

	it("previews a setup at its load rank without changing the live settings", () => {
		const settings = Settings.isolated({ steeringMode: "all" });
		settings.set("tui.vimMode", false);
		const changed: string[] = [];
		const unsubscribe = settings.onEffectiveChange(path => changed.push(path));
		try {
			const preview = settings.previewSetup({ steeringMode: "one-at-a-time", tui: { vimMode: true } });

			// The runtime override outranks the setup, exactly as when the setup loads.
			expect(preview.get("steeringMode")).toBe("all");
			expect(preview.get("tui.vimMode")).toBe(true);
			expect(settings.get("tui.vimMode")).toBe(false);
			expect(settings.getSetupLayer()).toEqual({});
			expect(changed).toEqual([]);
		} finally {
			unsubscribe();
		}
	});
});

describe("Settings entry-level writes under a setup layer", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		await tempDir?.remove();
		tempDir = undefined;
	});

	async function loadPersisted(): Promise<{ settings: Settings; readConfig: () => Promise<RawSettings> }> {
		tempDir = TempDir.createSync("@pi-setup-entries-");
		const agentDir = tempDir.path();
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		const configPath = path.join(agentDir, "config.yml");
		return { settings, readConfig: async () => YAML.parse(await Bun.file(configPath).text()) as RawSettings };
	}

	it("persists only the edited record entry while the setup's other entries keep applying", async () => {
		const { settings, readConfig } = await loadPersisted();
		settings.applySetupLayer({ retry: { fallbackChains: { smol: ["friend/cheap-model"] } } });

		settings.setRecordEntry("retry.fallbackChains", "slow", ["user/slow-fallback"]);
		// Model-oriented keys contain dots; the entry persists under its exact key.
		settings.setRecordEntry("retry.fallbackChains", "openai/gpt-4.1", ["openai/gpt-4.1-mini"]);
		await settings.flush();

		expect((await readConfig()).retry).toEqual({
			fallbackChains: { slow: ["user/slow-fallback"], "openai/gpt-4.1": ["openai/gpt-4.1-mini"] },
		});
		expect(settings.get("retry.fallbackChains")).toEqual({
			smol: ["friend/cheap-model"],
			slow: ["user/slow-fallback"],
			"openai/gpt-4.1": ["openai/gpt-4.1-mini"],
		});

		settings.setRecordEntry("retry.fallbackChains", "slow", undefined);
		await settings.flush();
		expect((await readConfig()).retry).toEqual({ fallbackChains: { "openai/gpt-4.1": ["openai/gpt-4.1-mini"] } });
		expect(settings.get("retry.fallbackChains")).toEqual({
			smol: ["friend/cheap-model"],
			"openai/gpt-4.1": ["openai/gpt-4.1-mini"],
		});
	});

	it("persists only the toggled list member while the rest of a setup-owned list stays effective", async () => {
		const { settings, readConfig } = await loadPersisted();
		settings.set("task.disabledAgents", ["reviewer"]);
		settings.applySetupLayer({ task: { disabledAgents: ["scout", "explore"] } });

		settings.setListMember("task.disabledAgents", "scout", false);
		settings.setListMember("task.disabledAgents", "oracle", true);
		await settings.flush();

		expect(settings.get("task.disabledAgents")).toEqual(["explore", "oracle"]);
		expect((await readConfig()).task).toEqual({ disabledAgents: ["reviewer", "oracle"] });
	});
});
