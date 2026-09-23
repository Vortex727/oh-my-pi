import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelBrowserPerf } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDbPath, sanitizeText } from "@oh-my-pi/pi-utils";
import { buildRedactionMap } from "../cli/usage-cli";
import { getKnownRoleIds, getRoleInfo, roleCandidatePool } from "../config/model-roles";
import {
	pickDefaultAvailableModel,
	resolveAgentModelPatterns,
	resolveModelOverride,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { ModelRegistry } from "../config/model-registry";
import { type Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import type { AuthStorage } from "../session/auth-storage";
import { discoverAgents } from "../task/discovery";
import type { ProfileAgentRow, ProfileRoleRow, ProfileSettingRow, ProfileSnapshot } from "./types";

const UNRESOLVED_MODEL_WARNING =
	"Configured model is unavailable in this offline preview; extension-defined models are not loaded.";

export interface BuildProfileSnapshotOptions {
	profile: string;
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	sessionId?: string;
	currentModel?: Model<Api>;
	/** Active session selector; preserves `auto` rather than the per-turn resolved effort. */
	currentThinkingLevel?: ConfiguredThinkingLevel;
}

function appendCurrentModel(available: Model<Api>[], currentModel: Model<Api> | undefined): Model<Api>[] {
	if (!currentModel) return available;
	if (available.some(model => model.provider === currentModel.provider && model.id === currentModel.id))
		return available;
	return [...available, currentModel];
}

function projectModelCost(model: Model<Api> | undefined): ProfileRoleRow["cost"] {
	const cost = model?.cost;
	if (!cost) return undefined;
	const rates = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
	if (rates.some(rate => !Number.isFinite(rate) || rate < 0)) return undefined;
	// Registry rows use an all-zero card for both unknown and genuinely free pricing,
	// so absent provenance it is safer to leave the preview unpriced.
	if (rates.every(rate => rate === 0)) return undefined;
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
	};
}
function projectFiniteMetric(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function applyProfileModelPerformance(
	roles: ProfileRoleRow[],
	performance: ReadonlyMap<string, ModelBrowserPerf> | undefined,
): void {
	for (const role of roles) {
		delete role.perf;
		if (!role.provider || !role.modelId) continue;
		const perf = performance?.get(`${role.provider}/${role.modelId}`);
		if (
			!perf ||
			!Number.isFinite(perf.samples) ||
			perf.samples <= 0 ||
			!Number.isFinite(perf.tps) ||
			perf.tps <= 0 ||
			(perf.ttftMs !== null && (!Number.isFinite(perf.ttftMs) || perf.ttftMs < 0))
		) {
			continue;
		}
		role.perf = {
			samples: perf.samples,
			tps: perf.tps,
			ttftMs: perf.ttftMs,
		};
	}
}

function projectRoles(
	settings: Settings,
	modelRegistry: ModelRegistry,
	availableChatModels: Model<Api>[],
	currentModel: Model<Api> | undefined,
	currentThinkingLevel: ConfiguredThinkingLevel | undefined,
): ProfileRoleRow[] {
	const automaticDefault =
		currentModel ??
		pickDefaultAvailableModel(availableChatModels, provider => modelRegistry.hasConcreteAuth(provider));
	const rows: ProfileRoleRow[] = [];
	for (const role of getKnownRoleIds(settings)) {
		const roleInfo = getRoleInfo(role, settings);
		if (roleInfo.hidden) continue;
		const selector = settings.getModelRole(role);
		const availableModels =
			role === "default"
				? availableChatModels
				: appendCurrentModel(
						roleCandidatePool(role, settings, modelRegistry),
						currentModel && roleInfo.accepts(currentModel) ? currentModel : undefined,
					);
		const automatic = selector === undefined;
		const activeThinkingLevel =
			role === "default" && currentModel && currentThinkingLevel === undefined && !automatic
				? resolveModelRoleValue(selector, availableModels, { settings }).thinkingLevel
				: currentThinkingLevel;
		const resolved =
			role === "default" && currentModel
				? { model: currentModel, thinkingLevel: activeThinkingLevel, warning: undefined }
				: automatic
					? role === "default"
						? { model: automaticDefault, thinkingLevel: undefined, warning: undefined }
						: { model: undefined, thinkingLevel: undefined, warning: undefined }
					: resolveModelRoleValue(selector, availableModels, { settings });
		rows.push({
			role,
			selector,
			provider: resolved.model?.provider,
			modelId: resolved.model?.id,
			thinkingLevel: resolved.thinkingLevel,
			cost: projectModelCost(resolved.model),
			int: projectFiniteMetric(resolved.model?.int),
			tps: projectFiniteMetric(resolved.model?.tps),
			contextWindow: projectFiniteMetric(resolved.model?.contextWindow),
			automatic,
			warning: automatic || resolved.model ? resolved.warning : (resolved.warning ?? UNRESOLVED_MODEL_WARNING),
		});
	}
	return rows;
}

function configuredSelector(value: string | string[] | undefined): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (!Array.isArray(value)) return undefined;
	const selectors = value.map(item => item.trim()).filter(Boolean);
	return selectors.length > 0 ? selectors.join(",") : undefined;
}

async function projectAgents(
	cwd: string,
	settings: Settings,
	modelRegistry: ModelRegistry,
	defaultModel: Model<Api> | undefined,
	currentModel: Model<Api> | undefined,
): Promise<ProfileAgentRow[]> {
	const { agents } = await discoverAgents(cwd);
	const disabled = new Set(settings.get("task.disabledAgents") ?? []);
	const overrides = settings.get("task.agentModelOverrides") ?? {};
	const activeModelPattern = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
	const fallbackModelPattern = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : undefined;
	return agents.map(agent => {
		const override = Object.hasOwn(overrides, agent.name) ? overrides[agent.name] : undefined;
		const selector = configuredSelector(override) ?? configuredSelector(agent.model);
		const patterns = resolveAgentModelPatterns({
			settingsOverride: override,
			agentModel: agent.model,
			settings,
			activeModelPattern,
			fallbackModelPattern,
		});
		const resolved = resolveModelOverride(patterns, modelRegistry, settings);
		return {
			name: agent.name,
			enabled: !disabled.has(agent.name),
			source: agent.source,
			selector,
			provider: resolved.model?.provider,
			modelId: resolved.model?.id,
			thinkingLevel: resolved.thinkingLevel ?? agent.thinkingLevel,
			warning:
				patterns.length === 0 || resolved.model ? resolved.warning : (resolved.warning ?? UNRESOLVED_MODEL_WARNING),
		};
	});
}

function projectSetting(path: SettingPath, settings: Settings): ProfileSettingRow {
	const definition = SETTINGS_SCHEMA[path];
	const configured = settings.isConfigured(path);
	const ui = "ui" in definition ? definition.ui : undefined;
	const value = settings.get(path);
	let projected: ProfileSettingRow["value"] = null;
	let hidden = true;
	if (ui && definition.type === "boolean" && typeof value === "boolean") {
		projected = value;
		hidden = false;
	} else if (ui && definition.type === "number" && typeof value === "number" && Number.isFinite(value)) {
		projected = value;
		hidden = false;
	} else if (ui && definition.type === "enum" && typeof value === "string") {
		projected = value;
		hidden = false;
	}
	return {
		path,
		label: ui?.label ?? path,
		value: projected,
		hidden,
		configured,
	};
}

function cleanDisplayValue(value: string): string {
	return sanitizeText(value)
		.replace(/[\r\n\t]+/g, " ")
		.trim();
}

function projectMemory(settings: Settings): ProfileSnapshot["memory"] {
	const backend = settings.get("memory.backend");
	if (backend === "hindsight") {
		const bank = settings.get("hindsight.bankId")?.trim();
		const bankPrefix = settings.get("hindsight.bankIdPrefix")?.trim();
		return {
			backend,
			scope: settings.get("hindsight.scoping"),
			storageLabel: bank
				? `Custom storage — may be shared · Bank ${hideEmbeddedUrls(cleanDisplayValue(bank))}`
				: bankPrefix
					? `Custom storage — may be shared · Bank prefix ${hideEmbeddedUrls(cleanDisplayValue(bankPrefix))}`
					: "Custom storage — may be shared · Default bank",
		};
	}
	if (backend === "mnemopi") {
		const scope = settings.get("mnemopi.scoping");
		const bank = settings.get("mnemopi.bank")?.trim();
		const custom = Boolean(settings.get("mnemopi.dbPath")?.trim() || bank || scope !== "per-project");
		return {
			backend,
			scope,
			storageLabel: custom
				? `Custom storage — may be shared${bank ? ` · Bank ${hideEmbeddedUrls(cleanDisplayValue(bank))}` : ""}`
				: "Profile-local default storage",
		};
	}
	if (backend === "sharpshooter") {
		return { backend, scope: "per-project", storageLabel: "Custom storage — may be shared" };
	}
	return {
		backend,
		storageLabel: backend === "local" ? "Profile-local default storage" : "No memory storage",
	};
}

function collectCredentialIdentityStrings(authStorage: AuthStorage): string[] {
	const values: string[] = [];
	for (const entry of Object.values(authStorage.getAll())) {
		const credentials = Array.isArray(entry) ? entry : [entry];
		for (const credential of credentials) {
			if (credential.type !== "oauth") continue;
			for (const value of [
				credential.email,
				credential.accountId,
				credential.projectId,
				credential.orgId,
				credential.orgName,
				credential.enterpriseUrl,
			]) {
				if (typeof value === "string" && value) values.push(value);
			}
		}
	}
	return values;
}

function hideEmbeddedUrls(value: string): string {
	return value.replace(/https?:\/\/[^\s)}>]+/giu, candidate => {
		try {
			return new URL(candidate).hostname || "[endpoint hidden]";
		} catch {
			return "[endpoint hidden]";
		}
	});
}

export function sanitizeCredentialSourceLabel(label: string, authStorage: AuthStorage): string {
	let sanitized = hideEmbeddedUrls(cleanDisplayValue(label));
	const identities = collectCredentialIdentityStrings(authStorage);
	const redaction = buildRedactionMap(identities);
	for (const identity of [...redaction.keys()].sort((left, right) => right.length - left.length)) {
		sanitized = sanitized.replaceAll(identity, redaction.get(identity) ?? identity);
	}
	return sanitized;
}

function projectCredentialSources(
	providers: Iterable<string>,
	authStorage: AuthStorage,
	sessionId: string | undefined,
): Record<string, string> {
	const sources: Record<string, string> = {};
	for (const provider of [...new Set(providers)].sort((left, right) => left.localeCompare(right))) {
		const source = authStorage.describeCredentialSource(provider, sessionId);
		sources[provider] = source ? sanitizeCredentialSourceLabel(source, authStorage) : "No authenticated account";
	}
	return sources;
}

function providersFromSelector(selector: string | undefined): string[] {
	if (!selector) return [];
	const providers: string[] = [];
	for (const candidate of selector.split(",")) {
		const parsed = parseModelString(candidate.trim());
		if (parsed?.provider) providers.push(parsed.provider);
	}
	return providers;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function legacyConfigurationWarnings(agentDir: string): Promise<string[]> {
	const nativeFiles = await Promise.all([
		pathExists(path.join(agentDir, "config.yml")),
		pathExists(path.join(agentDir, "config.yaml")),
	]);
	const hasNative = nativeFiles.some(Boolean);
	if (hasNative) return [];
	const [hasLegacyJson, hasLegacyDb] = await Promise.all([
		pathExists(path.join(agentDir, "settings.json")),
		pathExists(getAgentDbPath(agentDir)),
	]);
	const warnings: string[] = [];
	if (hasLegacyJson) warnings.push("Legacy configuration: launch this profile once to initialize its saved settings");
	if (hasLegacyDb) warnings.push("No native YAML; startup may migrate legacy database settings");
	return warnings;
}

export async function buildProfileSnapshot(options: BuildProfileSnapshotOptions): Promise<ProfileSnapshot> {
	const { profile, cwd, settings, modelRegistry, authStorage, sessionId, currentModel, currentThinkingLevel } =
		options;
	const availableChatModels = appendCurrentModel(modelRegistry.getAvailable(), currentModel);
	const roles = projectRoles(settings, modelRegistry, availableChatModels, currentModel, currentThinkingLevel);
	applyProfileModelPerformance(roles, settings.getStorage()?.getModelPerf());
	const defaultRole = roles.find(role => role.role === "default");
	const defaultModel =
		defaultRole?.provider && defaultRole.modelId
			? availableChatModels.find(
					model => model.provider === defaultRole.provider && model.id === defaultRole.modelId,
				)
			: undefined;
	const agents = await projectAgents(cwd, settings, modelRegistry, defaultModel, currentModel);
	const providers = [
		...roles.flatMap(role => [role.provider, ...providersFromSelector(role.selector)]),
		...agents.flatMap(agent => [agent.provider, ...providersFromSelector(agent.selector)]),
	].filter((provider): provider is string => provider !== undefined);
	const warnings = await legacyConfigurationWarnings(settings.getAgentDir());
	return {
		profile,
		generatedAt: Date.now(),
		agentDir: settings.getAgentDir(),
		credentialSources: projectCredentialSources(providers, authStorage, sessionId),
		roles,
		agents,
		memory: projectMemory(settings),
		settings: (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(path => projectSetting(path, settings)),
		warnings,
	};
}
