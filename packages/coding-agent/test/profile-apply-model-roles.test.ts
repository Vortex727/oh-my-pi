import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { applySetupModelRoles } from "@oh-my-pi/pi-coding-agent/profiles/apply-model-roles";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function modelValue(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

describe("applySetupModelRoles", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession;
	let initialModel: Model<Api>;
	let targetModel: Model<Api>;
	let imageModel: Model<Api>;
	let speechModel: Model<Api>;
	let dictationModel: Model<Api>;
	let tinyModel: Model<Api>;
	let configPath: string;
	let setupPath: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-profile-apply-roles-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		const registry = new ModelRegistry(authStorage);
		const initial = registry.find("anthropic", "claude-sonnet-4-5");
		const target = registry.find("anthropic", "claude-sonnet-4-6");
		const image = registry.find("openai", "chatgpt-image-latest");
		const speech = registry.find("local", "kokoro");
		const dictation = registry.find("local", "whisper-base");
		const tiny = registry.find("local", "falcon-h1-90m");
		if (!initial || !target || !image || !speech || !dictation || !tiny) {
			throw new Error("Expected bundled model-role fixtures");
		}
		initialModel = initial;
		targetModel = target;
		imageModel = image;
		speechModel = speech;
		dictationModel = dictation;
		tinyModel = tiny;

		settings = Settings.isolated();
		settings.setModelRole("default", "@slow:auto");
		settings.setModelRole("slow", modelValue(initialModel));
		settings.setModelRole("smol", modelValue(initialModel));
		settings.setModelRole("vision", modelValue(initialModel));

		const history: AgentMessage = { role: "user", content: "keep this conversation", timestamp: 1 };
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage(history);
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [history],
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
		});

		configPath = path.join(tempDir.path(), "config.yml");
		setupPath = path.join(tempDir.path(), "saved-setup.yml");
		await Bun.write(configPath, "modelRoles:\n  default: '@slow:auto'\n");
		await Bun.write(setupPath, "modelRoles:\n  slow: anthropic/claude-sonnet-4-6\n");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		settings.cancelPendingSaves();
		authStorage.close();
		tempDir.removeSync();
	});

	it("applies alias changes in place while preserving nulls, omissions, history, and files", async () => {
		const sessionId = session.sessionId;
		const sessionFile = session.sessionFile;
		const messages = [...session.messages];
		const entries = [...session.sessionManager.getEntries()];
		const configBytes = await Bun.file(configPath).bytes();
		const setupBytes = await Bun.file(setupPath).bytes();
		const targetSelector = `${modelValue(targetModel)}:high`;

		await applySetupModelRoles({
			session,
			settings,
			roles: {
				slow: targetSelector,
				smol: null,
				task: "@default",
			},
			getBlockReason: () => undefined,
		});

		expect(modelValue(session.model!)).toBe(modelValue(targetModel));
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(settings.getModelRole("default")).toBe("@slow:auto");
		expect(settings.getModelRole("slow")).toBe(targetSelector);
		expect(settings.getModelRole("task")).toBe("@default");
		expect(settings.getModelRole("smol")).toBeUndefined();
		expect(settings.getModelRoleProvenance("smol")).toBe("runtime");
		expect(settings.getModelRole("vision")).toBe(modelValue(initialModel));

		settings.overrideModelRoles({ advisor: modelValue(targetModel) });
		expect(settings.getModelRole("smol")).toBeUndefined();
		expect(settings.getModelRoleProvenance("smol")).toBe("runtime");

		expect(session.sessionId).toBe(sessionId);
		expect(session.sessionFile).toBe(sessionFile);
		expect(session.messages).toEqual(messages);
		expect(session.sessionManager.getEntries().slice(0, entries.length)).toEqual(entries);
		expect(
			session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "model_change")
				.at(-1),
		).toMatchObject({
			model: modelValue(targetModel),
			role: "temporary",
		});
		expect(await Bun.file(configPath).bytes()).toEqual(configBytes);
		expect(await Bun.file(setupPath).bytes()).toEqual(setupBytes);
	});

	it("applies non-chat and keyless runner roles without changing the chat session model", async () => {
		const entries = [...session.sessionManager.getEntries()];

		await applySetupModelRoles({
			session,
			settings,
			roles: {
				image: modelValue(imageModel),
				speech: modelValue(speechModel),
				dictation: modelValue(dictationModel),
				tiny: modelValue(tinyModel),
			},
			getBlockReason: () => undefined,
		});

		expect(session.model).toBe(initialModel);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(settings.getModelRole("image")).toBe(modelValue(imageModel));
		expect(settings.getModelRole("speech")).toBe(modelValue(speechModel));
		expect(settings.getModelRole("dictation")).toBe(modelValue(dictationModel));
		expect(settings.getModelRole("tiny")).toBe(modelValue(tinyModel));
	});

	it("rejects a model of the wrong kind before mutating the session or role overlay", async () => {
		const entries = [...session.sessionManager.getEntries()];
		const roles = { ...settings.getModelRoles() };

		await expect(
			applySetupModelRoles({
				session,
				settings,
				roles: { image: modelValue(targetModel) },
				getBlockReason: () => undefined,
			}),
		).rejects.toThrow('Model role "image" has an invalid selector');

		expect(session.model).toBe(initialModel);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(settings.getModelRoles()).toEqual(roles);
	});

	it("rejects an unavailable supplied role before changing the session or role overlay", async () => {
		const sessionId = session.sessionId;
		const messages = [...session.messages];
		const entries = [...session.sessionManager.getEntries()];
		const roles = { ...settings.getModelRoles() };

		await expect(
			applySetupModelRoles({
				session,
				settings,

				roles: {
					default: modelValue(targetModel),
					smol: "anthropic/does-not-exist",
				},
				getBlockReason: () => undefined,
			}),
		).rejects.toThrow('Model role "smol" is not available in the current session');

		expect(session.sessionId).toBe(sessionId);
		expect(session.model).toBe(initialModel);
		expect(session.messages).toEqual(messages);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(settings.getModelRoles()).toEqual(roles);
	});
	it("keeps Automatic aliases valid when a referenced default is explicitly null", async () => {
		await applySetupModelRoles({
			session,
			settings,
			roles: { default: null, task: "@default" },
			getBlockReason: () => undefined,
		});

		expect(session.model).toBe(initialModel);
		expect(settings.getModelRole("default")).toBeUndefined();
		expect(settings.getModelRoleProvenance("default")).toBe("runtime");
		expect(settings.getModelRole("task")).toBe("@default");
	});

	it("restores the previous live model when switching fails after mutation", async () => {
		const originalSetModelTemporary = session.setModelTemporary.bind(session);
		let attempts = 0;
		vi.spyOn(session, "setModelTemporary").mockImplementation(async (model, thinkingLevel, options) => {
			await originalSetModelTemporary(model, thinkingLevel, options);
			attempts++;
			if (attempts === 1) throw new Error("post-switch failure");
		});
		const roles = { ...settings.getModelRoles() };

		await expect(
			applySetupModelRoles({
				session,
				settings,
				roles: { default: modelValue(targetModel) },
				getBlockReason: () => undefined,
			}),
		).rejects.toThrow("post-switch failure");

		expect(session.model).toBe(initialModel);
		expect(settings.getModelRoles()).toEqual(roles);
		expect(attempts).toBe(2);
		expect(
			session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "model_change")
				.slice(-2),
		).toMatchObject([
			{ model: modelValue(targetModel), role: "temporary" },
			{ model: modelValue(initialModel), role: "temporary" },
		]);
	});
});
