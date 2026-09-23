import {
	type Component,
	Ellipsis,
	matchesKey,
	parseSgrMouse,
	replaceTabs,
	ScrollView,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { bottomBorder, divider, row, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";

export interface ProfileImportPreviewOptions {
	title: string;
	entries: readonly { label: string; description: string }[];
	nextStep: string;
	terminalHeight?: number;
	onContinue(): void;
	onCancel(): void;
	requestRender(): void;
}

type PreviewAction = "continue" | "cancel";

interface ActionZone {
	action: PreviewAction;
	line: number;
	start: number;
	end: number;
}

interface ActionRow {
	text: string;
	zones: Array<Omit<ActionZone, "line">>;
}

function cleanSingleLine(value: unknown): string {
	const sanitized = replaceTabs(sanitizeText(String(value ?? "")));
	return oneLineLabel(sanitized, sanitized.length || 1);
}

function wrapPreservingParagraphs(value: unknown, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of replaceTabs(sanitizeText(String(value ?? "")))
		.trim()
		.split("\n")) {
		const safeParagraph = oneLineLabel(paragraph, paragraph.length || 1);
		const wrapped = wrapTextWithAnsi(safeParagraph, Math.max(1, width));
		lines.push(...(wrapped.length > 0 ? wrapped : [""]));
	}
	return lines.length > 0 ? lines : [""];
}

/** Full-screen, read-only review shown before a profile import advances to resolution and naming. */
export class ProfileImportPreview implements Component {
	readonly #options: ProfileImportPreviewOptions;
	readonly #review = new ScrollView([], {
		height: 1,
		scrollbar: "always",
		ellipsis: Ellipsis.Omit,
		theme: {
			track: text => theme.fg("muted", text),
			thumb: text => theme.fg("accent", text),
		},
	});
	#focusedAction: PreviewAction = "continue";
	#actionZones: ActionZone[] = [];
	#reviewRowStart = 0;
	#reviewHeight = 0;
	#settled = false;

	constructor(options: ProfileImportPreviewOptions) {
		this.#options = options;
	}

	invalidate(): void {
		this.#review.invalidate();
	}

	dispose(): void {
		this.#settled = true;
		this.#review.dispose();
	}

	render(width: number, allocatedHeight?: number): readonly string[] {
		const safeWidth = Math.max(0, Math.trunc(width));
		const height = Math.max(
			0,
			Math.trunc(allocatedHeight ?? this.#options.terminalHeight ?? process.stdout.rows ?? 24),
		);
		this.#actionZones = [];
		this.#reviewRowStart = 0;
		this.#reviewHeight = 0;
		if (height === 0) return [];
		if (safeWidth === 0) return Array.from({ length: height }, () => "");

		const innerWidth = Math.max(0, safeWidth - 4);
		const actionRows = this.#renderActionRows(innerWidth);
		const hint =
			innerWidth >= 64
				? "Enter to activate · Ctrl+S to continue · Tab to switch · Esc to cancel · ↑/↓/PgUp/PgDn/wheel to review"
				: innerWidth >= 28
					? "Enter to activate · Ctrl+S to continue · Tab to switch · Esc to cancel"
					: "Enter · Ctrl+S · Tab · Esc";
		const hintLines = wrapTextWithAnsi(hint, Math.max(1, innerWidth)).map(line => theme.fg("dim", line));

		const roomAfterChromeAndActions = Math.max(0, height - 2 - actionRows.length);
		const dividerRows = roomAfterChromeAndActions >= 2 ? 1 : 0;
		const hintCapacity = Math.max(0, roomAfterChromeAndActions - dividerRows - 1);
		const shownHints = hintLines.slice(0, hintCapacity);
		const reviewHeight = Math.max(0, roomAfterChromeAndActions - dividerRows - shownHints.length);
		const reviewWidth = Math.max(0, innerWidth - 1);
		this.#review.setLines(this.#reviewLines(Math.max(1, reviewWidth)));
		this.#review.setHeight(reviewHeight);

		const lines: string[] = [topBorder(safeWidth, cleanSingleLine(this.#options.title) || "Import profile")];
		this.#reviewRowStart = lines.length;
		this.#reviewHeight = reviewHeight;
		const visibleReview = this.#review.render(innerWidth);
		for (let index = 0; index < reviewHeight; index++) lines.push(row(visibleReview[index] ?? "", safeWidth));
		if (dividerRows > 0) lines.push(divider(safeWidth));
		for (const actionRow of actionRows) {
			const line = lines.length;
			lines.push(row(actionRow.text, safeWidth));
			for (const zone of actionRow.zones) {
				this.#actionZones.push({ ...zone, line, start: zone.start + 2, end: zone.end + 2 });
			}
		}
		for (const hintLine of shownHints) lines.push(row(hintLine, safeWidth));
		lines.push(bottomBorder(safeWidth));

		while (lines.length < height) lines.splice(lines.length - 1, 0, row("", safeWidth));
		return lines.slice(0, height).map(line => truncateToWidth(line, safeWidth, Ellipsis.Omit));
	}

	handleInput(data: string): void {
		if (this.#settled) return;
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (!event) return;
			if (
				event.wheel !== null &&
				event.row >= this.#reviewRowStart &&
				event.row < this.#reviewRowStart + this.#reviewHeight
			) {
				const before = this.#review.getScrollOffset();
				this.#review.scroll(event.wheel);
				if (this.#review.getScrollOffset() !== before) this.#options.requestRender();
				return;
			}
			if (!event.leftClick) return;
			const zone = this.#actionZones.find(
				candidate => candidate.line === event.row && event.col >= candidate.start && event.col < candidate.end,
			);
			if (zone) this.#activate(zone.action);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#activate("cancel");
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.#activate("continue");
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focusedAction = this.#focusedAction === "continue" ? "cancel" : "continue";
			this.#options.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || data === "\r") {
			this.#activate(this.#focusedAction);
			return;
		}
		const before = this.#review.getScrollOffset();
		if (this.#review.handleScrollKey(data) && this.#review.getScrollOffset() !== before) {
			this.#options.requestRender();
		}
	}

	#reviewLines(width: number): string[] {
		const lines = [theme.bold(theme.fg("accent", "Next step"))];
		lines.push(...wrapPreservingParagraphs(this.#options.nextStep, width));
		if (this.#options.entries.length > 0) lines.push("");
		for (let index = 0; index < this.#options.entries.length; index++) {
			const entry = this.#options.entries[index]!;
			const label = cleanSingleLine(entry.label);
			for (const line of wrapPreservingParagraphs(`${index + 1}. ${label}`, width)) {
				lines.push(theme.bold(theme.fg("accent", line)));
			}
			const descriptionWidth = width >= 3 ? width - 2 : width;
			const indent = width >= 3 ? "  " : "";
			for (const line of wrapPreservingParagraphs(entry.description, descriptionWidth))
				lines.push(`${indent}${line}`);
			if (index < this.#options.entries.length - 1) lines.push("");
		}
		return lines;
	}

	#renderActionRows(width: number): ActionRow[] {
		const makeButton = (action: PreviewAction, label: string): { text: string; width: number } => {
			const plain = `[ ${label} ]`;
			return {
				text: this.#focusedAction === action ? theme.inverse(theme.bold(plain)) : theme.fg("dim", plain),
				width: visibleWidth(plain),
			};
		};
		const continueButton = makeButton("continue", "Continue");
		const cancelButton = makeButton("cancel", "Cancel");
		if (continueButton.width + 2 + cancelButton.width <= width) {
			return [
				{
					text: `${continueButton.text}  ${cancelButton.text}`,
					zones: [
						{ action: "continue", start: 0, end: continueButton.width },
						{
							action: "cancel",
							start: continueButton.width + 2,
							end: continueButton.width + 2 + cancelButton.width,
						},
					],
				},
			];
		}
		return [
			{
				text: continueButton.text,
				zones: width >= continueButton.width ? [{ action: "continue", start: 0, end: continueButton.width }] : [],
			},
			{
				text: cancelButton.text,
				zones: width >= cancelButton.width ? [{ action: "cancel", start: 0, end: cancelButton.width }] : [],
			},
		];
	}

	#activate(action: PreviewAction): void {
		if (this.#settled) return;
		this.#settled = true;
		if (action === "continue") this.#options.onContinue();
		else this.#options.onCancel();
	}
}
