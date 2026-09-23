import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { ProfileUsageSnapshot } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { projectProfileModelUsage, projectProfileUsage } from "@oh-my-pi/pi-coding-agent/profiles/usage";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function usage(reports: UsageReport[]): ProfileUsageSnapshot {
	return { generatedAt: NOW, reports, accountsWithoutUsage: [], capacity: {} };
}

function sharedLimit(accountId: string, usedFraction: number): UsageLimit {
	return {
		id: "anthropic:5h",
		label: "5 hours",
		scope: { provider: "anthropic", accountId, windowId: "5h", shared: true },
		window: { id: "5h", label: "5 hours", durationMs: 5 * HOUR, resetsAt: NOW + 5 * HOUR },
		amount: { unit: "percent", usedFraction },
	};
}

function report(accountId: string, limits: UsageLimit[], fetchedAt = NOW): UsageReport {
	return { provider: "anthropic", fetchedAt, metadata: { accountId }, limits };
}

describe("profile model quota projection", () => {
	test("conjoins known scope criteria and excludes unknown applicability", () => {
		const reset = NOW + 7 * 24 * HOUR;
		const limits: UsageLimit[] = [
			sharedLimit("account-a", 0.2),
			{
				id: "sonnet",
				label: "Sonnet weekly",
				scope: { provider: "anthropic", tier: "sonnet", shared: false },
				window: { id: "7d", label: "7 days", durationMs: 7 * 24 * HOUR, resetsAt: reset },
				amount: { unit: "requests", remaining: 120 },
			},
			{
				id: "mixed",
				label: "Different model",
				scope: {
					provider: "anthropic",
					tier: "sonnet",
					modelId: "claude-sonnet-different",
					shared: false,
				},
				amount: { unit: "requests", remaining: 1 },
			},
			{
				id: "opus",
				label: "Opus weekly",
				scope: { provider: "anthropic", tier: "opus", shared: false },
				amount: { unit: "requests", remaining: 1 },
			},
			{
				id: "other-provider",
				label: "Other provider",
				scope: { provider: "openai-codex", tier: "sonnet", shared: false },
				amount: { unit: "requests", remaining: 1 },
			},
		];

		const projected = projectProfileModelUsage(
			usage([report("account-a", limits, NOW - 10 * 60_000)]),
			"anthropic",
			"claude-sonnet-4-5",
			NOW,
		);

		expect(projected?.scopedLimits.map(limit => limit.id)).toEqual(["sonnet"]);
		expect(projected?.scopedLimits[0]).toMatchObject({
			unit: "requests",
			remainingValue: 120,
			resetsAt: reset,
			stale: true,
		});
		expect(projected?.sharedWindows).toEqual([
			expect.objectContaining({ durationMs: 5 * HOUR, remainingPercent: 80, stale: true }),
		]);
		const unknown = projectProfileModelUsage(
			usage([
				{
					provider: "cursor",
					fetchedAt: NOW,
					limits: [
						{
							id: "cursor:shared",
							label: "Shared",
							scope: { provider: "cursor", shared: true },
							window: { id: "monthly", label: "Monthly" },
							amount: { unit: "percent", usedFraction: 0.4 },
						},
						{
							id: "cursor:tier",
							label: "Unknown tier",
							scope: { provider: "cursor", tier: "pro", shared: false },
							amount: { unit: "percent", usedFraction: 0.9 },
						},
					],
				},
			]),
			"cursor",
			"composer-1",
			NOW,
		);
		expect(unknown?.sharedWindows).toHaveLength(1);
		expect(unknown?.scopedLimits).toEqual([]);
	});

	test("routes Codex chat and Spark windows to their canonical model meters", () => {
		const codexReport: UsageReport = {
			provider: "openai-codex",
			fetchedAt: NOW,
			limits: [
				{
					id: "openai-codex:primary",
					label: "5 hours",
					scope: { provider: "openai-codex", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 hours", durationMs: 5 * HOUR },
					amount: { unit: "percent", usedFraction: 0.2 },
				},
				{
					id: "openai-codex:secondary",
					label: "7 days",
					scope: { provider: "openai-codex", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 days", durationMs: 7 * 24 * HOUR },
					amount: { unit: "percent", usedFraction: 0.4 },
				},
				{
					id: "openai-codex:spark:primary",
					label: "5 hours (Spark)",
					scope: {
						provider: "openai-codex",
						tier: "spark",
						modelId: "gpt-5.3-codex-spark",
						windowId: "5h",
						shared: true,
					},
					window: { id: "5h", label: "5 hours", durationMs: 5 * HOUR },
					amount: { unit: "percent", usedFraction: 0.6 },
				},
			],
		};

		const chat = projectProfileModelUsage(usage([codexReport]), "openai-codex", "gpt-5.3-codex", NOW);
		expect(chat?.sharedWindows.map(window => window.durationMs)).toEqual([5 * HOUR, 7 * 24 * HOUR]);
		expect(chat?.scopedLimits).toEqual([]);

		const spark = projectProfileModelUsage(usage([codexReport]), "openai-codex", "gpt-5.3-codex-spark", NOW);
		expect(spark?.sharedWindows).toEqual([]);
		expect(spark?.scopedLimits.map(limit => limit.id)).toEqual(["openai-codex:spark:primary"]);
	});

	test("keeps shared pool headroom and per-account caps without aggregate exhaustion", () => {
		const cap = (accountId: string, usedFraction: number): UsageLimit => ({
			id: "sonnet-weekly",
			label: "Sonnet weekly",
			scope: { provider: "anthropic", accountId, tier: "sonnet", shared: false },
			window: { id: "7d", label: "7 days", resetsAt: NOW + 7 * 24 * HOUR },
			amount: { unit: "percent", usedFraction },
			status: usedFraction >= 1 ? "exhausted" : "ok",
		});
		const projected = projectProfileModelUsage(
			usage([
				report("account-a", [sharedLimit("account-a", 1.5), cap("account-a", 1)]),
				report("account-b", [sharedLimit("account-b", 0.5), cap("account-b", 0.25)]),
			]),
			"anthropic",
			"claude-sonnet-4-5",
			NOW,
		);

		expect(projected?.sharedWindows).toEqual([
			expect.objectContaining({
				accounts: 2,
				remainingAccounts: 0.5,
				remainingPercent: undefined,
			}),
		]);
		expect(projected?.limits.find(limit => limit.id === "anthropic:5h")?.usedFraction).toBe(1.5);
		expect(projected?.scopedLimits.map(limit => limit.status)).toEqual(["exhausted", "ok"]);
		expect(new Set(projected?.scopedLimits.map(limit => limit.accountLabel)).size).toBe(2);
		expect(projected?.scopedCapExhausted).toBe(false);
	});

	test("keeps independent same-duration meters and their resets separate", () => {
		const geminiReset = NOW + HOUR;
		const sharedReset = NOW + 2 * HOUR;
		const antigravity: UsageReport = {
			provider: "google-antigravity",
			fetchedAt: NOW,
			metadata: { accountId: "account-a" },
			limits: [
				{
					id: "google-antigravity:google:default:gemini-5h",
					label: "Gemini",
					scope: { provider: "google-antigravity", accountId: "account-a", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR, resetsAt: geminiReset },
					amount: { unit: "percent", usedFraction: 1 },
				},
				{
					id: "google-antigravity:anthropic:default:3p-5h",
					label: "Claude & GPT (shared)",
					scope: {
						provider: "google-antigravity",
						accountId: "account-a",
						windowId: "5h",
						shared: true,
						sharedGroup: "3p-5h:5h",
					},
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR, resetsAt: sharedReset },
					amount: { unit: "percent", usedFraction: 0.25 },
				},
				{
					id: "google-antigravity:openai:default:3p-5h",
					label: "Claude & GPT (shared)",
					scope: {
						provider: "google-antigravity",
						accountId: "account-a",
						windowId: "5h",
						shared: true,
						sharedGroup: "3p-5h:5h",
					},
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR, resetsAt: sharedReset },
					amount: { unit: "percent", usedFraction: 0.25 },
				},
			],
		};

		const projected = projectProfileUsage(usage([antigravity]), NOW);
		expect(projected.providers[0]?.sharedWindows).toEqual([
			expect.objectContaining({
				meter: "Claude & GPT (shared)",
				remainingPercent: 75,
				resetsAt: [sharedReset],
			}),
			expect.objectContaining({
				meter: "Gemini",
				remainingPercent: 0,
				resetsAt: [geminiReset],
			}),
		]);
	});
});
