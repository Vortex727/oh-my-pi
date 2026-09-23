import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	describe("with a live session and persisted settings", () => {
		let tempDir: TempDir;
		let authStorage: AuthStorage;
		let settings: Settings;
		let session: AgentSession;
		let controller: SelectorController;
		let configPath: string;

		beforeEach(async () => {
			tempDir = TempDir.createSync("@pi-selector-queue-");
			const agentDir = tempDir.path();
			configPath = path.join(agentDir, "config.yml");

			authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStorage.keys.setRuntime("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
			settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: SessionManager.create(agentDir, agentDir),
				settings,
				modelRegistry,
				obfuscator: new SecretObfuscator([]),
			});
			controller = new SelectorController({ session, settings } as unknown as InteractiveModeContext);
		});

		afterEach(async () => {
			vi.restoreAllMocks();
			authStorage.close();
			AgentStorage.close();
			// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
			Bun.gc(true);
			try {
				await tempDir.remove();
			} catch {}
		});

		it("applies panel queue-mode toggles live and persists them globally", async () => {
			controller.handleSettingChange("steeringMode", "all");
			controller.handleSettingChange("followUpMode", "all");
			controller.handleSettingChange("interruptMode", "wait");
			await settings.flush();

			expect(session.steeringMode).toBe("all");
			expect(session.followUpMode).toBe("all");
			expect(session.interruptMode).toBe("wait");
			expect(settings.getGlobalSettings()).toMatchObject({
				steeringMode: "all",
				followUpMode: "all",
				interruptMode: "wait",
			});
			const onDisk = await Bun.file(configPath).text();
			expect(onDisk).toContain("steeringMode: all");
			expect(onDisk).toContain("followUpMode: all");
			expect(onDisk).toContain("interruptMode: wait");
		});

		it("applies a profile's queue modes live without writing config or releasing them", async () => {
			const changed = settings.applySetupLayer({ steeringMode: "all", interruptMode: "wait" });
			controller.applySettingEffects(changed);
			await settings.flush();

			expect(session.steeringMode).toBe("all");
			expect(session.interruptMode).toBe("wait");
			// The profile still owns both settings, so unloading it restores the user's values.
			expect(settings.getSetupLayer()).toEqual({ steeringMode: "all", interruptMode: "wait" });
			expect(settings.getGlobalSettings()).not.toHaveProperty("steeringMode");
			expect(settings.getGlobalSettings()).not.toHaveProperty("interruptMode");
			const onDisk = await Bun.file(configPath)
				.text()
				.catch(() => "");
			expect(onDisk).not.toContain("steeringMode");
			expect(onDisk).not.toContain("interruptMode");
		});

		it("assigning a global default while a profile owns it switches to the default that becomes effective", async () => {
			const model = (id: string) => getBundledModel("anthropic", id) as Model;
			settings.set("modelRoleStorage", "project");
			settings.setProjectModelRole("default", "anthropic/claude-opus-4-5");
			settings.applySetupLayer({ modelRoles: { default: "anthropic/claude-haiku-4-5" } });
			await session.setModel(model("claude-haiku-4-5"), "default");

			let callbacks: modelHubModule.ModelHubCallbacks | undefined;
			vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
				callbacks = args[4] as modelHubModule.ModelHubCallbacks;
				return { refreshAfterExternalMutation: () => {}, dispose: () => {} };
			} as never);
			const hubController = new SelectorController({
				session,
				settings,
				ui: { showOverlay: () => ({ hide: () => {} }), setFocus: () => {}, requestRender: () => {} },
				statusLine: { invalidate: () => {} },
				updateEditorBorderColor: () => {},
				showStatus: () => {},
				showError: (message: string) => {
					throw new Error(message);
				},
			} as unknown as InteractiveModeContext);
			hubController.showModelSelector();
			if (!callbacks) throw new Error("model hub was not opened");

			await callbacks.onAssign(
				model("claude-opus-4-1"),
				"default",
				undefined,
				"anthropic/claude-opus-4-1",
				"global",
			);
			await settings.flush();

			// The assignment released the profile's default and persisted globally; the
			// project default now in effect is what the session runs.
			expect(settings.getGlobalModelRole("default")).toBe("anthropic/claude-opus-4-1");
			expect(settings.getModelRoleProvenance("default")).toBe("project");
			expect(session.model?.id).toBe("claude-opus-4-5");
		});
	});

	it("persists the Auto-Compact toggle globally from the settings panel", () => {
		const setAutoCompactionEnabled = vi.fn();
		const ctx = {
			session: { setAutoCompactionEnabled },
			statusLine: { setAutoCompactEnabled: vi.fn() },
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("autoCompact", false);

		// persist=true: panel edits are durable, unlike the session-scoped RPC path (#11431).
		expect(setAutoCompactionEnabled).toHaveBeenCalledWith(false, true);
	});
});
