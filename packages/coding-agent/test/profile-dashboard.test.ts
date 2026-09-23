import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	ProfileDashboard,
	type ProfileDashboardSetupRef,
} from "@oh-my-pi/pi-coding-agent/modes/components/profile-dashboard";
import { ProfileEditorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/profile-editor";
import { ProfileImportPreview } from "@oh-my-pi/pi-coding-agent/modes/components/profile-import-preview";
import { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import * as usageCli from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as profileClient from "@oh-my-pi/pi-coding-agent/profiles/client";
import * as profileSnapshots from "@oh-my-pi/pi-coding-agent/profiles/snapshot";
import { serializeProfile } from "@oh-my-pi/pi-coding-agent/profiles/profile-sharing";
import * as profileSetups from "@oh-my-pi/pi-coding-agent/profiles/setups";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ModelRoleAssignments, ProfileDraft, ProfileSnapshot } from "@oh-my-pi/pi-coding-agent/profiles/types";
import {
	projectProfileUsage,
	projectProfileUsageSharing,
	sanitizeProfileUsageSnapshot,
} from "@oh-my-pi/pi-coding-agent/profiles/usage";
import type { Component } from "@oh-my-pi/pi-tui";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const CURRENT_SETUP = { kind: "current" } as const satisfies ProfileDashboardSetupRef;

function savedSetup(name: string): ProfileDashboardSetupRef {
	return { kind: "saved", name };
}

function profileRole(draft: ProfileDraft, role: string): string | null | undefined {
	const roles = draft.config.modelRoles as ModelRoleAssignments;
	return roles[role];
}

function limit(provider: string, windowId: string, fraction: number, durationMs: number): UsageLimit {
	return {
		id: windowId,
		label: windowId,
		scope: { provider, windowId, shared: true },
		window: { id: windowId, label: windowId, durationMs, resetsAt: NOW + durationMs },
		amount: { unit: "percent", usedFraction: fraction },
	};
}

function snapshot(profile: string, reports?: UsageReport[]): ProfileSnapshot {
	return {
		profile,
		generatedAt: NOW,
		agentDir: "/fixture/profiles/agent",
		credentialSources: { anthropic: "local store" },
		roles: [
			{
				role: "default",
				selector: "anthropic/fixture-model",
				provider: "anthropic",
				modelId: "fixture-model",
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				automatic: false,
			},
		],
		agents: [],
		memory: { backend: "off", storageLabel: "Profile-local default storage" },
		settings: [],
		warnings: [],
		...(reports ? { usage: { generatedAt: NOW, reports, accountsWithoutUsage: [], capacity: {} } } : {}),
	};
}

function quotaReport(provider = "anthropic"): UsageReport {
	return {
		provider,
		fetchedAt: NOW,
		metadata: { accountId: "fixture-account", orgId: "fixture-org" },
		limits: [limit(provider, "5h", 0.18, 5 * HOUR), limit(provider, "7d", 0.36, 7 * 24 * HOUR)],
	};
}

function setup(height = 24, savedSetupNames: readonly string[] = ["beta"]) {
	const actions: string[] = [];
	const setups = [CURRENT_SETUP, ...savedSetupNames.map(savedSetup)];
	const label = (value: ProfileDashboardSetupRef): string =>
		value.kind === "current" ? "current" : `saved:${value.name}`;
	const dashboard = new ProfileDashboard({
		setups,
		terminalHeight: height,
		callbacks: {
			requestRender: () => {},
			close: () => actions.push("close"),
			selected: value => actions.push(`select:${label(value)}`),
			loadSetup: value => {
				actions.push(`load:${value.name}`);
			},
			saveCurrentSetup: () => {
				actions.push("save");
			},
			importRoles: () => {
				actions.push("import-roles");
			},
			exportRoles: value => {
				actions.push(`export-roles:${label(value)}`);
			},
			deleteSetup: value => {
				actions.push(`delete:${value.name}`);
			},
			renameSetup: value => {
				actions.push(`rename:${value.name}`);
			},
			editProfile: value => {
				actions.push(`edit-profile:${label(value)}`);
			},
			openActiveControl: control => actions.push(`control:${control}`),
		},
	});
	for (const value of setups) {
		const profile = value.kind === "current" ? "anthropic" : value.name;
		dashboard.setSetupState(value, {
			snapshot: snapshot(profile, value.kind === "current" ? [quotaReport()] : undefined),
			loading: false,
		});
	}
	return { dashboard, actions };
}

function snapshotWithAgentAssignments(profile: string): ProfileSnapshot {
	const value = snapshot(profile);
	value.agents = [
		{
			name: "scout",
			enabled: true,
			source: "bundled",
			selector: "anthropic/claude-haiku-4-5:low",
			provider: "anthropic",
			modelId: "claude-haiku-4-5",
			thinkingLevel: ThinkingLevel.Low,
		},
		{
			name: "reviewer",
			enabled: true,
			source: "profile",
			selector: "openai-codex/gpt-5.6-sol:high",
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: ThinkingLevel.High,
		},
		{
			name: "security-reviewer",
			enabled: false,
			source: "project",
			selector: "missing/security-model",
			warning: "Model selection is unresolved",
		},
		{
			name: "task",
			enabled: true,
			source: "bundled",
			selector: "fast-task",
			provider: "google",
			modelId: "gemini-3-flash",
			thinkingLevel: ThinkingLevel.Medium,
		},
		{
			name: "sonic",
			enabled: true,
			source: "user",
			selector: "openai/gpt-5.6-mini",
			provider: "openai",
			modelId: "gpt-5.6-mini",
		},
	];
	return value;
}

function plain(dashboard: ProfileDashboard, width = 80): string {
	return dashboard.render(width).map(stripVTControlCharacters).join("\n");
}

function clickRenderedHint(dashboard: ProfileDashboard, width: number, text: string): void {
	const lines = dashboard.render(width).map(stripVTControlCharacters);
	const line = lines.findIndex(value => value.includes(text));
	if (line < 0) throw new Error(`Expected rendered footer action: ${text}`);
	const col = lines[line]!.indexOf(text);
	dashboard.handleInput(`\x1b[<0;${col + 1};${line + 1}M`);
}

function mouseEvent(button: 0 | 64 | 65, col: number, row: number): string {
	return `\x1b[<${button};${col + 1};${row + 1}M`;
}

function splitDividerColumn(lines: readonly string[]): number {
	for (const line of lines) {
		const setupIndex = line.indexOf("Current setup");
		if (setupIndex < 0) continue;
		const dividerIndex = line.indexOf("│", setupIndex + "Current setup".length);
		if (dividerIndex < 0) continue;
		return Bun.stringWidth(line.slice(0, dividerIndex));
	}
	throw new Error("Expected the setup list and preview to be separated");
}

function pageOverviewUntil(
	dashboard: ProfileDashboard,
	width: number,
	height: number,
	target: string,
	checkFrame?: (lines: readonly string[]) => void,
): string {
	const pages: string[] = [];
	let previous = "";
	while (true) {
		const lines = dashboard.render(width, height).map(stripVTControlCharacters);
		checkFrame?.(lines);
		const current = lines.join("\n");
		if (current === previous) throw new Error(`Overview stopped before rendering ${target}`);
		pages.push(current);
		if (current.includes(target)) return pages.join("\n");
		previous = current;
		dashboard.handleInput("\x1b[6~");
	}
}

function moveOverviewToStart(dashboard: ProfileDashboard, width: number, height: number): void {
	while (true) {
		const before = dashboard.render(width, height).map(stripVTControlCharacters).join("\n");
		dashboard.handleInput("\x1b[5~");
		const after = dashboard.render(width, height).map(stripVTControlCharacters).join("\n");
		if (after === before) return;
	}
}

beforeAll(async () => {
	await initTheme(false);
});

describe("profile dashboard interaction boundaries", () => {
	test("pages one overview from models through usage while keeping the selected profile pinned", () => {
		const { dashboard, actions } = setup(18, ["beta"]);
		const profile = snapshotWithAgentAssignments("beta");
		const reports = ["anthropic", "google"].map((provider, index) => {
			const report = quotaReport(provider);
			report.notes = [`${provider} usage detail ${index + 1}`];
			return report;
		});
		profile.usage = { generatedAt: NOW, reports, accountsWithoutUsage: [], capacity: {} };
		dashboard.setSetupState(savedSetup("beta"), { snapshot: profile, loading: false });
		dashboard.handleInput("\x1b[B");
		dashboard.handleInput("\t");

		const width = 96;
		const height = 18;
		const overview = pageOverviewUntil(dashboard, width, height, "google usage detail 2", lines => {
			expect(lines).toHaveLength(height);
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			const rightPane = lines
				.map(line => {
					const divider = line.indexOf("│");
					return divider < 0 ? "" : line.slice(divider + 1);
				})
				.join("\n");
			expect(rightPane).toContain("beta");
			expect(rightPane).toContain("Saved profile");
			expect(dashboard.selectedSetup).toEqual(savedSetup("beta"));
		});
		for (const section of ["Models", "Agents", "Settings & memory", "Usage & limits"]) {
			expect(overview).toContain(section);
		}
		expect(overview).toContain("fixture-model");
		expect(overview).toContain("scout");
		expect(overview).toContain("Anthropic");
		expect(overview).toContain("Google");
		expect(actions).toEqual(["select:saved:beta"]);

		const compact = setup(11, []).dashboard;
		compact.setActionNotice("Saved\tprofile\nwithout extra rows", "success");
		const compactLines = compact.render(80, 11);
		expect(compactLines).toHaveLength(11);
		expect(compactLines.map(stripVTControlCharacters).join("\n")).toContain("Saved profile without extra rows");
		for (const line of compactLines) {
			expect(line).not.toMatch(/[\t\r\n]/);
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	test("keeps left pointer input in the setup list and continues one overview offset over usage", () => {
		const { dashboard, actions } = setup(24, []);
		const reports = ["anthropic", "openai", "google", "xai"].map((provider, index) => {
			const report = quotaReport(provider);
			report.notes = [`${provider} usage detail ${index + 1}`, `${provider} trailing detail ${index + 1}`];
			return report;
		});
		const profile = snapshotWithAgentAssignments("anthropic");
		profile.usage = { generatedAt: NOW, reports, accountsWithoutUsage: [], capacity: {} };
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });

		const width = 180;
		const height = 24;
		dashboard.handleInput("\t");
		pageOverviewUntil(dashboard, width, height, "Usage & limits");
		const before = dashboard.render(width, height).map(stripVTControlCharacters);
		const dividerColumn = splitDividerColumn(before);
		const usageRow = before.findLastIndex(line => line.includes("Usage & limits"));
		if (usageRow < 0) throw new Error("Expected Usage & limits in the continuous overview");
		const pointerRow = Math.min(height - 2, usageRow + 2);

		dashboard.handleInput(mouseEvent(0, dividerColumn - 1, pointerRow));
		const listFocused = dashboard.render(width, height).map(stripVTControlCharacters);
		dashboard.handleInput(mouseEvent(65, dividerColumn - 1, pointerRow));
		expect(dashboard.render(width, height).map(stripVTControlCharacters)).toEqual(listFocused);
		expect(dashboard.selectedSetup).toEqual(CURRENT_SETUP);

		dashboard.handleInput(mouseEvent(0, dividerColumn + 2, pointerRow));
		const overviewFocused = dashboard.render(width, height).map(stripVTControlCharacters);
		dashboard.handleInput(mouseEvent(65, dividerColumn + 2, pointerRow));
		const afterWheel = dashboard.render(width, height).map(stripVTControlCharacters);
		expect(afterWheel).not.toEqual(overviewFocused);
		expect(afterWheel.join("\n")).toContain("Current setup");
		expect(dashboard.selectedSetup).toEqual(CURRENT_SETUP);

		dashboard.handleInput(mouseEvent(64, dividerColumn + 2, pointerRow));
		expect(dashboard.render(width, height).map(stripVTControlCharacters)).toEqual(overviewFocused);
		expect(actions).toEqual([]);
	});

	test("keeps paged setup hit targets aligned through the first and last visible rows after resize", () => {
		const names = Array.from({ length: 24 }, (_, index) => `setup-${String(index + 1).padStart(2, "0")}`);
		names[names.length - 1] = "setup-24-with-an-extremely-long-name-that-stays-inside-the-sidebar";
		const { dashboard, actions } = setup(14, names);
		const setups: ProfileDashboardSetupRef[] = [
			CURRENT_SETUP,
			...names.map((name, index): ProfileDashboardSetupRef =>
				index === names.length - 1
					? {
							kind: "saved",
							name,
							metadata: { version: 1, emoji: "🧪", enabledGroups: [] },
						}
					: savedSetup(name),
			),
		];
		dashboard.setSetups(setups);
		for (const value of setups) {
			const profile = value.kind === "current" ? "anthropic" : value.name;
			dashboard.setSetupState(value, { snapshot: snapshot(profile, [quotaReport()]), loading: false });
		}

		const width = 140;
		const height = 14;
		const initial = dashboard.render(width, height).map(stripVTControlCharacters);
		const dividerColumn = splitDividerColumn(initial);
		for (let page = 0; page < 4; page++) {
			dashboard.handleInput("\x1b[6~");
			dashboard.render(width, height);
		}

		const setupAt = (lines: readonly string[], name: string) => {
			const needle = name.startsWith("setup-24-") ? "setup-24-" : name;
			for (let row = 0; row < lines.length; row++) {
				const line = lines[row]!;
				let index = line.indexOf(needle);
				while (index >= 0) {
					const column = Bun.stringWidth(line.slice(0, index));
					if (column < dividerColumn) return { row, column, line };
					index = line.indexOf(needle, index + needle.length);
				}
			}
			return undefined;
		};
		const visibleSetups = (lines: readonly string[]) =>
			names
				.map(name => ({ name, position: setupAt(lines, name) }))
				.filter((entry): entry is { name: string; position: { row: number; column: number; line: string } } =>
					Boolean(entry.position),
				)
				.sort((left, right) => left.position.row - right.position.row);
		const clickSetup = (entry: { name: string; position: { row: number; column: number } }) => {
			dashboard.handleInput(mouseEvent(0, entry.position.column, entry.position.row));
			expect(dashboard.selectedSetup).toMatchObject({ kind: "saved", name: entry.name });
			expect(actions.at(-1)).toBe(`select:saved:${entry.name}`);
		};

		let lines = dashboard.render(width, height).map(stripVTControlCharacters);
		let visible = visibleSetups(lines);
		expect(visible.length).toBeGreaterThan(1);
		const first = visible[0]!;
		const last = visible.at(-1)!;
		expect(last.name).toBe(names.at(-1)!);
		const lastDivider = last.position.line.indexOf("│");
		expect(last.position.line.slice(0, lastDivider)).toContain("🧪");
		expect(last.position.line.slice(0, lastDivider)).toContain("setup-24-");
		clickSetup(first);

		lines = dashboard.render(width, height).map(stripVTControlCharacters);
		const lastAfterFirstClick = visibleSetups(lines).at(-1)!;
		expect(lastAfterFirstClick.name).toBe(names.at(-1)!);
		clickSetup(lastAfterFirstClick);

		const compactHeight = 10;
		lines = dashboard.render(width, compactHeight).map(stripVTControlCharacters);
		visible = visibleSetups(lines);
		expect(visible.length).toBeGreaterThan(1);
		clickSetup(visible[0]!);
		lines = dashboard.render(width, compactHeight).map(stripVTControlCharacters);
		const compactLast = visibleSetups(lines).at(-1)!;
		expect(compactLast.name).toBe(names.at(-1)!);
		clickSetup(compactLast);
	});

	test("aligns unequal model rows at wide widths and preserves every metric when narrow", () => {
		const profile = snapshot("anthropic");
		Object.assign(profile.roles[0]!, {
			int: 45.2,
			tps: 82.5,
			contextWindow: 128_000,
			perf: { samples: 12, tps: 118.4, ttftMs: 930 },
		});
		profile.roles.push({
			role: "extraordinarily-long-review-role",
			selector: "google/secondary-model",
			provider: "google",
			modelId: "secondary-model",
			cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
			automatic: false,
			int: 73.6,
			tps: 42,
			contextWindow: 64_000,
			perf: { samples: 9, tps: 42.2, ttftMs: 1_700 },
		});
		profile.warnings = ["Model catalog warning"];

		const wide = setup(48, []);
		wide.dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		const wideLines = wide.dashboard.render(220, 48).map(stripVTControlCharacters);
		const primary = wideLines.find(line => line.includes("fixture-model"));
		const secondary = wideLines.find(line => line.includes("secondary-model"));
		if (!primary || !secondary) throw new Error("Expected both model rows in the wide preview");
		expect(primary.indexOf("45") + "45".length).toBe(secondary.indexOf("74") + "74".length);
		expect(primary.indexOf("0.9s 118t/s") + "0.9s 118t/s".length).toBe(
			secondary.indexOf("1.7s 42t/s") + "1.7s 42t/s".length,
		);
		expect(primary.indexOf("128k") + "128k".length).toBe(secondary.indexOf("64k") + "64k".length);
		expect(primary.indexOf("$3/15") + "$3/15".length).toBe(secondary.indexOf("$2/8") + "$2/8".length);
		expect(wideLines.join("\n")).toContain("Model catalog warning");

		const narrow = setup(48, []);
		narrow.dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		narrow.dashboard.handleInput("\t");
		const narrowSummary = pageOverviewUntil(narrow.dashboard, 80, 48, "Usage & limits", lines => {
			expect(lines).toHaveLength(48);
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		});
		for (const value of [
			"fixture-model",
			"secondary-model",
			"45",
			"74",
			"0.9s",
			"1.7s",
			"128k",
			"64k",
			"$3/15",
			"$2/8",
			"Model catalog warning",
		]) {
			expect(narrowSummary).toContain(value);
		}
	});

	test("consolidates empty roles and identical warnings without losing affected role names", () => {
		const profile = snapshot("anthropic");
		profile.roles[0]!.warning = "Model selection needs attention";
		profile.roles.push(
			{
				role: "review",
				selector: "google/review-model",
				provider: "google",
				modelId: "review-model",
				automatic: false,
				warning: "Model selection needs attention",
			},
			{ role: "apply", automatic: false },
			{ role: "compact", automatic: false },
		);
		const { dashboard } = setup(48, []);
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		const lines = dashboard.render(180, 48).map(stripVTControlCharacters);
		const warningLines = lines.filter(line => line.includes("Model selection needs attention"));
		expect(warningLines).toHaveLength(1);
		expect(warningLines[0]).toContain("default");
		expect(warningLines[0]).toContain("review");
		const emptyLine = lines.find(line => line.includes("No model assigned"));
		if (!emptyLine) throw new Error("Expected empty model roles to be summarized");
		expect(emptyLine).toContain("apply");
		expect(emptyLine).toContain("compact");
	});

	test("keeps every agent identity, assignment, fallback, and disabled state", () => {
		const { dashboard } = setup(48, []);
		const profile = snapshotWithAgentAssignments("anthropic");
		profile.agents.push({ name: "inherited-agent", enabled: true, source: "bundled" });
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		dashboard.handleInput("\t");
		const text = pageOverviewUntil(dashboard, 120, 48, "Settings & memory", lines => {
			expect(lines).toHaveLength(48);
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
		});
		for (const name of ["scout", "reviewer", "security-reviewer", "task", "sonic", "inherited-agent"]) {
			expect(text).toContain(name);
		}
		for (const assignment of [
			"claude-haiku-4-5",
			"gpt-5.6-sol",
			"missing/security-model",
			"gemini-3-flash",
			"gpt-5.6-mini",
		]) {
			expect(text).toContain(assignment);
		}
		expect(text).toContain("disabled");
		expect(text).toContain("Fallback: default role");
		expect(text).not.toContain("gpt-5.6-sol:high");
	});

	test("summarizes current and saved ownership without leaking the full scalar editor", () => {
		const current = setup(48, []);
		const currentText = current.dashboard.render(180, 48).map(stripVTControlCharacters).join("\n");
		expect(currentText).toMatch(/All settings groups[^\n]*current session/);
		expect(currentText).not.toContain("Model options");

		const { dashboard, actions } = setup(48, ["beta"]);
		const configured: ProfileDashboardSetupRef = {
			kind: "saved",
			name: "beta",
			metadata: {
				version: 1,
				emoji: "🧪",
				enabledGroups: ["context", "tasks"],
			},
		};
		const profile = snapshotWithAgentAssignments("beta");
		profile.settings = [
			{
				path: "compaction.enabled",
				label: "Auto-Compact",
				value: false,
				hidden: false,
				configured: false,
			},
			{
				path: "temperature",
				label: "Temperature",
				value: 0,
				hidden: false,
				configured: false,
			},
			{
				path: "topP",
				label: "Top P",
				value: 0.8,
				hidden: false,
				configured: true,
			},
			{
				path: "topK",
				label: "Top K",
				value: 7,
				hidden: false,
				configured: true,
			},
			{
				path: "providers.antigravityEndpoint",
				label: "Antigravity Endpoint Mode",
				value: "sandbox",
				hidden: false,
				configured: true,
			},
			{
				path: "mnemopi.embeddingApiKey",
				label: "Mnemopi Embedding API Key",
				value: "credential-secret",
				hidden: false,
				configured: true,
			},
		];
		dashboard.setSetups([CURRENT_SETUP, configured], configured);
		dashboard.setSetupState(configured, { snapshot: profile, loading: false });
		const setupSelection = ["select:saved:beta"];
		expect(actions).toEqual(setupSelection);
		dashboard.handleInput("\t");

		const summary = pageOverviewUntil(dashboard, 120, 48, "Provider settings").replace(/\s+/g, " ");
		expect(summary).toMatch(/Included.*Context.*Agents & tasks/);
		expect(summary).toMatch(/Inherited.*Model options.*Appearance.*Provider settings/);
		for (const editorField of [
			"Auto-Compact",
			"Temperature",
			"Top P",
			"Top K",
			"Antigravity Endpoint Mode",
			"Mnemopi Embedding API Key",
			"credential-secret",
		]) {
			expect(summary).not.toContain(editorField);
		}

		expect(actions).toEqual(setupSelection);
		dashboard.handleInput("\r");
		expect(actions).toEqual([...setupSelection, "edit-profile:saved:beta"]);
	});

	test("preserves the unified overview offset across refresh and resets it for another setup", () => {
		const { dashboard, actions } = setup(24, ["beta"]);
		const reports = ["anthropic", "openai", "google"].map((provider, index) => {
			const report = quotaReport(provider);
			report.notes = [`${provider} usage note ${index + 1}`];
			return report;
		});
		const profile = snapshotWithAgentAssignments("anthropic");
		profile.usage = { generatedAt: NOW, reports, accountsWithoutUsage: [], capacity: {} };
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		dashboard.handleInput("\t");
		pageOverviewUntil(dashboard, 120, 24, "google usage note 3");
		const scrolled = dashboard.render(120, 24).map(stripVTControlCharacters);
		expect(scrolled.join("\n")).toContain("Current setup");

		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		expect(dashboard.render(120, 24).map(stripVTControlCharacters)).toEqual(scrolled);

		dashboard.handleInput("\t");
		dashboard.handleInput("\x1b[B");
		expect(dashboard.selectedSetup).toEqual(savedSetup("beta"));
		const resetPreview = dashboard.render(120, 24).map(stripVTControlCharacters).join("\n");
		expect(resetPreview).toContain("beta");
		expect(resetPreview).toContain("Models");
		expect(resetPreview).not.toContain("google usage note 3");
		expect(actions).toEqual(["select:saved:beta"]);
	});

	test("reflows the same reachable overview across narrow and wide resizes", () => {
		const { dashboard, actions } = setup(40, []);
		const profile = snapshotWithAgentAssignments("anthropic");
		profile.usage = snapshot("anthropic", [quotaReport()]).usage;
		profile.memory = {
			backend: "sqlite",
			scope: "workspace",
			storageLabel: "Profile-local default storage",
		};
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });

		const wide = dashboard.render(220, 40).map(stripVTControlCharacters);
		for (const line of wide) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(220);
		const wideModel = wide.find(line => line.includes("fixture-model"));
		if (!wideModel) throw new Error("Expected the overview model row");
		const firstDivider = wideModel.indexOf("│");
		expect(wideModel.slice(firstDivider + 1, wideModel.indexOf("fixture-model"))).not.toContain("│");
		const agentsWideRow = wide.findIndex(line => line.includes("Agents"));
		const settingsWideRow = wide.findIndex(line => line.includes("Settings & memory"));
		expect(agentsWideRow).toBeGreaterThan(0);
		expect(settingsWideRow).toBe(agentsWideRow);

		dashboard.handleInput("\t");
		const narrowOverview = pageOverviewUntil(dashboard, 80, 24, "64%", lines => {
			expect(lines).toHaveLength(24);
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
			expect(lines.join("\n")).toContain("Current setup");
		});
		for (const value of [
			"Models",
			"fixture-model",
			"Agents",
			"Settings & memory",
			"sqlite",
			"workspace",
			"Profile-local default storage",
			"Usage & limits",
			"Anthropic",
			"82%",
			"64%",
		]) {
			expect(narrowOverview).toContain(value);
		}
		expect(narrowOverview.indexOf("Settings & memory")).toBeGreaterThan(narrowOverview.indexOf("Agents"));

		const resizedWide = dashboard.render(220, 40);
		expect(resizedWide).toHaveLength(40);
		for (const line of resizedWide) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(220);
		moveOverviewToStart(dashboard, 220, 40);
		const reachableAgain = pageOverviewUntil(dashboard, 220, 40, "64%");
		expect(reachableAgain).toContain("fixture-model");
		expect(reachableAgain).toContain("Usage & limits");
		expect(actions).toEqual([]);
	});

	test("reflows three provider blocks without losing windows, accounts, notes, or attached sharing", () => {
		const anthropic = quotaReport("anthropic");
		anthropic.limits[0]!.label = "Five-hour allowance";
		anthropic.limits[1]!.label = "Week";
		anthropic.limits[0]!.window!.label = "Five-hour allowance";
		anthropic.limits[1]!.window!.label = "Week";
		delete anthropic.limits[0]!.window!.durationMs;
		delete anthropic.limits[0]!.window!.resetsAt;
		delete anthropic.limits[1]!.window!.durationMs;
		delete anthropic.limits[1]!.window!.resetsAt;
		anthropic.limits[0]!.amount = { unit: "percent", usedFraction: 0.93 };
		anthropic.notes = ["anthropic preserved note"];

		const google = quotaReport("google");
		google.limits[0]!.label = "Short";
		google.limits[1]!.label = "A much longer weekly allowance";
		google.limits[0]!.window!.label = "Short";
		google.limits[1]!.window!.label = "A much longer weekly allowance";
		delete google.limits[0]!.window!.durationMs;
		delete google.limits[1]!.window!.durationMs;
		google.notes = ["google preserved note"];

		const openai = quotaReport("openai");
		openai.notes = ["openai preserved note"];
		const profile = snapshot("anthropic", [anthropic, google, openai]);
		profile.usage!.accountsWithoutUsage = [{ provider: "openai", type: "oauth", accountId: "missing-account" }];
		const { dashboard } = setup(60, ["beta"]);
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		dashboard.setSetupState(savedSetup("beta"), {
			snapshot: snapshot("beta", [quotaReport("anthropic")]),
			loading: false,
		});

		const wide = dashboard.render(220, 60).map(stripVTControlCharacters);
		const anthropicWideRow = wide.findIndex(line => line.includes("Anthropic"));
		const googleWideRow = wide.findIndex(line => line.includes("Google"));
		const openaiWideRow = wide.findIndex(line => line.includes("Openai"));
		expect(anthropicWideRow).toBeGreaterThan(0);
		expect(googleWideRow).toBe(anthropicWideRow);
		expect(openaiWideRow).toBe(anthropicWideRow);
		const providerRow = wide[anthropicWideRow]!;
		expect(providerRow.indexOf("Anthropic")).toBeLessThan(providerRow.indexOf("Google"));
		expect(providerRow.indexOf("Google")).toBeLessThan(providerRow.indexOf("Openai"));

		const narrow = dashboard.render(100, 60).map(stripVTControlCharacters);
		for (const line of narrow) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(100);
		const anthropicNarrowRow = narrow.findIndex(line => line.includes("Anthropic"));
		const googleNarrowRow = narrow.findIndex(line => line.includes("Google"));
		const openaiNarrowRow = narrow.findIndex(line => line.includes("Openai"));
		expect(anthropicNarrowRow).toBeGreaterThan(0);
		expect(googleNarrowRow).toBeGreaterThan(anthropicNarrowRow);
		expect(openaiNarrowRow).toBeGreaterThan(googleNarrowRow);
		const sharingRow = narrow.findIndex(line => line.includes("Confirmed") && line.includes("beta"));
		expect(sharingRow).toBeGreaterThan(anthropicNarrowRow);
		expect(sharingRow).toBeLessThan(googleNarrowRow);
		const googleSharingRow = narrow.findIndex(
			(line, index) => index > googleNarrowRow && index < openaiNarrowRow && line.includes("Unknown"),
		);
		const openaiSharingRow = narrow.findIndex((line, index) => index > openaiNarrowRow && line.includes("Unknown"));
		expect(googleSharingRow).toBeGreaterThan(googleNarrowRow);
		expect(openaiSharingRow).toBeGreaterThan(openaiNarrowRow);
		for (const detail of [
			"Five-hour allowance",
			"Week",
			"Short",
			"A much longer weekly allowance",
			"anthropic preserved note",
			"google preserved note",
			"openai preserved note",
			"1 account(s) without usage reports",
		]) {
			expect(narrow.join("\n")).toContain(detail);
		}
		const shortWindow = narrow.find(line => line.includes("Five-hour allowance"));
		const longWindow = narrow.find(line => line.includes("Week"));
		if (!shortWindow || !longWindow) throw new Error("Expected both Anthropic quota windows after reflow");
		expect(shortWindow.indexOf("7%")).toBe(longWindow.indexOf("64%"));
		const progressColumn = shortWindow.indexOf(theme.progress.filled);
		expect(progressColumn).toBeGreaterThan(0);
		expect(longWindow.indexOf(theme.progress.filled)).toBe(progressColumn);
	});

	test("opens the full editor once from either focus and toggles through one overview focus", () => {
		const { dashboard, actions } = setup(40, ["beta"]);
		dashboard.render(120, 40);

		dashboard.handleInput("\r");
		expect(actions.filter(action => action === "edit-profile:current")).toHaveLength(1);
		dashboard.handleInput("\t");
		dashboard.handleInput("\x1b[B");
		expect(dashboard.selectedSetup).toEqual(CURRENT_SETUP);
		dashboard.handleInput("\r");
		expect(actions.filter(action => action === "edit-profile:current")).toHaveLength(2);

		dashboard.handleInput("\t");
		dashboard.handleInput("\x1b[B");
		expect(dashboard.selectedSetup).toEqual(savedSetup("beta"));
		dashboard.handleInput("\r");
		expect(actions.filter(action => action === "edit-profile:saved:beta")).toHaveLength(1);

		dashboard.handleInput("\t");
		dashboard.handleInput("\r");
		expect(actions.filter(action => action === "edit-profile:saved:beta")).toHaveLength(2);
		dashboard.handleInput(" ");
		dashboard.handleInput("e");
		expect(actions.filter(action => action === "edit-profile:saved:beta")).toHaveLength(4);
		dashboard.handleInput("\x1b[Z");
		expect(actions.filter(action => action.startsWith("select:"))).toEqual(["select:saved:beta"]);

		const candidate = setup(24, []);
		candidate.dashboard.render(120, 24);
		candidate.dashboard.handleInput("\t");
		candidate.dashboard.handleInput("\x1b");
		expect(candidate.actions).not.toContain("close");
		candidate.dashboard.handleInput("\x1b");
		expect(candidate.actions.filter(action => action === "close")).toHaveLength(1);
	});

	test("preserves explicit management actions, search boundaries, and refresh errors", () => {
		const narrow = setup(24, ["beta"]);
		narrow.dashboard.handleInput("\x1b[B");
		clickRenderedHint(narrow.dashboard, 80, "l to load");
		clickRenderedHint(narrow.dashboard, 80, "d to delete profile");
		clickRenderedHint(narrow.dashboard, 80, "n to rename profile");
		clickRenderedHint(narrow.dashboard, 80, "e to customize");
		expect(narrow.actions).toEqual(
			expect.arrayContaining(["load:beta", "delete:beta", "rename:beta", "edit-profile:saved:beta"]),
		);

		const narrowLines = narrow.dashboard.render(80).map(stripVTControlCharacters);
		const loadLine = narrowLines.findIndex(line => line.includes("l to load"));
		const loadEnd = narrowLines[loadLine]!.indexOf("l to load") + "l to load".length;
		const separator = narrowLines[loadLine]!.indexOf(" · ", loadEnd);
		if (separator < 0) throw new Error("Expected a wrapped footer separator after the load action");
		const actionCount = narrow.actions.length;
		narrow.dashboard.handleInput(`\x1b[<0;${separator + 2};${loadLine + 1}M`);
		expect(narrow.actions).toHaveLength(actionCount);

		const searchable = setup(24, ["beta", "gamma"]);
		searchable.dashboard.handleInput("/");
		searchable.dashboard.handleInput("gam");
		searchable.dashboard.handleInput("l");
		searchable.dashboard.handleInput("s");
		searchable.dashboard.handleInput("d");
		searchable.dashboard.handleInput("n");
		expect(searchable.dashboard.selectedSetup).toEqual(savedSetup("gamma"));
		expect(searchable.actions.some(action => /^(load:|save$|delete:|rename:)/.test(action))).toBe(false);
		searchable.dashboard.handleInput("\x1b");
		expect(searchable.actions).not.toContain("close");

		const wide = setup(24, []);
		clickRenderedHint(wide.dashboard, 180, "s to save current");
		clickRenderedHint(wide.dashboard, 180, "i to import profile");
		clickRenderedHint(wide.dashboard, 180, "x to export profile");
		clickRenderedHint(wide.dashboard, 180, "m to choose model");
		clickRenderedHint(wide.dashboard, 180, "a to edit agents");
		clickRenderedHint(wide.dashboard, 180, ", to edit settings");
		expect(wide.actions).toEqual(
			expect.arrayContaining([
				"save",
				"import-roles",
				"export-roles:current",
				"control:model",
				"control:agents",
				"control:settings",
			]),
		);

		const lastGood = snapshot("anthropic");
		wide.dashboard.setSetupState(CURRENT_SETUP, {
			snapshot: lastGood,
			loading: true,
			refreshError: "Quota refresh failed\twithout losing preview",
		});
		const refreshed = plain(wide.dashboard, 180);
		expect(refreshed).toContain("fixture-model");
		expect(refreshed).toContain("Quota refresh failed without losing preview");
		expect(refreshed).toContain("showing cached data");
	});
});

describe("profile quota identity and meter boundaries", () => {
	test("separate reset timestamps and report freshness survive collection completion", () => {
		const usage = snapshot("a", [quotaReport()]).usage!;
		usage.generatedAt = NOW + 20 * 60_000;
		const provider = projectProfileUsage(usage, NOW + 10 * 60_000).providers[0]!;
		expect(provider.sharedWindows[0]?.remainingPercent).toBeCloseTo(82);
		expect(provider.sharedWindows[1]?.remainingPercent).toBeCloseTo(64);
		expect(provider.sharedWindows.map(window => window.resetsAt)).toEqual([[NOW + 5 * HOUR], [NOW + 7 * 24 * HOUR]]);
		expect(provider.fetchedAt).toBe(NOW);
		expect(provider.stale).toBe(true);
	});

	test("confirmed shared accounts stay one account allowance per profile, not extra capacity", () => {
		const first = snapshot("first", [quotaReport()]);
		const second = snapshot("second", [quotaReport()]);
		const shared = projectProfileUsageSharing([first, second]);
		expect(shared.first).toEqual([expect.objectContaining({ kind: "confirmed", profiles: ["second"] })]);
		expect(shared.second).toEqual([expect.objectContaining({ kind: "confirmed", profiles: ["first"] })]);
		for (const profile of [first, second]) {
			const windows = projectProfileUsage(profile.usage, NOW).providers[0]!.sharedWindows;
			expect(windows.map(window => window.accounts)).toEqual([1, 1]);
		}
	});

	test("organization identity, not its display name, decides account sharing", () => {
		const firstReport = quotaReport();
		firstReport.metadata = { accountId: "same-account", orgId: "org-one", orgName: "Team" };
		const otherOrg = quotaReport();
		otherOrg.metadata = { accountId: "same-account", orgId: "org-two", orgName: "Team" };
		const renamedOrg = quotaReport();
		renamedOrg.metadata = { accountId: "same-account", orgId: "org-one", orgName: "Renamed Team" };
		const shared = projectProfileUsageSharing([
			snapshot("first", [firstReport]),
			snapshot("other", [otherOrg]),
			snapshot("renamed", [renamedOrg]),
		]);
		expect(shared.first).toEqual([expect.objectContaining({ kind: "confirmed", profiles: ["renamed"] })]);
		expect(shared.other).toEqual([expect.objectContaining({ kind: "unknown", profiles: [] })]);
	});

	test("opaque account IDs do not collide by case or with project IDs", () => {
		const upper = quotaReport();
		upper.metadata = { accountId: "Account-ID" };
		const lower = quotaReport();
		lower.metadata = { accountId: "account-id" };
		const project = quotaReport();
		project.metadata = { projectId: "Account-ID" };
		const shared = projectProfileUsageSharing([
			snapshot("upper", [upper]),
			snapshot("lower", [lower]),
			snapshot("project", [project]),
		]);
		for (const rows of Object.values(shared)) {
			expect(rows).toEqual([expect.objectContaining({ kind: "unknown", profiles: [] })]);
		}
	});

	test("email alone suggests possible sharing rather than confirming it", () => {
		const report = quotaReport();
		report.metadata = { email: "fixture@example.test" };
		const shared = projectProfileUsageSharing([snapshot("a", [report]), snapshot("b", [report])]);
		expect(shared.a).toEqual([expect.objectContaining({ kind: "possible", profiles: ["b"] })]);
		expect(JSON.stringify(shared)).not.toContain("fixture@example.test");
	});

	test("multiple accounts use account-equivalent capacity, while missing reports stay separate", () => {
		const first = quotaReport();
		const second = quotaReport();
		first.metadata = { accountId: "one" };
		second.metadata = { accountId: "two" };
		first.limits = [limit("anthropic", "5h", 0.2, 5 * HOUR)];
		second.limits = [limit("anthropic", "5h", 0.2, 5 * HOUR)];
		const usage = snapshot("pool", [first, second]).usage!;
		usage.accountsWithoutUsage = [{ provider: "anthropic", type: "oauth", accountId: "missing" }];
		const provider = projectProfileUsage(usage, NOW).providers[0]!;
		expect(provider.sharedWindows).toEqual([
			expect.objectContaining({
				accounts: 2,
				remainingAccounts: 1.6,
				remainingPercent: undefined,
			}),
		]);
		expect(provider.accountsWithoutUsage).toHaveLength(1);
	});

	test("API-key-only and nonfinite reports never produce a percentage bar", () => {
		const keyUsage = snapshot("keys", []).usage!;
		keyUsage.accountsWithoutUsage = [{ provider: "anthropic", type: "api_key" }];
		const keyProvider = projectProfileUsage(keyUsage, NOW).providers[0]!;
		expect(keyProvider.state).toBe("quota-not-reported");
		expect(keyProvider.sharedWindows).toEqual([]);
		const invalid = quotaReport();
		invalid.limits = [
			limit("anthropic", "5h", Number.NaN, 5 * HOUR),
			{
				...limit("anthropic", "7d", 0, 7 * 24 * HOUR),
				amount: { unit: "percent", remainingFraction: Number.POSITIVE_INFINITY },
			},
		];
		const provider = projectProfileUsage(snapshot("invalid", [invalid]).usage, NOW).providers[0]!;
		expect(provider.sharedWindows).toEqual([]);
		expect(provider.limits.map(limit => limit.remainingPercent)).toEqual([undefined, undefined]);
	});

	test("overage survives details while the displayed remaining bar is clamped", () => {
		const report = quotaReport();
		report.limits = [limit("anthropic", "5h", 1.25, 5 * HOUR)];
		const provider = projectProfileUsage(snapshot("overage", [report]).usage, NOW).providers[0]!;
		expect(provider.limits[0]).toMatchObject({ usedFraction: 1.25, remainingPercent: 0, status: "exhausted" });
	});

	test("profile protocol drops raw payloads and arbitrary metadata and strips URL secrets", () => {
		const report = quotaReport();
		report.raw = { access_token: "raw-secret" };
		report.metadata = { accountId: "fixture-account", orgId: "fixture-org", token: "metadata-secret" };
		report.notes = ["Endpoint https://user:url-secret@quota.example.test/path?key=query-secret"];
		const usage = snapshot("a", [report]).usage!;
		usage.accountsWithoutUsage = [
			{
				provider: "anthropic",
				type: "oauth",
				enterpriseUrl: "https://user:enterprise-secret@enterprise.example.test/path?token=secret",
			},
		];
		const safe = sanitizeProfileUsageSnapshot(usage);
		const serialized = JSON.stringify(safe);
		for (const secret of ["raw-secret", "metadata-secret", "url-secret", "query-secret", "enterprise-secret"]) {
			expect(serialized).not.toContain(secret);
		}
		expect(safe.reports[0]?.metadata).toEqual({ accountId: "fixture-account", orgId: "fixture-org" });
		expect(serialized).toContain("quota.example.test");
		expect(safe.accountsWithoutUsage[0]?.enterpriseUrl).toBe("enterprise.example.test");
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function controllerHarness(
	options: {
		agentDir?: string;
		composerText?: string;
		currentSnapshot?: ProfileSnapshot;
		realSetups?: boolean;
		session?: unknown;
		settings?: Settings;
	} = {},
) {
	const mounted: ProfileDashboard[] = [];
	const settingsSelectors: SettingsSelectorComponent[] = [];
	const overlays: Component[] = [];
	const currentSnapshotReady = Promise.withResolvers<ProfileSnapshot>();
	const currentSnapshotWaiters: Array<(snapshot: ProfileSnapshot) => void> = [];
	const savedSnapshotWaiters = new Map<string, Array<(snapshot: ProfileSnapshot) => void>>();
	const renderWaiters: Array<() => void> = [];
	const render = vi.fn(() => renderWaiters.shift()?.());
	const hide = vi.fn();
	const setHidden = vi.fn();
	const focus = vi.fn();
	let composerText = options.composerText ?? "";
	const editor = {
		getText: () => composerText,
		setText: (value: string) => {
			composerText = value;
		},
		getTopBorderAvailableWidth: (width: number) => width,
	};
	const showHookInput = vi.fn();
	const showHookConfirm = vi.fn();
	const showHookSelector = vi.fn();
	const fallbackSettings = Settings.isolated();
	vi.spyOn(fallbackSettings, "getAgentDir").mockReturnValue("/fixture/profiles/agent");
	vi.spyOn(fallbackSettings, "override");
	vi.spyOn(fallbackSettings, "setModelRole");
	vi.spyOn(fallbackSettings, "setProjectModelRole");
	const settings = options.settings ?? fallbackSettings;
	if (options.agentDir && options.settings) {
		vi.spyOn(options.settings, "getAgentDir").mockReturnValue(options.agentDir);
	}
	let nextOverlay: ((component: Component) => void) | undefined;
	const waitForNextOverlay = (): Promise<Component> => {
		const pending = Promise.withResolvers<Component>();
		nextOverlay = pending.resolve;
		return pending.promise;
	};
	const waitForNextRender = (): Promise<void> => {
		const pending = Promise.withResolvers<void>();
		renderWaiters.push(pending.resolve);
		return pending.promise;
	};
	const waitForCurrentSnapshot = (): Promise<ProfileSnapshot> => {
		const pending = Promise.withResolvers<ProfileSnapshot>();
		currentSnapshotWaiters.push(pending.resolve);
		return pending.promise;
	};
	const waitForSavedSnapshot = (name: string): Promise<ProfileSnapshot> => {
		const pending = Promise.withResolvers<ProfileSnapshot>();
		const waiters = savedSnapshotWaiters.get(name) ?? [];
		waiters.push(pending.resolve);
		savedSnapshotWaiters.set(name, waiters);
		return pending.promise;
	};
	const session =
		options.session instanceof AgentSession
			? options.session
			: {
					model: undefined,
					thinkingLevel: undefined,
					configuredThinkingLevel: () => undefined,
					getAvailableThinkingLevels: () => [],
					getAvailableModels: () => [],
					modelRegistry: { authStorage: { hasAuth: () => false } },
					sessionId: "fixture-session",
					...(options.session && typeof options.session === "object" ? options.session : {}),
				};
	const context = {
		isShuttingDown: false,
		settings,
		sessionManager: {
			getCwd: () => options.agentDir ?? "/fixture/workspace",
			getSessionFile: () => undefined,
		},
		session,
		editorContainer: { children: [editor] },
		editor,
		statusLine: {
			updateSettings: vi.fn(),
			invalidate: vi.fn(),
			getPreviewLines: () => [],
		},
		ui: {
			terminal: { columns: 120, rows: 32 },
			requestRender: render,
			invalidate: vi.fn(),
			setFocus: focus,
			showOverlay: (component: Component) => {
				overlays.push(component);
				if (component instanceof SettingsSelectorComponent) {
					settingsSelectors.push(component);
					const setProfilesContent = component.setProfilesContent.bind(component);
					component.setProfilesContent = content => {
						if (content instanceof ProfileDashboard) {
							mounted.push(content);
							const setSetupState = content.setSetupState.bind(content);
							vi.spyOn(content, "setSetupState").mockImplementation((setup, state) => {
								setSetupState(setup, state);
								if (setup.kind === "current" && state.snapshot) {
									currentSnapshotReady.resolve(state.snapshot);
									if (!state.loading) currentSnapshotWaiters.shift()?.(state.snapshot);
								}
								if (setup.kind === "saved" && state.snapshot && !state.loading) {
									const waiters = savedSnapshotWaiters.get(setup.name);
									const resolve = waiters?.shift();
									if (waiters?.length === 0) savedSnapshotWaiters.delete(setup.name);
									resolve?.(state.snapshot);
								}
							});
						}
						setProfilesContent(content);
					};
				}
				nextOverlay?.(component);
				nextOverlay = undefined;
				return { hide, setHidden, isHidden: () => false };
			},
		},
		refreshSkillState: vi.fn(),
		refreshSlashCommandState: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		showHookInput,
		showHookConfirm,
		showHookSelector,
		requestProfileSwitch: vi.fn(),
		getProfileSwitchBlockReason: () => undefined,
	} as unknown as InteractiveModeContext;
	const inspectProfile = options.realSetups
		? vi
				.spyOn(profileClient, "inspectProfile")
				.mockImplementation(async (_profile, request) => snapshot(request.setup ?? "current"))
		: undefined;
	if (!options.realSetups) {
		vi.spyOn(profileSetups, "listSavedSetups").mockResolvedValue([{ name: "beta", updatedAt: NOW }]);
	}
	vi.spyOn(profileClient, "hasProfileLaunchContext").mockReturnValue(true);
	vi.spyOn(profileSnapshots, "buildProfileSnapshot").mockImplementation(async buildOptions => {
		return options.currentSnapshot ?? snapshot(buildOptions.profile);
	});
	const collectUsage = vi.spyOn(usageCli, "collectUsageSnapshot").mockResolvedValue({
		snapshot: snapshot("anthropic", [quotaReport()]).usage!,
		accounts: [],
		storedAccountCount: 1,
	});
	return {
		controller: new SelectorController(context),
		context,
		mounted,
		settingsSelectors,
		overlays,
		render,
		hide,
		setHidden,
		focus,
		inspectProfile,
		editor,
		collectUsage,
		currentSnapshotReady: currentSnapshotReady.promise,
		showHookConfirm,
		showHookInput,
		showHookSelector,
		settings,
		waitForNextOverlay,
		waitForNextRender,
		waitForCurrentSnapshot,
		waitForSavedSnapshot,
	};
}

async function openSavedProfileEditor(
	agentDir: string,
	draft: ProfileDraft,
	sessionId: string,
	activeSettings?: Settings,
) {
	const authStorage = createInMemoryAuthStorage();
	try {
		authStorage.setRuntimeApiKey("anthropic", "fixture-key");
		const settings =
			activeSettings ??
			Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
				"compaction.enabled": false,
			});
		const registry = new ModelRegistry(authStorage, `${agentDir}/models.yml`, { settings });
		const currentModel = registry.find("anthropic", "claude-sonnet-4-5");
		if (!currentModel) throw new Error("Expected bundled Anthropic model");
		await profileSetups.saveProfileDraft("beta", draft, { agentDir });
		const harness = controllerHarness({
			agentDir,
			realSetups: true,
			settings,
			session: {
				model: currentModel,
				thinkingLevel: ThinkingLevel.Medium,
				configuredThinkingLevel: () => undefined,
				getAvailableThinkingLevels: () => [ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.High],
				getAvailableModels: () => [currentModel],
				modelRegistry: registry,
				scopedModels: [{ model: currentModel }],
				sessionId,
			},
		});
		await harness.controller.showSettingsSelector("profiles");
		await harness.currentSnapshotReady;
		const dashboard = harness.mounted[0]!;
		dashboard.handleInput("\x1b[B");
		const editorOpening = harness.waitForNextOverlay();
		dashboard.handleInput("\r");
		const component = await editorOpening;
		if (!(component instanceof ProfileEditorComponent)) throw new Error("Expected saved profile editor");
		return { authStorage, dashboard, editor: component, harness };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

describe("profile dashboard request lifetime", () => {
	test("cancelling import and export scope menus never accesses the clipboard", async () => {
		const harness = controllerHarness();
		const choices = [Promise.withResolvers<string | undefined>(), Promise.withResolvers<string | undefined>()];
		harness.showHookSelector
			.mockImplementationOnce(() => choices[0]!.promise)
			.mockImplementationOnce(() => choices[1]!.promise);
		const readClipboard = vi.spyOn(clipboard, "readTextFromClipboard");
		const writeClipboard = vi.spyOn(clipboard, "copyToClipboard");
		const saveImported = vi.spyOn(profileSetups, "saveProfileDraft");
		await harness.controller.showSettingsSelector("profiles");
		const dashboard = harness.mounted[0]!;

		dashboard.handleInput("i");
		expect(readClipboard).not.toHaveBeenCalled();
		choices[0]!.resolve("Cancel");
		await choices[0]!.promise;
		await Promise.resolve();

		dashboard.handleInput("x");
		expect(writeClipboard).not.toHaveBeenCalled();
		choices[1]!.resolve(undefined);
		await choices[1]!.promise;
		await Promise.resolve();

		expect(readClipboard).not.toHaveBeenCalled();
		expect(writeClipboard).not.toHaveBeenCalled();
		expect(saveImported).not.toHaveBeenCalled();
	});

	test("profiles selection and notices survive navigating through Settings tabs", async () => {
		const harness = controllerHarness();
		harness.showHookSelector.mockResolvedValue("From clipboard");
		const readClipboard = vi.spyOn(clipboard, "readTextFromClipboard").mockResolvedValue("");
		const saveImported = vi.spyOn(profileSetups, "saveProfileDraft");
		await harness.controller.showSettingsSelector("profiles");
		const settingsSelector = harness.settingsSelectors[0]!;
		const dashboard = harness.mounted[0]!;
		const selectTab = vi.spyOn(settingsSelector, "selectTab");
		dashboard.handleInput(",");
		expect(selectTab).toHaveBeenCalledWith("appearance");
		const appearanceLines = settingsSelector.render(120).map(stripVTControlCharacters);
		const appearanceSplitLine = appearanceLines.find(line => line.split("│").length >= 4);
		if (!appearanceSplitLine) throw new Error("Expected the native Settings sidebar divider");
		const appearanceDividers: number[] = [];
		for (
			let index = appearanceSplitLine.indexOf("│");
			index >= 0;
			index = appearanceSplitLine.indexOf("│", index + 1)
		) {
			appearanceDividers.push(index);
		}
		const nativeDividerIndex = appearanceDividers[1];
		if (nativeDividerIndex === undefined) throw new Error("Expected an internal Settings sidebar divider");
		const nativeDividerColumn = Bun.stringWidth(appearanceSplitLine.slice(0, nativeDividerIndex));
		settingsSelector.selectTab("profiles");
		await harness.controller.showSettingsSelector("profiles");
		dashboard.handleInput("\x1b[B");
		const noticeRestored = Promise.withResolvers<string>();
		const setActionNotice = dashboard.setActionNotice.bind(dashboard);
		vi.spyOn(dashboard, "setActionNotice").mockImplementation((message, tone) => {
			setActionNotice(message, tone);
			if (message) noticeRestored.resolve(message);
		});

		dashboard.handleInput("i");
		expect(await noticeRestored.promise).toBe("Unable to import profile: Profile file is invalid");
		settingsSelector.handleInput("\x1b[D");
		settingsSelector.handleInput("\x1b[C");

		expect(dashboard.selectedSetup).toEqual(savedSetup("beta"));
		const profileLines = settingsSelector.render(120).map(stripVTControlCharacters);
		expect(profileLines.join("\n")).toContain("Unable to import profile: Profile file is invalid");
		expect(splitDividerColumn(profileLines)).toBe(nativeDividerColumn);
		expect(readClipboard).toHaveBeenCalledTimes(1);
		expect(saveImported).not.toHaveBeenCalled();
		expect(harness.settings.override).not.toHaveBeenCalled();
		expect(harness.settings.setModelRole).not.toHaveBeenCalled();
		expect(harness.settings.setProjectModelRole).not.toHaveBeenCalled();
	});

	test("closing a pending load choice prevents a stale fresh-session switch", async () => {
		const harness = controllerHarness();
		const choice = Promise.withResolvers<string | undefined>();
		harness.showHookSelector.mockReturnValue(choice.promise);
		await harness.controller.showSettingsSelector("profiles");
		const dashboard = harness.mounted[0]!;
		dashboard.handleInput("\x1b[B");
		dashboard.handleInput("l");

		harness.settingsSelectors[0]!.handleInput("\x1b");
		choice.resolve("Start a new session");
		await choice.promise;
		await Promise.resolve();

		expect(harness.context.requestProfileSwitch).not.toHaveBeenCalled();
	});

	test("closing aborts an in-flight profile import dialog before any setup can be saved", async () => {
		const harness = controllerHarness();
		harness.showHookSelector.mockResolvedValue("From file");
		const inputStarted = Promise.withResolvers<void>();
		const inputCancelled = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		harness.showHookInput.mockImplementation(
			(_title: string, _placeholder?: string, dialogOptions?: { signal?: AbortSignal }) => {
				signal = dialogOptions?.signal;
				inputStarted.resolve();
				const pending = Promise.withResolvers<string | undefined>();
				signal?.addEventListener(
					"abort",
					() => {
						pending.resolve(undefined);
						inputCancelled.resolve();
					},
					{ once: true },
				);
				return pending.promise;
			},
		);
		const saveImported = vi.spyOn(profileSetups, "saveProfileDraft");
		await harness.controller.showSettingsSelector("profiles");
		harness.mounted[0]!.handleInput("i");
		await inputStarted.promise;
		harness.settingsSelectors[0]!.handleInput("\x1b");
		await inputCancelled.promise;
		expect(signal?.aborted).toBe(true);
		expect(saveImported).not.toHaveBeenCalled();
	});

	test("cancelling a draft with staged emoji, group, and role work writes nothing and blocks stale editor saves", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-cancel-");
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
				"compaction.enabled": true,
			});
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const currentModel = registry.find("anthropic", "claude-sonnet-4-5");
			if (!currentModel) throw new Error("Expected bundled Anthropic model");
			const current = snapshot("current");
			current.roles[0] = {
				role: "default",
				selector: "anthropic/claude-sonnet-4-5",
				provider: currentModel.provider,
				modelId: currentModel.id,
				automatic: false,
			};
			current.settings = [
				{
					path: "compaction.enabled",
					label: "Auto-Compact",
					value: true,
					hidden: false,
					configured: true,
				},
			];
			const composer = "keep this nonempty composer";
			const harness = controllerHarness({
				agentDir: tempDir.path(),
				composerText: composer,
				currentSnapshot: current,
				realSetups: true,
				settings,
				session: {
					model: currentModel,
					configuredThinkingLevel: () => undefined,
					modelRegistry: registry,
					scopedModels: [{ model: currentModel }],
					sessionId: "draft-cancel-session",
				},
			});
			await harness.controller.showSettingsSelector("profiles");
			await harness.currentSnapshotReady;
			const dashboard = harness.mounted[0]!;
			const editorOpening = harness.waitForNextOverlay();
			dashboard.handleInput("\r");
			const profileEditor = await editorOpening;
			expect(profileEditor).toBeInstanceOf(ProfileEditorComponent);
			const draftEditor = profileEditor as ProfileEditorComponent;

			draftEditor.handleInput("\r");
			draftEditor.handleInput("\x1b[B");
			draftEditor.handleInput("\r");
			draftEditor.handleInput("Context inclusion");
			draftEditor.handleInput("\r");
			draftEditor.handleInput("\x1b");

			const roleOpening = harness.waitForNextOverlay();
			draftEditor.handleInput("Model role default");
			draftEditor.handleInput("\r");
			await roleOpening;
			harness.settingsSelectors[0]!.handleInput("\x1b");
			await Promise.resolve();
			await Promise.resolve();
			draftEditor.handleInput("\x13");
			await Promise.resolve();

			expect(await profileSetups.listSavedSetups(tempDir.path())).toEqual([]);
			expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
			expect(settings.get("compaction.enabled")).toBe(true);
			expect(harness.editor.getText()).toBe(composer);
		} finally {
			authStorage.close();
		}
	});

	test("profile role selection waits for concrete thinking and exposes the draft model effort ladder", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-role-thinking-");
		const selector = "anthropic/claude-sonnet-4-5";
		const opened = await openSavedProfileEditor(
			tempDir.path(),
			{
				metadata: { version: 1, enabledGroups: ["model"] },
				config: { modelRoles: { default: selector }, defaultThinkingLevel: ThinkingLevel.Medium },
			},
			"role-thinking-session",
		);
		try {
			opened.editor.handleInput("Thinking Level");
			opened.editor.handleInput("\r");
			const thinkingMenu = opened.editor.render(100).map(stripVTControlCharacters).join("\n").toLowerCase();
			expect(thinkingMenu).toContain("low");
			expect(thinkingMenu).toContain("high");
			opened.editor.handleInput("\x1b");
			opened.editor.handleInput("\x1b");
			expect(opened.editor.render(100).map(stripVTControlCharacters).join("\n")).not.toContain(
				"Search: Thinking Level",
			);

			const roleOpening = opened.harness.waitForNextOverlay();
			opened.editor.handleInput("Model role default");
			opened.editor.handleInput("\r");
			const component = await roleOpening;
			expect(component).toBeInstanceOf(ModelHubComponent);
			const hub = component as ModelHubComponent;
			const thinkingVisible = Promise.withResolvers<void>();
			opened.harness.render.mockImplementation(() => {
				queueMicrotask(() => {
					if (hub.render(120).map(stripVTControlCharacters).join("\n").includes("inherit")) {
						thinkingVisible.resolve();
					}
				});
			});
			hub.handleInput("\r");
			await thinkingVisible.promise;

			const model = opened.harness.context.session.model;
			if (!model) throw new Error("Expected active model");
			const levels = [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
			const highIndex = levels.indexOf(ThinkingLevel.High);
			const initialIndex = levels.indexOf(ThinkingLevel.Medium);
			if (highIndex < 0 || initialIndex < 0)
				throw new Error("Expected draft model to support medium and high thinking");
			const draftUpdated = Promise.withResolvers<void>();
			opened.harness.render.mockImplementation(() => {
				queueMicrotask(() => {
					if (profileRole(opened.editor.draft, "default") === `${selector}:high`) draftUpdated.resolve();
				});
			});
			const moves = (highIndex - initialIndex + levels.length) % levels.length;
			for (let index = 0; index < moves; index++) hub.handleInput("\x1b[C");
			hub.handleInput("\r");
			await draftUpdated.promise;

			expect(profileRole(opened.editor.draft, "default")).toBe(`${selector}:high`);
			opened.harness.showHookConfirm.mockResolvedValue(true);
			const savedNotice = Promise.withResolvers<void>();
			const setActionNotice = opened.dashboard.setActionNotice.bind(opened.dashboard);
			vi.spyOn(opened.dashboard, "setActionNotice").mockImplementation((message, tone) => {
				setActionNotice(message, tone);
				if (tone === "error") savedNotice.reject(new Error(message ?? "Profile save failed"));
				else if (message?.includes("Saved profile beta")) savedNotice.resolve();
			});
			opened.editor.handleInput("\x13");
			await savedNotice.promise;
			const saved = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(profileRole(saved, "default")).toBe(`${selector}:high`);
		} finally {
			opened.authStorage.close();
		}
	});

	test("cancelling focused role selection preserves the saved role", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-role-cancel-");
		const selector = "anthropic/claude-sonnet-4-5:low";
		const opened = await openSavedProfileEditor(
			tempDir.path(),
			{
				metadata: { version: 1, enabledGroups: ["model"] },
				config: { modelRoles: { default: selector } },
			},
			"role-cancel-session",
		);
		try {
			const roleOpening = opened.harness.waitForNextOverlay();
			opened.editor.handleInput("Model role default");
			opened.editor.handleInput("\r");
			const component = await roleOpening;
			expect(component).toBeInstanceOf(ModelHubComponent);
			component.handleInput?.("\x1b");
			await Promise.resolve();
			await Promise.resolve();

			const saved = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(profileRole(saved, "default")).toBe(selector);
			expect(opened.harness.settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		} finally {
			opened.authStorage.close();
		}
	});

	test("an explicit saved-profile emoji choice commits alone and survives cancelling the remaining draft", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-emoji-commit-");
		const initialDraft: ProfileDraft = {
			metadata: { version: 1, emoji: "🔍", enabledGroups: [] },
			config: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } },
		};
		const opened = await openSavedProfileEditor(tempDir.path(), initialDraft, "emoji-commit-session");
		try {
			const inspectionCount = opened.harness.inspectProfile?.mock.calls.length;
			opened.editor.handleInput("Context inclusion");
			opened.editor.handleInput("\r");
			opened.editor.handleInput("\x1b");
			opened.editor.handleInput("Emoji");
			opened.editor.handleInput("\r");
			opened.editor.handleInput("\x1b[H");
			opened.editor.handleInput("\x1b[B");
			const emojiSaved = [opened.harness.waitForNextRender(), opened.harness.waitForNextRender()];
			opened.editor.handleInput("\r");
			await Promise.all(emojiSaved);

			const beforeCancel = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(beforeCancel.metadata).toEqual({ version: 1, emoji: "💻", enabledGroups: [] });
			expect(beforeCancel.config).toEqual(initialDraft.config);
			expect(opened.dashboard.selectedSetup).toMatchObject({
				kind: "saved",
				name: "beta",
				metadata: { emoji: "💻" },
			});
			expect(opened.harness.inspectProfile?.mock.calls.length).toBe(inspectionCount);
			expect(opened.harness.context.requestProfileSwitch).not.toHaveBeenCalled();

			opened.editor.handleInput("\x1b");
			opened.editor.handleInput("\x1b");
			const afterCancel = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(afterCancel.metadata).toEqual({ version: 1, emoji: "💻", enabledGroups: [] });
			expect(afterCancel.config).toEqual(initialDraft.config);
		} finally {
			opened.authStorage.close();
		}
	});

	test("None immediately removes the emoji without reverting newer saved legacy values", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-emoji-none-");
		const initialDraft: ProfileDraft = {
			metadata: { version: 1, emoji: "📚", enabledGroups: [] },
			config: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } },
		};
		const opened = await openSavedProfileEditor(tempDir.path(), initialDraft, "emoji-none-session");
		try {
			const saved = await profileSetups.loadSavedSetup("beta", tempDir.path());
			await Bun.write(
				saved.path,
				YAML.stringify({
					$setup: {
						version: 1,
						emoji: "📚",
						enabledGroups: ["model", "appearance"],
					},
					modelRoles: { default: "legacy/latest:high" },
					defaultThinkingLevel: ThinkingLevel.Medium,
					tier: { openai: "priority" },
					display: { showTurnTime: false },
				}),
			);

			opened.editor.handleInput("\r");
			opened.editor.handleInput("\x1b[H");
			const emojiRemoved = [opened.harness.waitForNextRender(), opened.harness.waitForNextRender()];
			opened.editor.handleInput("\r");
			await Promise.all(emojiRemoved);

			const removed = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(removed.metadata).toEqual({ version: 1, enabledGroups: ["model", "appearance"] });
			expect(removed.config).toEqual({
				modelRoles: { default: "legacy/latest:high" },
				defaultThinkingLevel: ThinkingLevel.Medium,
				display: { showTurnTime: false },
				tier: { openai: "priority" },
			});
		} finally {
			opened.authStorage.close();
		}
	});

	test("an unsafe replacement rejects an emoji write without losing the file or draft and allows retry", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-emoji-failure-");
		const initialDraft: ProfileDraft = {
			metadata: { version: 1, emoji: "🔍", enabledGroups: [] },
			config: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } },
		};
		const opened = await openSavedProfileEditor(tempDir.path(), initialDraft, "emoji-failure-session");
		try {
			opened.editor.handleInput("Context inclusion");
			opened.editor.handleInput("\r");
			opened.editor.handleInput("\x1b");
			const saved = await profileSetups.loadSavedSetup("beta", tempDir.path());
			const originalBytes = await Bun.file(saved.path).bytes();
			const preservedPath = tempDir.join("preserved-beta.yml");
			const saveProfileDraft = profileSetups.saveProfileDraft;
			vi.spyOn(profileSetups, "saveProfileDraft").mockImplementationOnce(async (name, draft, options) => {
				await fs.rename(saved.path, preservedPath);
				await fs.mkdir(saved.path);
				return saveProfileDraft(name, draft, options);
			});

			opened.editor.handleInput("Emoji");
			opened.editor.handleInput("\r");
			opened.editor.handleInput("\x1b[H");
			opened.editor.handleInput("\x1b[B");
			const emojiRejected = opened.harness.waitForNextRender();
			opened.editor.handleInput("\r");
			await emojiRejected;

			expect(await Bun.file(preservedPath).bytes()).toEqual(originalBytes);
			expect((await fs.lstat(saved.path)).isDirectory()).toBe(true);
			expect(opened.editor.render(100).map(stripVTControlCharacters).join("\n")).toContain(
				"Saved setup target is not a regular file",
			);

			await fs.rm(saved.path, { recursive: true });
			await fs.rename(preservedPath, saved.path);
			const emojiRetried = [opened.harness.waitForNextRender(), opened.harness.waitForNextRender()];
			opened.editor.handleInput("\r");
			await Promise.all(emojiRetried);

			const retried = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(retried.metadata).toEqual({ version: 1, emoji: "💻", enabledGroups: [] });
			expect(retried.config).toEqual(initialDraft.config);
		} finally {
			opened.authStorage.close();
		}
	});

	test("a current export draft emoji choice cannot overwrite an existing saved profile", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-emoji-export-");
		const initialDraft: ProfileDraft = {
			metadata: { version: 1, emoji: "📚", enabledGroups: [] },
			config: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } },
		};
		const opened = await openSavedProfileEditor(tempDir.path(), initialDraft, "emoji-export-session");
		try {
			const saved = await profileSetups.loadSavedSetup("beta", tempDir.path());
			const originalBytes = await Bun.file(saved.path).bytes();
			const editorClosed = opened.harness.waitForNextRender();
			opened.editor.handleInput("\x1b");
			await editorClosed;

			opened.dashboard.handleInput("\x1b[A");
			const exported = Promise.withResolvers<string>();
			opened.harness.showHookSelector.mockImplementation((title: string) => {
				if (title === "Export scope") return Promise.resolve("Profile");
				if (title === "Export profile") return Promise.resolve("Copy to clipboard");
				throw new Error(`Unexpected selector: ${title}`);
			});
			vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async payload => {
				exported.resolve(payload);
			});
			const exportEditorOpening = opened.harness.waitForNextOverlay();
			opened.dashboard.handleInput("x");
			const component = await exportEditorOpening;
			expect(component).toBeInstanceOf(ProfileEditorComponent);
			const exportEditor = component as ProfileEditorComponent;
			exportEditor.handleInput("\r");
			exportEditor.handleInput("\x1b[B");
			exportEditor.handleInput("\r");

			exportEditor.handleInput("\x13");
			const payload = YAML.parse(await exported.promise) as { emoji?: string };
			expect(payload.emoji).toBe("💻");
			expect(await Bun.file(saved.path).bytes()).toEqual(originalBytes);
		} finally {
			opened.authStorage.close();
		}
	});

	test("file and clipboard profile imports persist exact enabled values without activation or overwrite", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-import-");
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			const initialSelector = "anthropic/claude-sonnet-4-5";
			const importedSelector = "anthropic/claude-opus-4-6";
			const settings = Settings.isolated({
				modelRoles: { default: initialSelector },
				"compaction.enabled": true,
				"compaction.midTurnEnabled": false,
			});
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const currentModel = registry.find("anthropic", "claude-sonnet-4-5");
			if (!currentModel || !registry.find("anthropic", "claude-opus-4-6")) {
				throw new Error("Expected bundled Anthropic models");
			}
			const current = snapshot("current");
			current.roles[0] = {
				role: "default",
				selector: initialSelector,
				provider: currentModel.provider,
				modelId: currentModel.id,
				automatic: false,
			};
			const filePayload = serializeProfile(
				{
					metadata: { version: 1, emoji: "📚", enabledGroups: ["context"] },
					config: { modelRoles: { default: importedSelector }, compaction: { enabled: false } },
				},
				"Shared file",
			);
			const clipboardPayload = serializeProfile(
				{
					metadata: { version: 1, emoji: "🐛", enabledGroups: ["context"] },
					config: { modelRoles: { default: importedSelector }, compaction: { midTurnEnabled: true } },
				},
				"Shared clipboard",
			);
			const importPath = tempDir.join("shared-profile.yml");
			await Bun.write(importPath, filePayload);
			let transport: "From file" | "From clipboard" = "From file";
			const saveNames = ["file-profile", "file-profile", "clipboard-profile"];
			const harness = controllerHarness({
				agentDir: tempDir.path(),
				currentSnapshot: current,
				realSetups: true,
				settings,
				session: {
					model: currentModel,
					configuredThinkingLevel: () => undefined,
					modelRegistry: registry,
					sessionId: "import-session",
				},
			});
			harness.showHookSelector.mockImplementation((title: string) => {
				if (title === "Import profile or model roles") return Promise.resolve(transport);
				throw new Error(`Unexpected selector: ${title}`);
			});
			harness.showHookInput.mockImplementation((title: string) => {
				if (title === "Import from") return Promise.resolve(importPath);
				if (title.includes("Save imported profile as")) return Promise.resolve(saveNames.shift());
				throw new Error(`Unexpected input: ${title}`);
			});
			harness.showHookConfirm.mockResolvedValue(true);
			const readClipboard = vi.spyOn(clipboard, "readTextFromClipboard").mockResolvedValue(clipboardPayload);
			await harness.controller.showSettingsSelector("profiles");
			await harness.currentSnapshotReady;
			const dashboard = harness.mounted[0]!;
			const noticeResolvers: Array<(message: string) => void> = [];
			const setActionNotice = dashboard.setActionNotice.bind(dashboard);
			vi.spyOn(dashboard, "setActionNotice").mockImplementation((message, tone) => {
				setActionNotice(message, tone);
				if (message) noticeResolvers.shift()?.(message);
			});
			const waitForNotice = (): Promise<string> => {
				const pending = Promise.withResolvers<string>();
				noticeResolvers.push(pending.resolve);
				return pending.promise;
			};
			const proceedThroughPreviews = async (): Promise<void> => {
				const initialOpening = harness.waitForNextOverlay();
				dashboard.handleInput("i");
				const initialComponent = await initialOpening;
				expect(initialComponent).toBeInstanceOf(ProfileImportPreview);
				const initialPreview = initialComponent as ProfileImportPreview;

				const overlayCount = harness.overlays.length;
				const selectorCount = harness.showHookSelector.mock.calls.length;
				initialPreview.handleInput("\x1b[B");
				await Promise.resolve();
				expect(harness.overlays).toHaveLength(overlayCount);
				expect(harness.showHookSelector).toHaveBeenCalledTimes(selectorCount);

				const finalOpening = harness.waitForNextOverlay();
				initialPreview.handleInput("\r");
				const finalComponent = await finalOpening;
				expect(finalComponent).toBeInstanceOf(ProfileImportPreview);
				const finalPreview = finalComponent as ProfileImportPreview;

				const promptsBeforeNavigation = harness.showHookInput.mock.calls.filter(call =>
					String(call[0]).includes("Save imported profile as"),
				).length;
				finalPreview.handleInput("\x1b[B");
				await Promise.resolve();
				expect(
					harness.showHookInput.mock.calls.filter(call => String(call[0]).includes("Save imported profile as"))
						.length,
				).toBe(promptsBeforeNavigation);
				finalPreview.handleInput("\r");
			};

			const fileNotice = waitForNotice();
			await proceedThroughPreviews();
			expect(await fileNotice).toContain("Saved imported profile file-profile");
			expect(readClipboard).not.toHaveBeenCalled();
			const fileSetup = await profileSetups.loadSavedSetup("file-profile", tempDir.path());
			expect(fileSetup.metadata).toEqual({ version: 1, emoji: "📚", enabledGroups: ["context"] });
			expect(fileSetup.config).toEqual({
				modelRoles: { default: importedSelector },
				compaction: { enabled: false },
			});
			const originalFileBytes = await Bun.file(fileSetup.path).bytes();

			transport = "From clipboard";
			const clipboardNotice = waitForNotice();
			await proceedThroughPreviews();
			expect(await clipboardNotice).toContain("Saved imported profile clipboard-profile");
			expect(readClipboard).toHaveBeenCalledTimes(1);
			const clipboardSetup = await profileSetups.loadSavedSetup("clipboard-profile", tempDir.path());
			expect(clipboardSetup.metadata).toEqual({ version: 1, emoji: "🐛", enabledGroups: ["context"] });
			expect(clipboardSetup.config).toEqual({
				modelRoles: { default: importedSelector },
				compaction: { midTurnEnabled: true },
			});
			expect(await Bun.file(fileSetup.path).bytes()).toEqual(originalFileBytes);
			expect(settings.getModelRole("default")).toBe(initialSelector);
			expect(settings.get("compaction.enabled")).toBe(true);
			expect(settings.get("compaction.midTurnEnabled")).toBe(false);
			expect(harness.context.requestProfileSwitch).not.toHaveBeenCalled();
		} finally {
			authStorage.close();
		}
	});

	test("Keep current treats an inherited prototype-named agent override as Automatic", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-import-prototype-agent-");
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			const initialSelector = "anthropic/claude-sonnet-4-5";
			const settings = Settings.isolated({
				modelRoles: { default: initialSelector },
				"task.agentModelOverrides": {},
			});
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const currentModel = registry.find("anthropic", "claude-sonnet-4-5");
			if (!currentModel) throw new Error("Expected bundled Anthropic model");
			const current = snapshot("current");
			current.roles[0] = {
				role: "default",
				selector: initialSelector,
				provider: currentModel.provider,
				modelId: currentModel.id,
				automatic: false,
			};
			current.agents = [{ name: "toString", enabled: true, source: "bundled" }];
			const payload = serializeProfile(
				{
					metadata: { version: 1, enabledGroups: ["tasks"] },
					config: {
						modelRoles: { default: initialSelector },
						task: { agentModelOverrides: { toString: "missing/prototype-model" } },
					},
				},
				"Prototype agent",
			);
			const harness = controllerHarness({
				agentDir: tempDir.path(),
				currentSnapshot: current,
				realSetups: true,
				settings,
				session: {
					model: currentModel,
					configuredThinkingLevel: () => undefined,
					modelRegistry: registry,
					sessionId: "import-prototype-agent-session",
				},
			});
			harness.showHookSelector.mockImplementation((title: string) => {
				if (title === "Import profile or model roles") return Promise.resolve("From clipboard");
				if (title.startsWith("Agent toString")) return Promise.resolve("Keep current assignment");
				throw new Error(`Unexpected selector: ${title}`);
			});
			harness.showHookInput.mockImplementation((title: string) => {
				if (title.includes("Save imported profile as")) return Promise.resolve("prototype-agent");
				throw new Error(`Unexpected input: ${title}`);
			});
			harness.showHookConfirm.mockResolvedValue(true);
			vi.spyOn(clipboard, "readTextFromClipboard").mockResolvedValue(payload);
			await harness.controller.showSettingsSelector("profiles");
			await harness.currentSnapshotReady;
			const dashboard = harness.mounted[0]!;
			const savedNotice = Promise.withResolvers<string>();
			const setActionNotice = dashboard.setActionNotice.bind(dashboard);
			vi.spyOn(dashboard, "setActionNotice").mockImplementation((message, tone) => {
				setActionNotice(message, tone);
				if (tone === "error") savedNotice.reject(new Error(message ?? "Profile import failed"));
				else if (message) savedNotice.resolve(message);
			});
			const importSettledEarly = savedNotice.promise.then(message => {
				throw new Error(`Import completed before the expected preview: ${message}`);
			});

			const initialOpening = harness.waitForNextOverlay();
			dashboard.handleInput("i");
			const initialComponent = await Promise.race([initialOpening, importSettledEarly]);
			expect(initialComponent).toBeInstanceOf(ProfileImportPreview);
			const finalOpening = harness.waitForNextOverlay();
			initialComponent.handleInput?.("\r");
			const finalComponent = await Promise.race([finalOpening, importSettledEarly]);
			expect(finalComponent).toBeInstanceOf(ProfileImportPreview);
			finalComponent.handleInput?.("\r");
			expect(await savedNotice.promise).toContain("Saved imported profile prototype-agent");

			const imported = await profileSetups.loadSavedSetup("prototype-agent", tempDir.path());
			const task = imported.config.task as RawSettings;
			const overrides = task.agentModelOverrides as Record<string, unknown>;
			expect(Object.hasOwn(overrides, "toString")).toBe(true);
			expect(overrides["toString"]).toBeNull();
			expect(Object.hasOwn(settings.get("task.agentModelOverrides"), "toString")).toBe(false);
		} finally {
			authStorage.close();
		}
	});

	test("load choices apply only models in place or request a fresh session for the full saved profile", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-load-");
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		let settings: Settings | undefined;
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
				"compaction.enabled": true,
			});
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const initialModel = registry.find("anthropic", "claude-sonnet-4-5");
			const targetModel = registry.find("anthropic", "claude-sonnet-4-6");
			if (!initialModel || !targetModel) throw new Error("Expected bundled Anthropic models");
			const history: AgentMessage = { role: "user", content: "preserve this history", timestamp: 1 };
			const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			manager.appendMessage(history);
			session = new AgentSession({
				agent: new Agent({
					initialState: { model: initialModel, systemPrompt: ["Test"], tools: [], messages: [history] },
				}),
				sessionManager: manager,
				settings,
				modelRegistry: registry,
			});
			await profileSetups.saveProfileDraft(
				"activation",
				{
					metadata: { version: 1, enabledGroups: ["context"] },
					config: {
						modelRoles: { default: `${targetModel.provider}/${targetModel.id}:high` },
						compaction: { enabled: false },
					},
				},
				{ agentDir: tempDir.path() },
			);
			const current = snapshot("current");
			current.roles[0] = {
				role: "default",
				selector: `${initialModel.provider}/${initialModel.id}`,
				provider: initialModel.provider,
				modelId: initialModel.id,
				automatic: false,
			};
			const composer = "draft survives model application";
			const harness = controllerHarness({
				agentDir: tempDir.path(),
				composerText: composer,
				currentSnapshot: current,
				realSetups: true,
				session,
				settings,
			});
			const requestProfileSwitch = vi.spyOn(harness.context, "requestProfileSwitch");
			harness.showHookSelector.mockResolvedValue("Apply models to current session");
			await harness.controller.showSettingsSelector("profiles");
			await harness.currentSnapshotReady;
			const dashboard = harness.mounted[0]!;
			const applied = Promise.withResolvers<string>();
			const setActionNotice = dashboard.setActionNotice.bind(dashboard);
			vi.spyOn(dashboard, "setActionNotice").mockImplementation((message, tone) => {
				setActionNotice(message, tone);
				if (typeof message !== "string") return;
				if (tone === "error") {
					applied.reject(new Error(message));
				} else if (message.includes("Applied setup")) {
					applied.resolve(message);
				}
			});
			const sessionId = session.sessionId;
			const messages = [...session.messages];
			dashboard.handleInput("\x1b[B");
			dashboard.handleInput("l");
			expect(await applied.promise).toContain("Applied setup activation");
			expect(`${session.model?.provider}/${session.model?.id}`).toBe(`${targetModel.provider}/${targetModel.id}`);
			expect(settings.getModelRole("default")).toBe(`${targetModel.provider}/${targetModel.id}:high`);
			expect(settings.get("compaction.enabled")).toBe(true);
			expect(session.sessionId).toBe(sessionId);
			expect(session.messages).toEqual(messages);
			expect(harness.editor.getText()).toBe(composer);
			expect(requestProfileSwitch).not.toHaveBeenCalled();

			harness.showHookSelector.mockResolvedValue("Start a new session");
			const switched = Promise.withResolvers<void>();
			requestProfileSwitch.mockImplementation(async () => {
				switched.resolve();
			});
			dashboard.handleInput("\x1b[B");
			dashboard.handleInput("l");
			await switched.promise;
			expect(requestProfileSwitch).toHaveBeenCalledWith(expect.any(String), "activation");
			expect(session.sessionId).toBe(sessionId);
			expect(session.messages).toEqual(messages);
			expect(settings.get("compaction.enabled")).toBe(true);
			expect(harness.editor.getText()).toBe(composer);
			const saved = await profileSetups.loadSavedSetup("activation", tempDir.path());
			expect(saved.metadata.enabledGroups).toEqual(["context"]);
			expect(saved.config.compaction).toEqual({ enabled: false });
		} finally {
			settings?.cancelPendingSaves();
			await session?.dispose();
			authStorage.close();
		}
	});

	test("saved group changes capture inherited values only when the editor is saved", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-group-save-");
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"compaction.enabled": true,
		});
		await Bun.write(
			tempDir.join("config.yml"),
			YAML.stringify({ compaction: { enabled: false, midTurnEnabled: false } }, null, 2),
		);
		const opened = await openSavedProfileEditor(
			tempDir.path(),
			{
				metadata: { version: 1, enabledGroups: [] },
				config: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } },
			},
			"group-save-session",
			settings,
		);
		try {
			opened.harness.showHookConfirm.mockResolvedValue(true);
			opened.editor.handleInput("Context inclusion");
			opened.editor.handleInput("\r");
			const beforeSave = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(beforeSave.metadata.enabledGroups).toEqual([]);
			expect(beforeSave.config.compaction).toBeUndefined();
			expect(settings.get("compaction.enabled")).toBe(true);

			const savedNotice = Promise.withResolvers<void>();
			const setActionNotice = opened.dashboard.setActionNotice.bind(opened.dashboard);
			vi.spyOn(opened.dashboard, "setActionNotice").mockImplementation((message, tone) => {
				setActionNotice(message, tone);
				if (typeof message !== "string") return;
				if (tone === "error") savedNotice.reject(new Error(message));
				else if (message.includes("Saved profile beta")) savedNotice.resolve();
			});
			opened.editor.handleInput("\x1b");
			opened.editor.handleInput("\x13");
			await savedNotice.promise;

			const saved = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(saved.metadata.enabledGroups).toEqual(["context"]);
			expect(saved.config.compaction).toMatchObject({ enabled: false, midTurnEnabled: false });
			expect(settings.get("compaction.enabled")).toBe(true);
			expect(opened.harness.context.requestProfileSwitch).not.toHaveBeenCalled();
		} finally {
			settings.cancelPendingSaves();
			opened.authStorage.close();
		}
	});

	test("a rejected profile save keeps the edited draft available and retry persists it", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-save-retry-");
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"compaction.enabled": true,
		});
		await Bun.write(
			tempDir.join("config.yml"),
			YAML.stringify({ compaction: { enabled: false, midTurnEnabled: false } }, null, 2),
		);
		const opened = await openSavedProfileEditor(
			tempDir.path(),
			{
				metadata: { version: 1, enabledGroups: [] },
				config: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } },
			},
			"save-retry-session",
			settings,
		);
		try {
			opened.harness.showHookConfirm.mockResolvedValue(true);
			opened.editor.handleInput("Context inclusion");
			opened.editor.handleInput("\r");
			const hidesBeforeSave = opened.harness.hide.mock.calls.length;
			const visibilityCallsBeforeSave = opened.harness.setHidden.mock.calls.length;
			const save = vi
				.spyOn(profileSetups, "saveProfileDraft")
				.mockRejectedValueOnce(new Error("Fixture disk save failed"));
			const saveFailureVisible = Promise.withResolvers<void>();
			opened.harness.render.mockImplementation(() => {
				if (
					opened.editor.render(100).map(stripVTControlCharacters).join("\n").includes("Fixture disk save failed")
				) {
					saveFailureVisible.resolve();
				}
			});
			opened.editor.handleInput("\x13");
			await saveFailureVisible.promise;

			expect(save).toHaveBeenCalledTimes(1);
			expect(opened.harness.hide).toHaveBeenCalledTimes(hidesBeforeSave);
			expect(opened.harness.setHidden.mock.calls.slice(visibilityCallsBeforeSave)).toEqual([[true], [false]]);
			expect(opened.editor.draft.metadata.enabledGroups).toEqual(["context"]);
			expect(opened.editor.render(100).map(stripVTControlCharacters).join("\n")).toContain(
				"Fixture disk save failed",
			);
			const unchanged = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(unchanged.metadata.enabledGroups).toEqual([]);

			const savedNotice = Promise.withResolvers<void>();
			const setActionNotice = opened.dashboard.setActionNotice.bind(opened.dashboard);
			vi.spyOn(opened.dashboard, "setActionNotice").mockImplementation((message, tone) => {
				setActionNotice(message, tone);
				if (tone === "error") savedNotice.reject(new Error(message ?? "Profile save failed"));
				else if (message?.includes("Saved profile beta")) savedNotice.resolve();
			});
			opened.editor.handleInput("\x13");
			await savedNotice.promise;

			expect(save).toHaveBeenCalledTimes(2);
			const retried = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(retried.metadata.enabledGroups).toEqual(["context"]);
			expect(retried.config.compaction).toMatchObject({ enabled: false, midTurnEnabled: false });
		} finally {
			settings.cancelPendingSaves();
			opened.authStorage.close();
		}
	});

	test("cancelling a saved group removal preserves the profile and active settings", async () => {
		using tempDir = TempDir.createSync("@omp-profile-controller-group-cancel-");
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"compaction.enabled": true,
		});
		const opened = await openSavedProfileEditor(
			tempDir.path(),
			{
				metadata: { version: 1, enabledGroups: ["context"] },
				config: {
					modelRoles: { default: "anthropic/claude-sonnet-4-5" },
					compaction: { enabled: false, midTurnEnabled: false },
				},
			},
			"group-cancel-session",
			settings,
		);
		try {
			const before = await profileSetups.loadSavedSetup("beta", tempDir.path());
			const originalBytes = await Bun.file(before.path).bytes();
			opened.editor.handleInput("Context inclusion");
			opened.editor.handleInput("\r");
			opened.editor.handleInput("\r");
			opened.editor.handleInput("\x1b");
			const cancelled = opened.harness.waitForNextRender();
			opened.editor.handleInput("\x1b");
			await cancelled;

			expect(await Bun.file(before.path).bytes()).toEqual(originalBytes);
			const preserved = await profileSetups.loadSavedSetup("beta", tempDir.path());
			expect(preserved.metadata.enabledGroups).toEqual(["context"]);
			expect(preserved.config.compaction).toMatchObject({ enabled: false, midTurnEnabled: false });
			expect(settings.get("compaction.enabled")).toBe(true);
			expect(opened.harness.context.requestProfileSwitch).not.toHaveBeenCalled();
		} finally {
			settings.cancelPendingSaves();
			opened.authStorage.close();
		}
	});

	test("returning after a local setting change rebuilds live and inherited previews without recollecting fresh usage", async () => {
		const settings = Settings.isolated();
		settings.set("compaction.enabled", true);
		try {
			const harness = controllerHarness({ settings });
			const usage = Promise.withResolvers<usageCli.UsageSnapshotCollection>();
			harness.collectUsage.mockReturnValue(usage.promise);
			vi.spyOn(profileSnapshots, "buildProfileSnapshot").mockImplementation(async buildOptions => {
				const value = snapshot(buildOptions.profile);
				value.roles[0]!.modelId = buildOptions.settings.get("compaction.enabled") ? "live-on" : "live-off";
				return value;
			});
			let inspections = 0;
			vi.spyOn(profileClient, "inspectProfile").mockImplementation(async (_profile, request) => {
				const value = snapshot(request.setup ?? "current");
				value.roles[0]!.modelId = ++inspections === 1 ? "inherited-on" : "inherited-off";
				return value;
			});
			const initialCurrentReady = harness.waitForCurrentSnapshot();
			const initialSavedReady = harness.waitForSavedSnapshot("beta");
			await harness.controller.showSettingsSelector("profiles");
			usage.resolve({
				snapshot: snapshot("anthropic", [quotaReport()]).usage!,
				accounts: [],
				storedAccountCount: 1,
			});
			await Promise.all([initialCurrentReady, initialSavedReady]);
			const settingsSelector = harness.settingsSelectors[0]!;
			const dashboard = harness.mounted[0]!;
			expect(plain(dashboard, 120)).toContain("live-on");

			settings.set("compaction.enabled", false);
			const currentRefreshed = harness.waitForCurrentSnapshot();
			const savedRefreshed = harness.waitForSavedSnapshot("beta");
			settingsSelector.selectTab("appearance");
			settingsSelector.selectTab("profiles");
			await Promise.all([currentRefreshed, savedRefreshed]);
			expect(plain(dashboard, 120)).toContain("live-off");
			dashboard.handleInput("\x1b[B");
			expect(plain(dashboard, 120)).toContain("inherited-off");
			expect(harness.collectUsage).toHaveBeenCalledTimes(1);
			expect(harness.mounted).toHaveLength(1);
		} finally {
			settings.cancelPendingSaves();
		}
	});

	test("a tab-return refresh supersedes older inspection work, and closing cancels remaining work", async () => {
		const harness = controllerHarness();
		const old = Promise.withResolvers<ProfileSnapshot>();
		const current = Promise.withResolvers<ProfileSnapshot>();
		const closing = Promise.withResolvers<ProfileSnapshot>();
		const refreshStarted = Promise.withResolvers<void>();
		const closingRefreshStarted = Promise.withResolvers<void>();
		const requests = [old, current, closing];
		const signals: AbortSignal[] = [];
		vi.spyOn(profileClient, "inspectProfile").mockImplementation((_profile, _request, signal) => {
			signals.push(signal);
			if (signals.length === 2) refreshStarted.resolve();
			if (signals.length === 3) closingRefreshStarted.resolve();
			return requests[signals.length - 1]!.promise;
		});
		await harness.controller.showSettingsSelector("profiles");
		const settingsSelector = harness.settingsSelectors[0]!;
		const dashboard = harness.mounted[0]!;
		dashboard.render(120);
		dashboard.handleInput("\x1b[B");
		settingsSelector.selectTab("appearance");
		settingsSelector.selectTab("profiles");
		await refreshStarted.promise;
		const newer = snapshot("beta");
		newer.roles[0]!.modelId = "newest-fixture-model";
		current.resolve(newer);
		await current.promise;
		expect(dashboard.selectedSetup).toEqual(savedSetup("beta"));
		expect(plain(dashboard, 120)).toContain("newest-fixture-model");
		const older = snapshot("beta");
		older.roles[0]!.modelId = "obsolete-fixture-model";
		old.resolve(older);
		await old.promise;
		expect(plain(dashboard, 120)).toContain("newest-fixture-model");
		expect(plain(dashboard, 120)).not.toContain("obsolete-fixture-model");
		expect(signals[0]?.aborted).toBe(true);
		harness.settings.set("compaction.enabled", false);
		settingsSelector.selectTab("appearance");
		settingsSelector.selectTab("profiles");
		await closingRefreshStarted.promise;
		settingsSelector.handleInput("\x1b");
		const rendersAfterClose = harness.render.mock.calls.length;
		expect(signals[2]?.aborted).toBe(true);
		closing.resolve(older);
		await closing.promise;
		expect(harness.render.mock.calls.length).toBe(rendersAfterClose);
		expect(harness.mounted).toHaveLength(1);
		expect(harness.hide).toHaveBeenCalledTimes(1);
		expect(harness.focus).toHaveBeenLastCalledWith(harness.editor);
	});

	test("returning to Profiles rediscovers added setups and removes missing names", async () => {
		const harness = controllerHarness();
		const rediscovery = Promise.withResolvers<Array<{ name: string; updatedAt: number }>>();
		const gammaStarted = Promise.withResolvers<void>();
		vi.spyOn(profileSetups, "listSavedSetups")
			.mockResolvedValueOnce([{ name: "beta", updatedAt: NOW }])
			.mockImplementationOnce(() => rediscovery.promise);
		vi.spyOn(profileClient, "inspectProfile").mockImplementation(async (_profile, request) => {
			if (request.setup === "gamma") gammaStarted.resolve();
			return snapshot(request.setup ?? "current");
		});
		await harness.controller.showSettingsSelector("profiles");
		const settingsSelector = harness.settingsSelectors[0]!;
		const dashboard = harness.mounted[0]!;
		expect(plain(dashboard, 120)).toContain("beta");
		settingsSelector.selectTab("appearance");
		settingsSelector.selectTab("profiles");
		rediscovery.resolve([{ name: "gamma", updatedAt: NOW + 1 }]);
		await gammaStarted.promise;
		const refreshed = plain(dashboard, 120);
		expect(refreshed).toContain("gamma");
		expect(refreshed).not.toContain("beta");
		dashboard.handleInput("\x1b");
	});

	test("closing Settings during discovery keeps the loading child from mounting late", async () => {
		const harness = controllerHarness();
		const discovery = Promise.withResolvers<Array<{ name: string; updatedAt: number }>>();
		const discoveryStarted = Promise.withResolvers<void>();
		vi.spyOn(profileSetups, "listSavedSetups").mockImplementation(() => {
			discoveryStarted.resolve();
			return discovery.promise;
		});
		const opening = harness.controller.showSettingsSelector("profiles");
		await discoveryStarted.promise;
		const settingsSelector = harness.settingsSelectors[0]!;
		expect(settingsSelector.render(120).map(stripVTControlCharacters).join("\n")).toContain("Loading profiles");
		settingsSelector.handleInput("\x1b");
		const rendersAfterClose = harness.render.mock.calls.length;
		discovery.resolve([{ name: "beta", updatedAt: NOW }]);
		await opening;
		expect(harness.mounted).toEqual([]);
		expect(harness.render.mock.calls.length).toBe(rendersAfterClose);
		expect(harness.hide).toHaveBeenCalledTimes(1);
		expect(harness.focus).toHaveBeenLastCalledWith(harness.editor);
	});

	test("repeated direct Profiles opens share one parent and await the same child mount", async () => {
		const harness = controllerHarness();
		const discovery = Promise.withResolvers<Array<{ name: string; updatedAt: number }>>();
		const discoveryStarted = Promise.withResolvers<void>();
		vi.spyOn(profileSetups, "listSavedSetups").mockImplementation(() => {
			discoveryStarted.resolve();
			return discovery.promise;
		});
		const firstOpen = harness.controller.showSettingsSelector("profiles");
		await discoveryStarted.promise;
		const secondOpen = harness.controller.showSettingsSelector("profiles");
		expect(harness.settingsSelectors).toHaveLength(1);
		discovery.resolve([{ name: "beta", updatedAt: NOW }]);
		await Promise.all([firstOpen, secondOpen]);
		expect(harness.mounted).toHaveLength(1);
		harness.settingsSelectors[0]!.handleInput("\x1b");
		expect(harness.hide).toHaveBeenCalledTimes(1);
	});

	test("a saved setup preview survives a refresh outage without losing shared quota windows", async () => {
		const harness = controllerHarness();
		const unavailable = snapshot("beta");
		unavailable.warnings.push("Usage unavailable");
		const betaReport = quotaReport();
		betaReport.limits[0]!.amount.usedFraction = 0.43;
		betaReport.limits[1]!.amount.usedFraction = 0.77;
		harness.collectUsage.mockResolvedValue({
			snapshot: snapshot("anthropic", [betaReport]).usage!,
			accounts: [],
			storedAccountCount: 1,
		});
		const loaded = Promise.resolve(snapshot("beta"));
		const failed = Promise.resolve(unavailable);
		const failedRefreshStarted = Promise.withResolvers<void>();
		vi.spyOn(profileClient, "inspectProfile")
			.mockImplementationOnce(() => loaded)
			.mockImplementationOnce(() => {
				failedRefreshStarted.resolve();
				return failed;
			});
		await harness.controller.showSettingsSelector("profiles");
		await loaded;
		const settingsSelector = harness.settingsSelectors[0]!;
		const dashboard = harness.mounted[0]!;
		dashboard.render(120);
		dashboard.handleInput("\x1b[B");
		harness.settings.set("compaction.enabled", false);
		settingsSelector.selectTab("appearance");
		settingsSelector.selectTab("profiles");
		await failedRefreshStarted.promise;
		await failed;
		dashboard.handleInput("\t");
		const height = dashboard.render(120).length;
		const text = pageOverviewUntil(dashboard, 120, height, "23%");
		expect(text).toContain("57%");
		expect(text).toContain("23%");
		expect(text.toLowerCase()).toMatch(/stale|unavailable|failed/);
		dashboard.handleInput("\x1b");
	});
});
