import {
	resolveUsedFraction,
	scopeUsageLimitsForModel,
	type UsageLimit,
	type UsageReport,
	type UsageStatus,
	type UsageUnit,
} from "@oh-my-pi/pi-ai";
import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";
import { collapseSharedUsageReports } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	buildRedactionMap,
	collectProviderWindowResets,
	computeProviderWindowStats,
	type ProfileUsageSnapshot,
	type UsageAccountIdentity,
} from "../cli/usage-cli";

export const PROFILE_USAGE_STALE_MS = 5 * 60 * 1000;

export type ProfileUsageDataState =
	| "available"
	| "no-authenticated-account"
	| "quota-not-reported"
	| "usage-unavailable";

export interface ProfileUsageAccountPresentation {
	type: UsageAccountIdentity["type"];
	label: string;
}

export interface ProfileUsageLimitPresentation {
	id: string;
	label: string;
	provider: string;
	accountLabel: string;
	shared: boolean;
	applicability: "shared" | "model" | "scoped";
	/** Present only when the provider supplied an explicit model scope. */
	modelId?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
	durationMs?: number;
	resetsAt?: number;
	resetLabel?: string;
	usedFraction?: number;
	/** Display-only 0..100 clamp; usedFraction retains provider-reported overage. */
	remainingPercent?: number;
	remainingValue?: number;
	unit: UsageUnit;
	status: UsageStatus;
	fetchedAt: number;
	stale: boolean;
	notes: string[];
}

export interface ProfileUsageSharedWindow {
	window: string;
	durationMs?: number;
	meter?: string;
	accounts: number;
	usedAccounts: number;
	remainingAccounts: number;
	/** Only emitted for a single-account window; multi-account rows use account-equivalent capacity. */
	remainingPercent?: number;
	resetsAt: number[];
	stale: boolean;
}

export interface ProfileProviderUsagePresentation {
	provider: string;
	providerLabel: string;
	state: ProfileUsageDataState;
	fetchedAt?: number;
	stale: boolean;
	sharedWindows: ProfileUsageSharedWindow[];
	scopedLimits: ProfileUsageLimitPresentation[];
	limits: ProfileUsageLimitPresentation[];
	accountsWithoutUsage: ProfileUsageAccountPresentation[];
	notes: string[];
	scopedCapExhausted: boolean;
}

export interface ProfileUsagePresentation {
	state: ProfileUsageDataState;
	generatedAt?: number;
	providers: ProfileProviderUsagePresentation[];
}

export interface ProfileUsageSharing {
	provider: string;
	accountLabel: string;
	kind: "confirmed" | "possible" | "unknown";
	/** Other profiles sharing, or possibly sharing, this account. */
	profiles: string[];
}

const PROFILE_METADATA_KEYS = [
	"email",
	"accountId",
	"projectId",
	"orgId",
	"orgName",
	"plan",
	"planType",
	"currentTierId",
	"currentTierName",
] as const;

const EXACT_IDENTITY_METADATA_KEYS: Partial<Record<(typeof PROFILE_METADATA_KEYS)[number], true>> = {
	email: true,
	accountId: true,
	projectId: true,
	orgId: true,
};

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

function sanitizeProfileText(value: string): string {
	return sanitizeText(
		value.replace(URL_PATTERN, candidate => {
			try {
				return new URL(candidate).hostname || "[endpoint hidden]";
			} catch {
				return "[endpoint hidden]";
			}
		}),
	);
}

function safeEnterpriseHost(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	try {
		return new URL(value).hostname || "[endpoint hidden]";
	} catch {
		return "[endpoint hidden]";
	}
}

/**
 * Narrow a CLI-compatible snapshot to the profile worker protocol. Arbitrary
 * provider metadata and URL credentials never cross the subprocess boundary.
 */
export function sanitizeProfileUsageSnapshot(snapshot: ProfileUsageSnapshot): ProfileUsageSnapshot {
	const reports = snapshot.reports.map(report => {
		const { raw: _raw, ...safeReport } = report as UsageReport;
		let metadata: Record<string, unknown> | undefined;
		if (report.metadata) {
			const allowed: Record<string, unknown> = {};
			for (const key of PROFILE_METADATA_KEYS) {
				const value = report.metadata[key];
				if (typeof value === "string" && value.length > 0) {
					allowed[key] = EXACT_IDENTITY_METADATA_KEYS[key] ? sanitizeText(value) : sanitizeProfileText(value);
				}
			}
			if (Object.keys(allowed).length > 0) metadata = allowed;
		}
		return {
			...safeReport,
			limits: report.limits.map(limit => ({
				...limit,
				label: sanitizeProfileText(limit.label),
				notes: limit.notes?.map(sanitizeProfileText),
				window: limit.window
					? {
							...limit.window,
							label: sanitizeProfileText(limit.window.label),
							resetLabel: limit.window.resetLabel ? sanitizeProfileText(limit.window.resetLabel) : undefined,
						}
					: undefined,
			})),
			notes: report.notes?.map(sanitizeProfileText),
			metadata,
		};
	});
	return {
		generatedAt: snapshot.generatedAt,
		reports,
		accountsWithoutUsage: snapshot.accountsWithoutUsage.map(account => ({
			...account,
			enterpriseUrl: safeEnterpriseHost(account.enterpriseUrl),
		})),
		capacity: Object.fromEntries(
			Object.entries(snapshot.capacity).map(([provider, stats]) => [
				provider,
				stats.map(stat => ({
					...stat,
					window: sanitizeProfileText(stat.window),
					meter: stat.meter ? sanitizeProfileText(stat.meter) : undefined,
				})),
			]),
		),
	};
}

function finite(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function finiteUsedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return finite(resolveUsedFraction(limit));
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		if (finite(amount.used) === undefined || finite(amount.limit) === undefined) return undefined;
		return finite(resolveUsedFraction(limit));
	}
	if (amount.unit === "percent" && amount.used !== undefined) return finite(resolveUsedFraction(limit));
	if (amount.remainingFraction !== undefined && finite(amount.remainingFraction) === undefined) return undefined;
	return finite(resolveUsedFraction(limit));
}

function resolvedStatus(limit: UsageLimit, fraction: number | undefined): UsageStatus {
	if (limit.status && limit.status !== "unknown") return limit.status;
	if (fraction === undefined) return "unknown";
	if (fraction >= 1) return "exhausted";
	if (fraction >= 0.8) return "warning";
	return "ok";
}

function isScopedLimit(limit: UsageLimit): boolean {
	return limit.scope.modelId !== undefined || limit.scope.tier !== undefined || limit.scope.shared === false;
}

function reportIdentity(report: Omit<UsageReport, "raw">): {
	base?: string;
	org?: string;
	orgKey?: string;
	accountId?: string;
	projectId?: string;
	email?: string;
} {
	const metadata = report.metadata ?? {};
	const stringMeta = (key: string): string | undefined => {
		const value = metadata[key];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	};
	const scoped = report.limits.find(
		limit => limit.scope.accountId || limit.scope.projectId || limit.scope.orgId,
	)?.scope;
	const email = stringMeta("email");
	const accountId = stringMeta("accountId") ?? scoped?.accountId;
	const projectId = stringMeta("projectId") ?? scoped?.projectId;
	const orgId = stringMeta("orgId") ?? scoped?.orgId;
	const orgName = stringMeta("orgName");
	return {
		base: email ?? accountId ?? projectId,
		org: orgName ?? orgId,
		orgKey: orgId ?? orgName,
		accountId,
		projectId,
		email,
	};
}

function accountIdentityValues(snapshot: ProfileUsageSnapshot): string[] {
	const values: string[] = [];
	const add = (value: string | undefined): void => {
		if (value) values.push(value);
	};
	for (const report of snapshot.reports) {
		const identity = reportIdentity(report);
		add(identity.base);
		add(identity.org);
	}
	for (const account of snapshot.accountsWithoutUsage) {
		add(account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl);
		add(account.orgName ?? account.orgId);
	}
	return values;
}

function maskedLabel(
	base: string | undefined,
	org: string | undefined,
	redaction: Map<string, string>,
	fallback: string,
): string {
	const label = base ? (redaction.get(base) ?? base) : fallback;
	if (!org || org === base) return label;
	return `${label} · ${redaction.get(org) ?? org}`;
}

function presentLimit(
	report: Omit<UsageReport, "raw">,
	limit: UsageLimit,
	accountLabel: string,
	nowMs: number,
): ProfileUsageLimitPresentation {
	const fraction = finiteUsedFraction(limit);
	const explicitRemaining = finite(limit.amount.remaining);
	const remainingValue =
		explicitRemaining ??
		(finite(limit.amount.limit) !== undefined && finite(limit.amount.used) !== undefined
			? Math.max(0, finite(limit.amount.limit)! - finite(limit.amount.used)!)
			: undefined);
	const scoped = isScopedLimit(limit);
	const modelId = limit.scope.modelId;
	return {
		id: limit.id,
		label: limit.label,
		provider: report.provider,
		accountLabel,
		shared: !scoped,
		applicability: !scoped ? "shared" : modelId ? "model" : "scoped",
		modelId,
		tier: limit.scope.tier,
		windowId: limit.scope.windowId ?? limit.window?.id,
		windowLabel: limit.window?.label,
		durationMs: finite(limit.window?.durationMs),
		resetsAt: finite(limit.window?.resetsAt),
		resetLabel: limit.window?.resetLabel,
		usedFraction: fraction,
		remainingPercent: fraction === undefined ? undefined : Math.min(100, Math.max(0, (1 - fraction) * 100)),
		remainingValue,
		unit: limit.amount.unit,
		status: resolvedStatus(limit, fraction),
		fetchedAt: report.fetchedAt,
		stale: nowMs - report.fetchedAt > PROFILE_USAGE_STALE_MS,
		notes: limit.notes ?? [],
	};
}

function reportHasQuota(report: Omit<UsageReport, "raw">): boolean {
	return report.limits.some(limit => {
		if (finiteUsedFraction(limit) !== undefined) return true;
		const amount = limit.amount;
		return [amount.used, amount.limit, amount.remaining].some(value => finite(value) !== undefined);
	});
}

function providerState(
	reports: Array<Omit<UsageReport, "raw">>,
	accounts: UsageAccountIdentity[],
): ProfileUsageDataState {
	if (reports.some(reportHasQuota)) return "available";
	if (reports.length > 0 || accounts.some(account => account.type === "api_key")) return "quota-not-reported";
	return accounts.length > 0 ? "usage-unavailable" : "no-authenticated-account";
}

/** Build safe, display-ready provider summaries and detail rows. */
export function projectProfileUsage(
	usage: ProfileUsageSnapshot | undefined,
	nowMs = Date.now(),
): ProfileUsagePresentation {
	if (!usage) return { state: "usage-unavailable", providers: [] };
	const snapshot = sanitizeProfileUsageSnapshot(usage);
	const reports = collapseSharedUsageReports(snapshot.reports);
	const redaction = buildRedactionMap(accountIdentityValues(snapshot));
	const providerIds = new Set<string>();
	for (const report of reports) providerIds.add(report.provider);
	for (const account of snapshot.accountsWithoutUsage) providerIds.add(account.provider);
	const providers: ProfileProviderUsagePresentation[] = [];
	for (const provider of [...providerIds].sort((a, b) => a.localeCompare(b))) {
		const providerReports = reports.filter(report => report.provider === provider);
		const missingAccounts = snapshot.accountsWithoutUsage.filter(account => account.provider === provider);
		const limits = providerReports.flatMap((report, index) => {
			const identity = reportIdentity(report);
			const label = maskedLabel(identity.base, identity.org, redaction, `account ${index + 1}`);
			return report.limits.map(limit => presentLimit(report, limit, label, nowMs));
		});
		const sharedReports = providerReports.map(report => ({
			...report,
			limits: report.limits.filter(limit => {
				if (isScopedLimit(limit)) return false;
				return finiteUsedFraction(limit) !== undefined;
			}),
		}));
		const providerStale = providerReports.some(report => nowMs - report.fetchedAt > PROFILE_USAGE_STALE_MS);
		const sharedWindows = computeProviderWindowStats(sharedReports).map(stat => ({
			...stat,
			remainingPercent: stat.accounts === 1 ? Math.min(100, Math.max(0, stat.remainingAccounts * 100)) : undefined,
			resetsAt: collectProviderWindowResets(sharedReports, stat),
			stale: providerStale,
		}));
		const scopedLimits = limits.filter(limit => !limit.shared);
		providers.push({
			provider,
			providerLabel: formatProviderName(provider),
			state: providerState(providerReports, missingAccounts),
			fetchedAt:
				providerReports.length > 0 ? Math.min(...providerReports.map(report => report.fetchedAt)) : undefined,
			stale: providerStale,
			sharedWindows,
			scopedLimits,
			limits,
			accountsWithoutUsage: missingAccounts.map(account => ({
				type: account.type,
				label: maskedLabel(
					account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl,
					account.orgName ?? account.orgId,
					redaction,
					account.type === "api_key" ? "API key" : "OAuth account",
				),
			})),
			notes: [...new Set(providerReports.flatMap(report => report.notes ?? []))],
			scopedCapExhausted: scopedLimits.some(limit => limit.status === "exhausted"),
		});
	}
	const state =
		providers.length === 0
			? "no-authenticated-account"
			: providers.some(provider => provider.state === "available")
				? "available"
				: providers.some(provider => provider.state === "usage-unavailable")
					? "usage-unavailable"
					: "quota-not-reported";
	return { state, generatedAt: snapshot.generatedAt, providers };
}

/**
 * Project quota for one resolved role model. The provider's canonical routing
 * strategy restricts both shared account headroom and scoped rows to meters
 * consumed by that model.
 */
export function projectProfileModelUsage(
	usage: ProfileUsageSnapshot | undefined,
	provider: string,
	modelId: string | undefined,
	nowMs = Date.now(),
): ProfileProviderUsagePresentation | undefined {
	if (!usage) return undefined;
	const reports = usage.reports
		.filter(report => report.provider === provider)
		.map(report => ({
			...report,
			limits: scopeUsageLimitsForModel(report.provider, report, { modelId }),
		}));
	const accountsWithoutUsage = usage.accountsWithoutUsage.filter(account => account.provider === provider);
	const projectedProvider = projectProfileUsage({ ...usage, reports, accountsWithoutUsage }, nowMs).providers[0];
	if (!projectedProvider) return undefined;
	const accountCount = reports.length + accountsWithoutUsage.length;
	return {
		...projectedProvider,
		scopedCapExhausted: accountCount === 1 && projectedProvider.scopedCapExhausted,
	};
}

const UNIT_SUFFIX: Record<UsageUnit, string> = {
	tokens: " tokens",
	requests: " requests",
	credits: " credits",
	minutes: " min",
	bytes: " bytes",
	percent: "",
	usd: "",
	unknown: "",
};

/** Render remaining quota without inventing a percentage for absolute-only limits. */
export function formatProfileUsageRemaining(limit: ProfileUsageLimitPresentation): string {
	if (limit.remainingPercent !== undefined) return `${limit.remainingPercent.toFixed(0)}% left`;
	if (limit.remainingValue !== undefined && limit.unit !== "percent" && limit.unit !== "unknown") {
		const value = limit.unit === "usd" ? `$${limit.remainingValue.toFixed(2)}` : formatNumber(limit.remainingValue);
		return `${value}${UNIT_SUFFIX[limit.unit]} left`;
	}
	return "Quota not reported";
}

interface SharingIdentity {
	provider: string;
	base?: string;
	org?: string;
	orgKey?: string;
	accountId?: string;
	projectId?: string;
	email?: string;
}

function sharingIdentities(snapshot: ProfileUsageSnapshot | undefined): SharingIdentity[] {
	if (!snapshot) return [];
	const safe = sanitizeProfileUsageSnapshot(snapshot);
	const identities: SharingIdentity[] = safe.reports.map(report => ({
		provider: report.provider,
		...reportIdentity(report),
	}));
	for (const account of safe.accountsWithoutUsage) {
		identities.push({
			provider: account.provider,
			base: account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl,
			org: account.orgName ?? account.orgId,
			orgKey: account.orgId ?? account.orgName,
			accountId: account.accountId,
			projectId: account.projectId,
			email: account.email,
		});
	}
	const seen = new Set<string>();
	return identities.filter(identity => {
		const key = JSON.stringify(identity);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function sharingKeys(kind: "strong" | "email", identity: SharingIdentity): string[] {
	const org = identity.orgKey ?? "";
	if (kind === "email") {
		return identity.email ? [`${identity.provider}\0email:${identity.email.toLowerCase()}\0${org}`] : [];
	}
	const keys: string[] = [];
	if (identity.accountId) keys.push(`${identity.provider}\0account:${identity.accountId}\0${org}`);
	if (identity.projectId) keys.push(`${identity.provider}\0project:${identity.projectId}\0${org}`);
	return keys;
}

/** Compare token-free identities; account/project IDs confirm, email alone only suggests sharing. */
export function projectProfileUsageSharing(
	profiles: readonly { profile: string; usage?: ProfileUsageSnapshot }[],
): Record<string, ProfileUsageSharing[]> {
	const identitiesByProfile = new Map(profiles.map(item => [item.profile, sharingIdentities(item.usage)]));
	const allValues = profiles.flatMap(item =>
		accountIdentityValues(item.usage ?? { generatedAt: 0, reports: [], accountsWithoutUsage: [], capacity: {} }),
	);
	const redaction = buildRedactionMap(allValues);
	const result: Record<string, ProfileUsageSharing[]> = {};
	for (const item of profiles) {
		const rows: ProfileUsageSharing[] = [];
		for (const identity of identitiesByProfile.get(item.profile) ?? []) {
			const strong = sharingKeys("strong", identity);
			const email = sharingKeys("email", identity);
			const matching = (keys: string[], kind: "strong" | "email"): string[] => {
				if (keys.length === 0) return [];
				return profiles
					.filter(peer => peer.profile !== item.profile)
					.filter(peer =>
						(identitiesByProfile.get(peer.profile) ?? []).some(candidate =>
							sharingKeys(kind, candidate).some(key => keys.includes(key)),
						),
					)
					.map(peer => peer.profile)
					.sort((a, b) => a.localeCompare(b));
			};
			const confirmed = matching(strong, "strong");
			const possible = confirmed.length === 0 ? matching(email, "email") : [];
			rows.push({
				provider: identity.provider,
				accountLabel: maskedLabel(identity.base, identity.org, redaction, "Account identity unavailable"),
				kind: confirmed.length > 0 ? "confirmed" : possible.length > 0 ? "possible" : "unknown",
				profiles: confirmed.length > 0 ? confirmed : possible,
			});
		}
		result[item.profile] = rows;
	}
	return result;
}
