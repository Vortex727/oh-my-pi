import {
	padding,
	renderTableRow,
	replaceTabs,
	type TableColumn,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import {
	formatContext,
	formatCostPair,
	formatIntelligence,
	formatModelPerformance,
} from "@oh-my-pi/pi-tui/overlays/model-browser";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { thinkingLevelGlyph } from "@oh-my-pi/pi-tui/render/render-utils";
import { getConfiguredThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	PROFILE_SETTINGS_GROUPS,
	type ProfileAgentRow,
	type ProfileRoleRow,
	type ProfileSnapshot,
} from "../../profiles/types";
import type { ProfileDashboardSetupRef } from "./profile-dashboard";

interface LabelValue {
	label: string;
	value: string;
}

function cleanLine(value: unknown): string {
	return replaceTabs(sanitizeText(String(value ?? "")))
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function wrapLines(lines: readonly string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	const wrapped: string[] = [];
	for (const line of lines) {
		if (visibleWidth(line) <= safeWidth) wrapped.push(line);
		else wrapped.push(...wrapTextWithAnsi(line, safeWidth));
	}
	return wrapped;
}

function pushIndented(lines: string[], value: string, indent: number, width: number): void {
	const safeWidth = Math.max(1, width);
	const safeIndent = Math.min(indent, Math.max(0, safeWidth - 1));
	const contentWidth = Math.max(1, safeWidth - safeIndent);
	const prefix = padding(safeIndent);
	const wrapped = wrapTextWithAnsi(value, contentWidth);
	if (wrapped.length === 0) {
		lines.push(prefix);
		return;
	}
	for (const line of wrapped) lines.push(`${prefix}${line}`);
}

interface WrappedTableCell {
	text: string;
	align?: "left" | "right";
}

function renderWrappedTableRow(
	cells: readonly WrappedTableCell[],
	widths: readonly number[],
	width: number,
	options: { indent?: string; gap?: string } = {},
): string[] {
	const columns: TableColumn[] = widths.map((columnWidth, index) => ({
		width: Math.max(1, columnWidth),
		align: cells[index]?.align ?? "left",
		overflow: "allow",
	}));
	const wrapped = cells.map((cell, index) => {
		const lines = wrapTextWithAnsi(cell.text, columns[index]?.width ?? 1);
		return lines.length > 0 ? lines : [""];
	});
	const lineCount = Math.max(1, ...wrapped.map(lines => lines.length));
	const lines: string[] = [];
	for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
		lines.push(
			renderTableRow(
				wrapped.map(lines => ({
					text: lines[lineIndex] ?? "",
				})),
				columns,
				width,
				{ ...options, fit: false },
			),
		);
	}
	return lines;
}

function renderLabelValues(entries: readonly LabelValue[], width: number): string[] {
	if (entries.length === 0) return [];
	const safeWidth = Math.max(1, width);
	const nativeLabelWidth = 30;
	let labelWidth = 0;
	for (const entry of entries) {
		const entryWidth = visibleWidth(entry.label);
		if (entryWidth <= nativeLabelWidth) labelWidth = Math.max(labelWidth, entryWidth);
	}
	const sideBySide = labelWidth > 0 && safeWidth - 2 - labelWidth - 2 >= 12;
	const prefixWidth = 2 + labelWidth + 2;
	const valueWidth = Math.max(1, safeWidth - prefixWidth);
	const lines: string[] = [];
	for (const entry of entries) {
		const plainLabel = entry.label;
		if (!sideBySide || visibleWidth(plainLabel) > labelWidth) {
			if (plainLabel) pushIndented(lines, theme.fg("muted", plainLabel), 2, safeWidth);
			pushIndented(lines, entry.value, plainLabel ? 4 : 2, safeWidth);
			continue;
		}
		const label = plainLabel ? theme.fg("muted", plainLabel) : "";
		const rowPrefix = `  ${label}${padding(labelWidth - visibleWidth(plainLabel))}  `;
		const continuation = padding(prefixWidth);
		const valueLines = wrapTextWithAnsi(entry.value, valueWidth);
		if (valueLines.length === 0) {
			lines.push(rowPrefix);
			continue;
		}
		lines.push(`${rowPrefix}${valueLines[0]}`);
		for (let index = 1; index < valueLines.length; index++) lines.push(`${continuation}${valueLines[index]}`);
	}
	return lines;
}

interface RoleFacts {
	role: string;
	identity: string;
	thinking: string;
	intelligence: string;
	performance: string;
	context: string;
	cost: string;
	narrowMetrics: readonly string[];
}

function shown(value: string): string {
	return value || theme.fg("dim", "—");
}

function roleIdentity(role: ProfileRoleRow): string {
	const selector = cleanLine(role.selector);
	const separatorIndex = selector.indexOf("/");
	const model = cleanLine(role.modelId ?? (separatorIndex >= 0 ? selector.slice(separatorIndex + 1) : selector));
	const provider = cleanLine(role.provider ?? (separatorIndex >= 0 ? selector.slice(0, separatorIndex) : ""));
	const plainTarget = provider ? `${provider}/${model}` : model;
	let target: string;
	let alias = "";
	if (model || provider) {
		target = role.automatic
			? theme.fg("dim", `auto → ${plainTarget}`)
			: provider
				? `${theme.fg("dim", `${provider}/`)}${model}`
				: model;
		const canonicalSelector = formatModelSelectorValue(plainTarget, role.thinkingLevel);
		if (selector && selector !== plainTarget && selector !== canonicalSelector) {
			alias = theme.fg("dim", ` ← ${selector}`);
		}
	} else {
		target = theme.fg("dim", "—");
	}
	const dot = theme.fg(
		role.warning ? "warning" : role.automatic ? "dim" : "success",
		role.automatic ? theme.status.shadowed : theme.status.enabled,
	);
	return `${dot} ${target}${alias}`;
}

function roleFacts(role: ProfileRoleRow): RoleFacts {
	let thinking = "";
	if (role.thinkingLevel !== undefined) {
		const glyph = thinkingLevelGlyph(role.thinkingLevel, theme);
		const label = getConfiguredThinkingLevelMetadata(role.thinkingLevel).label;
		thinking = glyph ? `${glyph} ${label}` : label;
	}
	const intelligence = formatIntelligence(role);
	const performance = formatModelPerformance(role, role.perf);
	const context = formatContext(role);
	const cost = role.cost ? formatCostPair(role) : "";
	return {
		role: cleanLine(role.role),
		identity: roleIdentity(role),
		thinking: shown(thinking),
		intelligence: shown(intelligence),
		performance: shown(performance),
		context: shown(context),
		cost: shown(cost),
		narrowMetrics: [
			...(thinking ? [`Think ${thinking}`] : []),
			...(intelligence ? [`Int ${intelligence}`] : []),
			...(performance ? [`TTFT · t/s ${performance}`] : []),
			...(context ? [`Ctx ${context}`] : []),
			...(cost ? [`$ in/out ${cost}`] : []),
		],
	};
}

function maxCellWidth(values: readonly string[], minimum: number, maximum: number): number {
	let natural = minimum;
	for (const value of values) natural = Math.max(natural, visibleWidth(value));
	return Math.min(maximum, natural);
}

function renderWideRoles(facts: readonly RoleFacts[], width: number): string[] | undefined {
	const gap = "  ";
	const indent = "  ";
	const roleWidth = maxCellWidth(["Role", ...facts.map(fact => fact.role)], 8, 16);
	const thinkingWidth = maxCellWidth(["Think", ...facts.map(fact => fact.thinking)], 7, 16);
	const intelligenceWidth = maxCellWidth(["Int", ...facts.map(fact => fact.intelligence)], 3, 6);
	const performanceWidth = maxCellWidth(["TTFT · t/s", ...facts.map(fact => fact.performance)], 10, 14);
	const contextWidth = maxCellWidth(["Ctx", ...facts.map(fact => fact.context)], 3, 10);
	const costWidth = maxCellWidth(["$ in/out", ...facts.map(fact => fact.cost)], 8, 18);
	const fixedWidth = roleWidth + thinkingWidth + intelligenceWidth + performanceWidth + contextWidth + costWidth;
	const identityWidth = width - visibleWidth(indent) - visibleWidth(gap) * 6 - fixedWidth;
	if (identityWidth < 32) return undefined;
	const widths = [
		roleWidth,
		identityWidth,
		thinkingWidth,
		intelligenceWidth,
		performanceWidth,
		contextWidth,
		costWidth,
	];
	const lines = renderWrappedTableRow(
		[
			{ text: theme.fg("muted", "Role") },
			{ text: theme.fg("muted", "Model") },
			{ text: theme.fg("muted", "Think") },
			{ text: theme.fg("muted", "Int"), align: "right" },
			{ text: theme.fg("muted", "TTFT · t/s"), align: "right" },
			{ text: theme.fg("muted", "Ctx"), align: "right" },
			{ text: theme.fg("muted", "$ in/out"), align: "right" },
		],
		widths,
		width,
		{ indent, gap },
	);
	for (const fact of facts) {
		lines.push(
			...renderWrappedTableRow(
				[
					{ text: theme.fg("muted", fact.role) },
					{ text: fact.identity },
					{ text: fact.thinking },
					{ text: fact.intelligence, align: "right" },
					{ text: fact.performance, align: "right" },
					{ text: fact.context, align: "right" },
					{ text: fact.cost, align: "right" },
				],
				widths,
				width,
				{ indent, gap },
			),
		);
	}
	return lines;
}

function renderNarrowRoles(facts: readonly RoleFacts[], width: number): string[] {
	const lines: string[] = [];
	for (const [index, fact] of facts.entries()) {
		if (index > 0) lines.push("");
		pushIndented(lines, theme.bold(fact.role), 2, width);
		pushIndented(lines, fact.identity, 4, width);
		if (fact.narrowMetrics.length > 0) {
			pushIndented(lines, fact.narrowMetrics.join(theme.fg("dim", "  ·  ")), 4, width);
		}
	}
	return lines;
}

function isEmptyRole(role: ProfileRoleRow): boolean {
	return (
		!cleanLine(role.selector) &&
		!cleanLine(role.provider) &&
		!cleanLine(role.modelId) &&
		role.thinkingLevel === undefined &&
		role.int === undefined &&
		role.tps === undefined &&
		role.contextWindow === undefined &&
		role.perf === undefined &&
		role.cost === undefined &&
		!cleanLine(role.warning)
	);
}

function renderRoleWarnings(roles: readonly ProfileRoleRow[], width: number): string[] {
	const grouped = new Map<string, string[]>();
	for (const role of roles) {
		const warning = cleanLine(role.warning);
		if (!warning) continue;
		const names = grouped.get(warning) ?? [];
		const name = cleanLine(role.role) || "Unnamed role";
		if (!names.includes(name)) names.push(name);
		grouped.set(warning, names);
	}
	const lines: string[] = [];
	for (const [warning, names] of grouped) {
		pushIndented(lines, theme.fg("warning", `${theme.status.warning} ${names.join(", ")}: ${warning}`), 2, width);
	}
	return lines;
}

function renderRoles(roles: readonly ProfileRoleRow[], warnings: readonly string[], width: number): string[] {
	const lines: string[] = [];
	const snapshotWarnings = [...new Set(warnings.map(cleanLine).filter(Boolean))];
	for (const warning of snapshotWarnings) {
		pushIndented(lines, theme.fg("warning", `${theme.status.warning} ${warning}`), 2, width);
	}
	if (roles.length === 0) {
		if (snapshotWarnings.length > 0) lines.push("");
		lines.push(theme.fg("dim", "No roles assigned"));
		return lines;
	}

	const visibleRoles = roles.filter(role => !isEmptyRole(role));
	const emptyRoleNames = roles.filter(isEmptyRole).map(role => cleanLine(role.role) || "Unnamed role");
	if (snapshotWarnings.length > 0 && (visibleRoles.length > 0 || emptyRoleNames.length > 0)) lines.push("");
	if (visibleRoles.length > 0) {
		const facts = visibleRoles.map(roleFacts);
		lines.push(...(renderWideRoles(facts, width) ?? renderNarrowRoles(facts, width)));
	}
	if (emptyRoleNames.length > 0) {
		if (visibleRoles.length > 0) lines.push("");
		pushIndented(lines, theme.fg("dim", `No model assigned: ${emptyRoleNames.join(", ")}`), 2, width);
	}
	const roleWarnings = renderRoleWarnings(roles, width);
	if (roleWarnings.length > 0) {
		if (visibleRoles.length > 0 || emptyRoleNames.length > 0) lines.push("");
		lines.push(...roleWarnings);
	}
	if (visibleRoles.some(role => role.cost)) lines.push(theme.fg("dim", "$ input/output per 1M tokens"));
	return wrapLines(lines, width);
}

function agentAssignment(agent: ProfileAgentRow): string {
	const selector = cleanLine(agent.selector);
	const provider = cleanLine(agent.provider);
	const model = cleanLine(agent.modelId);
	let target = "";
	let targetPlain = "";
	if (provider && model) {
		targetPlain = `${provider}/${model}`;
		target = `${theme.fg("dim", `${provider}/`)}${model}`;
	} else if (model || provider) {
		targetPlain = model || provider;
		target = targetPlain;
	}
	const canonicalSelector = targetPlain ? formatModelSelectorValue(targetPlain, agent.thinkingLevel) : "";
	if (selector && selector !== targetPlain && selector !== canonicalSelector) {
		target = target ? `${target}${theme.fg("dim", ` ← ${selector}`)}` : selector;
	}
	return target || theme.fg("dim", "Fallback: default role");
}

function renderAgents(snapshot: ProfileSnapshot, width: number): string[] {
	if (snapshot.agents.length === 0) return [theme.fg("dim", "No agent assignments")];
	const entries: LabelValue[] = [];
	for (const agent of snapshot.agents) {
		const statusLabel = agent.enabled ? "enabled" : "disabled";
		const statusColor = agent.warning ? "warning" : agent.enabled ? "success" : "dim";
		let thinking = "—";
		if (agent.thinkingLevel !== undefined) {
			const glyph = thinkingLevelGlyph(agent.thinkingLevel, theme);
			const label = getConfiguredThinkingLevelMetadata(agent.thinkingLevel).label;
			thinking = glyph ? `${glyph} ${label}` : label;
		}
		const assignment = agentAssignment(agent);
		const state = theme.fg(statusColor, statusLabel);
		const sourceAndThinking = theme.fg("dim", `${cleanLine(agent.source) || "unknown"} · ${thinking}`);
		entries.push({
			label: cleanLine(agent.name),
			value: `${assignment} · ${state} · ${sourceAndThinking}`,
		});
		if (agent.warning) {
			entries.push({
				label: "",
				value: theme.fg("warning", `${theme.status.warning} ${cleanLine(agent.warning)}`),
			});
		}
	}
	return renderLabelValues(entries, width);
}

function renderSettingsMemory(setup: ProfileDashboardSetupRef, snapshot: ProfileSnapshot, width: number): string[] {
	const entries: LabelValue[] = [];
	if (setup.kind === "current") {
		entries.push({
			label: "Settings",
			value: theme.fg("muted", `${theme.status.info} All settings groups · current session`),
		});
	} else {
		const included = new Set(setup.metadata?.enabledGroups ?? []);
		const includedLabels = PROFILE_SETTINGS_GROUPS.filter(group => included.has(group.id)).map(group =>
			cleanLine(group.label),
		);
		const inheritedLabels = PROFILE_SETTINGS_GROUPS.filter(group => !included.has(group.id)).map(group =>
			cleanLine(group.label),
		);
		entries.push(
			{
				label: "Included",
				value:
					includedLabels.length > 0
						? theme.fg("success", `${theme.status.enabled} ${includedLabels.join(", ")}`)
						: theme.fg("dim", "None"),
			},
			{
				label: "Inherited",
				value:
					inheritedLabels.length > 0
						? theme.fg("dim", `${theme.status.shadowed} ${inheritedLabels.join(", ")}`)
						: theme.fg("dim", "None"),
			},
		);
	}
	entries.push(
		{ label: "Memory", value: cleanLine(snapshot.memory.backend) },
		...(snapshot.memory.scope ? [{ label: "Scope", value: cleanLine(snapshot.memory.scope) }] : []),
		{ label: "Storage", value: cleanLine(snapshot.memory.storageLabel) },
	);
	return renderLabelValues(entries, width);
}

function renderSplitBlocks(left: readonly string[], right: readonly string[], leftWidth: number): string[] {
	const separator = theme.fg("dim", " │ ");
	const lines: string[] = [];
	const rowCount = Math.max(left.length, right.length);
	for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
		const leftLine = left[rowIndex] ?? "";
		const rightLine = right[rowIndex] ?? "";
		lines.push(`${leftLine}${padding(Math.max(0, leftWidth - visibleWidth(leftLine)))}${separator}${rightLine}`);
	}
	return lines;
}
function sectionHeading(label: string): string {
	return theme.bold(theme.fg("accent", cleanLine(label)));
}

export function buildProfilePreviewOverview(options: {
	setup: ProfileDashboardSetupRef;
	snapshot: ProfileSnapshot;
	width: number;
	/** This session's account usage report, rendered for a width; shown last. */
	usage?: (width: number) => string;
}): string[] {
	const { setup, snapshot } = options;
	const width = Math.max(1, options.width);
	const lines: string[] = [sectionHeading("Models"), ...renderRoles(snapshot.roles, snapshot.warnings, width), ""];

	if (width >= 83) {
		const availableWidth = width - 3;
		const settingsWidth = Math.max(40, Math.floor(availableWidth / 3));
		const agentsWidth = availableWidth - settingsWidth;
		const agents = [sectionHeading("Agents"), ...renderAgents(snapshot, agentsWidth)];
		const settings = [sectionHeading("Settings & memory"), ...renderSettingsMemory(setup, snapshot, settingsWidth)];
		lines.push(...renderSplitBlocks(agents, settings, agentsWidth));
	} else {
		lines.push(
			sectionHeading("Agents"),
			...renderAgents(snapshot, width),
			"",
			sectionHeading("Settings & memory"),
			...renderSettingsMemory(setup, snapshot, width),
		);
	}
	if (options.usage) lines.push("", ...options.usage(width).split("\n"));

	return wrapLines(lines, width);
}
