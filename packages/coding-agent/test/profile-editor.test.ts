import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ProfileEditorComponent, ProfileEmojiPicker } from "@oh-my-pi/pi-coding-agent/modes/components/profile-editor";
import { getProfileGroupPaths } from "@oh-my-pi/pi-coding-agent/profiles/setups";
import { PROFILE_EMOJIS, type ProfileDraft, type ProfileEmoji } from "@oh-my-pi/pi-coding-agent/profiles/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

function modelsOnlyDraft(): ProfileDraft {
	return {
		metadata: { version: 1, enabledGroups: [] },
		config: { modelRoles: { default: "anthropic/fixture-model" } },
	};
}

function draftValue(draft: ProfileDraft, path: string): unknown {
	let current: unknown = draft.config;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function createEditor(overrides: Partial<ConstructorParameters<typeof ProfileEditorComponent>[0]> = {}) {
	const saved: Array<{ draft: ProfileDraft; saveAsNew: boolean }> = [];
	const cancelled = vi.fn();
	const editor = new ProfileEditorComponent({
		draft: modelsOnlyDraft(),
		effectiveSettings: Settings.isolated({ "compaction.enabled": false }),
		terminalHeight: 24,
		callbacks: {
			requestRender: () => {},
			onEditRole: async (_role, draft) => draft,
			onEditAgent: async (_agent, draft) => draft,
			onSave: (draft, saveAsNew) => {
				saved.push({ draft, saveAsNew });
			},
			onCancel: cancelled,
		},
		...overrides,
	});
	return { editor, saved, cancelled };
}

function typeText(editor: ProfileEditorComponent, value: string): void {
	for (const character of value) editor.handleInput(character);
}

describe("profile draft editor isolation", () => {
	test("keeps inherited fields read-only until inclusion and confirms destructive exclusion", () => {
		const effectiveSettings = Settings.isolated({ "compaction.enabled": false });
		const { editor } = createEditor({ effectiveSettings, initialGroup: "context" });

		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).not.toContain("context");
		expect(draftValue(editor.draft, "compaction.enabled")).toBeUndefined();

		editor.handleInput("\x1b[A");
		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).toContain("context");
		expect(effectiveSettings.get("compaction.enabled")).toBe(false);

		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).toContain("context");
		editor.handleInput(" ");
		expect(editor.draft.metadata.enabledGroups).not.toContain("context");
		for (const path of getProfileGroupPaths("context")) {
			expect(draftValue(editor.draft, path)).toBeUndefined();
		}
		expect(effectiveSettings.get("compaction.enabled")).toBe(false);
	});

	test("re-enabling a discarded group seeds the inherited base instead of the old profile overlay", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["context"];
		draft.config.compaction = { enabled: true };
		const { editor } = createEditor({
			draft,
			effectiveSettings: Settings.isolated({ "compaction.enabled": true }),
			inheritedSettings: Settings.isolated({ "compaction.enabled": false }),
			initialGroup: "context",
		});

		editor.handleInput(" ");
		editor.handleInput(" ");
		expect(editor.draft.metadata.enabledGroups).not.toContain("context");
		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).toContain("context");
		expect(draftValue(editor.draft, "compaction.enabled")).toBe(false);
	});

	test("edits a native field in the continuous list without entering a group page", () => {
		const effectiveSettings = Settings.isolated({ "compaction.enabled": false });
		const { editor } = createEditor({ effectiveSettings, initialGroup: "context" });
		editor.handleInput("\r");
		typeText(editor, "auto-compact");
		editor.handleInput("\r");

		expect(draftValue(editor.draft, "compaction.enabled")).toBe(true);
		expect(effectiveSettings.get("compaction.enabled")).toBe(false);
	});

	test("refreshes condition-gated fields after a native enum editor changes the draft", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["memory"];
		draft.config.memory = { backend: "off" };
		const effectiveSettings = Settings.isolated({ "memory.backend": "off" });
		const { editor } = createEditor({ draft, effectiveSettings, initialGroup: "memory" });

		typeText(editor, "memory backend");
		editor.handleInput("\r");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		typeText(editor, "hindsight auto recall");

		expect(draftValue(editor.draft, "memory.backend")).toBe("hindsight");
		expect(effectiveSettings.get("memory.backend")).toBe("off");
		expect(editor.render(120).map(stripVTControlCharacters).join("\n")).toContain("Hindsight Auto Recall");
	});

	test("uses the native compound editor while keeping fallback changes draft-only", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["model"];
		draft.config.retry = { fallbackChains: {} };
		const effectiveSettings = Settings.isolated({ "retry.fallbackChains": {} });
		const { editor } = createEditor({ draft, effectiveSettings, initialGroup: "model" });

		typeText(editor, "retry fallback chains");
		editor.handleInput("\r");
		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		editor.handleInput('{"default":["openai/fallback"]}');
		editor.handleInput("\r");

		expect(draftValue(editor.draft, "retry.fallbackChains")).toEqual({ default: ["openai/fallback"] });
		expect(effectiveSettings.get("retry.fallbackChains")).toEqual({});
	});

	test("field Escape returns to the flat editor before a later main-list Escape cancels the draft", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["model"];
		draft.config.retry = { fallbackChains: {} };
		const { editor, cancelled } = createEditor({ draft, initialGroup: "model" });

		typeText(editor, "retry fallback chains");
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		expect(cancelled).not.toHaveBeenCalled();
		editor.handleInput("\x1b");
		expect(cancelled).not.toHaveBeenCalled();
		editor.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("reviews captured agent assignments and toggles availability without losing ordered fallbacks", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["tasks"];
		draft.config.task = {
			disabledAgents: ["scout"],
			agentModelOverrides: {
				reviewer: ["anthropic/first", "openai/second"],
			},
		};
		const { editor } = createEditor({
			draft,
			agentNames: ["scout", "reviewer", "security-reviewer"],
			initialGroup: "tasks",
		});
		typeText(editor, "reviewer");
		const text = editor.render(120).map(stripVTControlCharacters).join("\n");
		expect(text).toContain("Agent · reviewer");
		expect(text).toContain("anthropic/first → openai/second");

		editor.handleInput(" ");
		expect(draftValue(editor.draft, "task.disabledAgents")).toEqual(["scout", "reviewer"]);
		expect(draftValue(editor.draft, "task.agentModelOverrides.reviewer")).toEqual([
			"anthropic/first",
			"openai/second",
		]);
	});

	test("Escape from the continuous main list cancels the entire staged draft", () => {
		const { editor, cancelled } = createEditor({ initialGroup: "context" });
		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).toContain("context");
		editor.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("emoji picker Escape discards the whole draft through the editor cancel callback", () => {
		const { editor, cancelled } = createEditor();
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("Down crosses section boundaries and a cancelled model-role picker cancels the draft", async () => {
		const cancelled = vi.fn();
		const { editor } = createEditor({
			callbacks: {
				requestRender: () => {},
				onEditRole: async () => undefined,
				onSave: () => {},
				onCancel: cancelled,
				onEditAgent: async (_agent, draft) => draft,
			},
		});
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		await Promise.resolve();
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("serializes immediate emoji saves and preserves the draft when a write fails", async () => {
		const draft = modelsOnlyDraft();
		draft.metadata.emoji = "⚡";
		const firstSave = Promise.withResolvers<boolean>();
		const secondSave = Promise.withResolvers<boolean>();
		const cancelled = vi.fn();
		let attempt = 0;
		const onSaveEmoji = vi.fn((_value: ProfileEmoji | undefined) => {
			attempt++;
			return attempt === 1 ? firstSave.promise : secondSave.promise;
		});
		const { editor } = createEditor({
			draft,
			callbacks: {
				requestRender: () => {},
				onEditRole: async (_role, current) => current,
				onEditAgent: async (_agent, current) => current,
				onSave: () => {},
				onSaveEmoji,
				onCancel: cancelled,
			},
		});

		editor.handleInput("\r");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		expect(onSaveEmoji).toHaveBeenCalledTimes(1);
		expect(onSaveEmoji).toHaveBeenLastCalledWith("🪙");
		expect(editor.draft.metadata.emoji).toBe("⚡");

		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		expect(onSaveEmoji).toHaveBeenCalledTimes(1);
		expect(cancelled).not.toHaveBeenCalled();

		firstSave.reject(new Error("\x1b[31mwrite\tfailed\nunsafe\x1b[0m"));
		await firstSave.promise.catch(() => undefined);
		await Promise.resolve();
		expect(editor.draft.metadata.emoji).toBe("⚡");
		expect(editor.render(80).map(stripVTControlCharacters).join("\n")).toContain("write failed unsafe");

		editor.handleInput("\r");
		expect(onSaveEmoji).toHaveBeenCalledTimes(2);
		expect(onSaveEmoji).toHaveBeenLastCalledWith("🪙");
		secondSave.resolve(true);
		await secondSave.promise;
		await Promise.resolve();
		expect(editor.draft.metadata.emoji).toBe("🪙");

		editor.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("keeps a rejected save visible and accepts a later retry", async () => {
		const saved: ProfileDraft[] = [];
		let attempts = 0;
		const { editor } = createEditor({
			callbacks: {
				requestRender: () => {},
				onEditRole: async (_role, draft) => draft,
				onEditAgent: async (_agent, draft) => draft,
				onSave: draft => {
					attempts++;
					if (attempts === 1) throw new Error("disk\tfull");
					saved.push(draft);
				},
				onCancel: () => {},
			},
		});

		editor.handleInput("\x13");
		await Promise.resolve();
		expect(editor.render(120).map(stripVTControlCharacters).join("\n")).toContain("disk full");
		editor.handleInput("\x13");
		await Promise.resolve();
		expect(saved).toHaveLength(1);
	});

	test("supports save-as-new and the labelled export continuation", async () => {
		const fresh = createEditor();
		typeText(fresh.editor, "save as new");
		fresh.editor.handleInput("\r");
		await Promise.resolve();
		expect(fresh.saved).toEqual([{ draft: modelsOnlyDraft(), saveAsNew: true }]);

		const exported = createEditor({
			title: "Prepare profile export",
			saveLabel: "Continue to export",
			allowSaveAsNew: false,
		});
		typeText(exported.editor, "continue to export");
		exported.editor.handleInput("\r");
		await Promise.resolve();
		expect(exported.saved).toEqual([{ draft: modelsOnlyDraft(), saveAsNew: false }]);
	});
});

describe("profile emoji picker geometry", () => {
	test("keeps every label separated from its original emoji token and previews the actual profile name", () => {
		let selected: ProfileEmoji | undefined;
		const picker = new ProfileEmojiPicker({
			name: "Local coding",
			terminalHeight: 40,
			requestRender: () => {},
			onSelect: value => {
				selected = value;
			},
			onCancel: () => {},
		});
		const plainLines = picker.render(80).map(stripVTControlCharacters);
		for (const line of plainLines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		expect(plainLines.join("\n")).toContain("Local coding");

		const noneLine = plainLines.find(line => line.includes("None"))!;
		const labelColumn = Bun.stringWidth(noneLine.slice(0, noneLine.indexOf("None")));
		const iconColumns = PROFILE_EMOJIS.map(item => {
			const line = plainLines.find(candidate => candidate.includes(item.label) && candidate.includes(item.emoji))!;
			const labelEnd = line.indexOf(item.label) + item.label.length;
			const iconIndex = line.indexOf(item.emoji, labelEnd);
			expect(line.slice(labelEnd, iconIndex)).toMatch(/^ {2,}$/);
			expect(Bun.stringWidth(line.slice(0, line.indexOf(item.label)))).toBe(labelColumn);
			return Bun.stringWidth(line.slice(0, iconIndex));
		});
		expect(new Set(iconColumns).size).toBe(1);

		const narrowLines = picker.render(16).map(stripVTControlCharacters);
		const narrowIconColumns = PROFILE_EMOJIS.map(item => {
			const line = narrowLines.find(candidate => candidate.includes(item.emoji))!;
			return Bun.stringWidth(line.slice(0, line.indexOf(item.emoji)));
		});
		expect(new Set(narrowIconColumns).size).toBe(1);
		for (const line of narrowLines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(16);

		for (let index = 0; index < 5; index++) picker.handleInput("\x1b[B");
		const selectedLines = picker.render(80).map(stripVTControlCharacters);
		const localLine = selectedLines.find(line => line.includes("Local") && line.includes("🖥️"))!;
		expect(Bun.stringWidth(localLine.slice(0, localLine.indexOf("🖥️")))).toBe(iconColumns[0]);
		picker.handleInput("\r");
		expect(selected).toBe("🖥️");
	});
});
