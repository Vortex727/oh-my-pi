import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	ProfileImportPreview,
	type ProfileImportPreviewOptions,
} from "@oh-my-pi/pi-coding-agent/modes/components/profile-import-preview";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

function createPreview(overrides: Partial<ProfileImportPreviewOptions> = {}) {
	const onContinue = vi.fn();
	const onCancel = vi.fn();
	const requestRender = vi.fn();
	const preview = new ProfileImportPreview({
		title: "Review imported profile",
		entries: [{ label: "Model role", description: "Uses the imported selector" }],
		nextStep: "Resolve compatibility, then choose the saved profile name.",
		terminalHeight: 24,
		onContinue,
		onCancel,
		requestRender,
		...overrides,
	});
	return { preview, onContinue, onCancel, requestRender };
}

function plainLines(preview: ProfileImportPreview, width: number): string[] {
	return preview.render(width).map(stripVTControlCharacters);
}

function clickLabel(preview: ProfileImportPreview, width: number, label: string): void {
	const lines = plainLines(preview, width);
	const line = lines.findIndex(candidate => candidate.includes(label));
	const col = lines[line]?.indexOf(label) ?? -1;
	expect(line).toBeGreaterThanOrEqual(0);
	expect(col).toBeGreaterThanOrEqual(0);
	preview.handleInput(`\x1b[<0;${col + 1};${line + 1}M`);
}

describe("profile import preview", () => {
	test("keeps continuation pinned while every long review entry remains scrollable", () => {
		const entries = Array.from({ length: 28 }, (_, index) => ({
			label: `Imported item ${index}`,
			description: `description-${index} ${"wrapped detail ".repeat(5)}`,
		}));
		const { preview, onContinue, onCancel, requestRender } = createPreview({ entries });
		let lines = plainLines(preview, 80);
		expect(lines.join("\n")).toContain("[ Continue ]");
		expect(lines.join("\n")).not.toContain("description-27");

		let visited = lines.join("\n");
		preview.handleInput("\x1b[B");
		preview.handleInput("\x1b[A");
		preview.handleInput("\x1b[5~");
		preview.handleInput("\x1b[<65;3;3M");
		for (let page = 0; page < 40; page++) {
			preview.handleInput("\x1b[6~");
			lines = plainLines(preview, 80);
			expect(lines.join("\n")).toContain("[ Continue ]");
			visited += `\n${lines.join("\n")}`;
		}
		for (let index = 0; index < entries.length; index++) expect(visited).toContain(`description-${index}`);
		expect(requestRender).toHaveBeenCalled();
		expect(onContinue).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		preview.handleInput("\r");
		preview.handleInput("\r");
		preview.handleInput("\x13");
		preview.handleInput("\x1b");
		expect(onContinue).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	test("activates only the focused or safely clicked action", () => {
		const defaultAction = createPreview();
		defaultAction.preview.handleInput("\r");
		expect(defaultAction.onContinue).toHaveBeenCalledTimes(1);
		expect(defaultAction.onCancel).not.toHaveBeenCalled();

		const keyboardCancel = createPreview();
		keyboardCancel.preview.handleInput("\x1b[Z");
		keyboardCancel.preview.handleInput("\r");
		keyboardCancel.preview.handleInput("\x1b");
		expect(keyboardCancel.onCancel).toHaveBeenCalledTimes(1);
		expect(keyboardCancel.onContinue).not.toHaveBeenCalled();

		const escapeCancel = createPreview();
		escapeCancel.preview.handleInput("\x1b");
		expect(escapeCancel.onCancel).toHaveBeenCalledTimes(1);
		expect(escapeCancel.onContinue).not.toHaveBeenCalled();

		const shortcut = createPreview();
		shortcut.preview.handleInput("\t");
		shortcut.preview.handleInput("\x13");
		expect(shortcut.onContinue).toHaveBeenCalledTimes(1);
		expect(shortcut.onCancel).not.toHaveBeenCalled();

		const mouseContinue = createPreview();
		const continueLines = plainLines(mouseContinue.preview, 80);
		const continueRow = continueLines.findIndex(line => line.includes("[ Continue ]"));
		mouseContinue.preview.handleInput(`\x1b[<0;1;${continueRow + 1}M`);
		expect(mouseContinue.onContinue).not.toHaveBeenCalled();
		clickLabel(mouseContinue.preview, 80, "[ Continue ]");
		clickLabel(mouseContinue.preview, 80, "[ Continue ]");
		expect(mouseContinue.onContinue).toHaveBeenCalledTimes(1);
		expect(mouseContinue.onCancel).not.toHaveBeenCalled();

		const mouseCancel = createPreview();
		clickLabel(mouseCancel.preview, 80, "[ Cancel ]");
		expect(mouseCancel.onCancel).toHaveBeenCalledTimes(1);
		expect(mouseCancel.onContinue).not.toHaveBeenCalled();
	});

	test("renders imported selectors without Unicode format controls", () => {
		const artifactSelector = "openai/\u202Egpt-5.6\u200B-mini";
		const { preview } = createPreview({
			entries: [
				{
					label: `Role default — Ready — ${artifactSelector}`,
					description: "Imported model-role assignment",
				},
			],
		});

		const renderedRow = plainLines(preview, 100).find(line => line.includes("Role default"));
		expect(renderedRow).toContain("Role default — Ready — openai/ gpt-5.6 -mini");
		expect(renderedRow).not.toMatch(/[\u202E\u200B]/u);
	});

	test("bounds and sanitizes the full overlay at wide and narrow terminal sizes", () => {
		const cases = [
			{ width: 120, height: 24 },
			{ width: 80, height: 24 },
			{ width: 24, height: 12 },
			{ width: 16, height: 10 },
		];
		for (const { width, height } of cases) {
			const { preview } = createPreview({
				title: "Review\nimport\x1b[2J",
				terminalHeight: height,
				entries: [
					{
						label: "Unsafe\tlabel\x1b[31m red\ncontinued",
						description: `start\tmiddle ${"long imported description ".repeat(12)}z9tail\x1b[2J`,
					},
				],
			});
			const initial = plainLines(preview, width);
			expect(initial).toHaveLength(height);
			for (const line of initial) {
				expect(line).not.toMatch(/[\t\r\n\x1b]/);
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(initial.join("\n")).toContain("[ Continue ]");
			expect(initial.join("\n")).toContain("[ Cancel ]");
			for (let page = 0; page < 80; page++) preview.handleInput("\x1b[6~");
			const tail = plainLines(preview, width);
			expect(tail).toHaveLength(height);
			for (const line of tail) {
				expect(line).not.toMatch(/[\t\r\n\x1b]/);
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
			const visited = `${initial.join("\n")}\n${tail.join("\n")}`;
			expect(tail.join("\n")).toContain("[ Continue ]");
			expect(tail.join("\n")).toContain("[ Cancel ]");
			expect(visited).toContain("z9tail");
			expect(visited).not.toContain("[2J");
		}
	});
});
