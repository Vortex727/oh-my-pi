import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEexist, isEnoent, stringifyYamlConfig } from "@oh-my-pi/pi-utils";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	MAX_THINKING_SUFFIX_OPTIONS,
	parseModelString,
	splitThinkingSuffix,
} from "@oh-my-pi/pi-tui/overlays/model-selector";
import { AUTO_THINKING, resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { YAML } from "bun";
import {
	normalizeModelPatternList,
	parseModelPattern,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "../config/model-resolver";
import {
	DEFAULT_MODEL_ROLE_ALIAS,
	getRoleInfo,
	LEGACY_MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_IDS,
	roleCandidatePool,
} from "../config/model-roles";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { readBoundedRegularTextFile } from "./bounded-file";
import type { ModelRoleAssignments, ModelRoleImportRow } from "./types";

const PORTABLE_FORMAT = "omp-model-roles";
const PORTABLE_VERSION = 1;
const MAX_PORTABLE_FILE_BYTES = 1024 * 1024;
const MAX_SELECTOR_REFERENCE_DEPTH = 32;
const MAX_SELECTOR_REFERENCE_WORK = 10_000;

function invalidArtifact(): Error {
	return new Error("Model roles file is invalid");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function copyAssignments(value: unknown): ModelRoleAssignments {
	if (!isPlainRecord(value) || Object.keys(value).length > 1_000) throw invalidArtifact();
	const result: ModelRoleAssignments = Object.create(null);
	let totalBytes = 0;
	for (const role of Object.keys(value)) {
		if (role === "__proto__" || role === "constructor" || role === "prototype") throw invalidArtifact();
		totalBytes += Buffer.byteLength(role);
		const selector = value[role];
		if (selector !== null && (typeof selector !== "string" || selector.length > 64 * 1024)) throw invalidArtifact();
		if (typeof selector === "string") totalBytes += Buffer.byteLength(selector);
		if (totalBytes > MAX_PORTABLE_FILE_BYTES) throw new Error("Model roles file is too large");
		result[role] = selector;
	}
	return result;
}

export function validateModelRolesArtifact(value: unknown): ModelRoleAssignments {
	if (!isPlainRecord(value)) throw invalidArtifact();
	const keys = Object.keys(value);
	if (
		keys.length !== 3 ||
		!Object.hasOwn(value, "format") ||
		!Object.hasOwn(value, "version") ||
		!Object.hasOwn(value, "modelRoles") ||
		value.format !== PORTABLE_FORMAT ||
		value.version !== PORTABLE_VERSION
	) {
		throw invalidArtifact();
	}
	return copyAssignments(value.modelRoles);
}

/** Serialize model assignments without setup, account, task, or credential metadata. */
export function serializeModelRoles(roles: ModelRoleAssignments): string {
	const modelRoles = copyAssignments(roles);
	const content = stringifyYamlConfig({ format: PORTABLE_FORMAT, version: PORTABLE_VERSION, modelRoles });
	if (Buffer.byteLength(content) > MAX_PORTABLE_FILE_BYTES) throw new Error("Model roles file is too large");
	return content;
}

/** Parse the strict, versioned portable model-role schema. */
export function parseModelRoles(content: string): ModelRoleAssignments {
	if (Buffer.byteLength(content) > MAX_PORTABLE_FILE_BYTES) throw new Error("Model roles file is too large");
	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch {
		throw invalidArtifact();
	}
	return validateModelRolesArtifact(parsed);
}

/** Read a bounded, regular portable role artifact without exposing parser excerpts. */
export async function readModelRolesFile(filePath: string): Promise<ModelRoleAssignments> {
	const content = await readBoundedRegularTextFile(filePath, MAX_PORTABLE_FILE_BYTES, {
		invalid: "Model roles file is invalid",
		notFound: "Model roles file was not found",
		failed: "Failed to read model roles file",
		tooLarge: "Model roles file is too large",
	});
	return parseModelRoles(content);
}

/** Create a portable role artifact atomically; an existing path is never replaced. */
export async function writeModelRolesFile(filePath: string, roles: ModelRoleAssignments): Promise<void> {
	const content = serializeModelRoles(roles);
	const directory = path.dirname(filePath);
	try {
		const stats = await fs.lstat(directory);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("invalid-directory");
	} catch (error) {
		if (isEnoent(error)) throw new Error("The selected directory does not exist");
		throw new Error("Failed to write model roles file");
	}

	const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
	let removeTemp = false;
	try {
		const handle = await fs.open(tempPath, "wx", 0o600);
		removeTemp = true;
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fs.link(tempPath, filePath);
		} catch (error) {
			if (isEexist(error)) {
				throw new Error("A file already exists at the selected path");
			}
			throw new Error("Failed to write model roles file");
		}
		await fs.rm(tempPath);
		removeTemp = false;
	} finally {
		if (removeTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
	}
}

type RoleLookup = { getModelRole(role: string): string | undefined };
type ReferenceIssue = "cycle" | "invalid" | "thinking" | "complexity";
type ReferenceInspection = { work: number };

function roleReference(pattern: string, knownRoles: ReadonlySet<string>): string | undefined {
	const normalized = pattern.trim();
	if (normalized === DEFAULT_MODEL_ROLE_ALIAS || normalized.startsWith(`${DEFAULT_MODEL_ROLE_ALIAS}:`)) {
		const { base } = splitThinkingSuffix(normalized, 0, MAX_THINKING_SUFFIX_OPTIONS);
		return base === DEFAULT_MODEL_ROLE_ALIAS ? "default" : undefined;
	}
	if (normalized.startsWith("@")) {
		const { base } = splitThinkingSuffix(normalized, 1, MAX_THINKING_SUFFIX_OPTIONS);
		return base.length > 1 ? base.slice(1) : "";
	}
	if (normalized.startsWith(LEGACY_MODEL_ROLE_ALIAS_PREFIX)) {
		const { base } = splitThinkingSuffix(
			normalized,
			LEGACY_MODEL_ROLE_ALIAS_PREFIX.length,
			MAX_THINKING_SUFFIX_OPTIONS,
		);
		const role = base.slice(LEGACY_MODEL_ROLE_ALIAS_PREFIX.length);
		return knownRoles.has(role) ? role : undefined;
	}
	return undefined;
}

function hasInvalidRoleThinkingSuffix(pattern: string, knownRoles: ReadonlySet<string>): boolean {
	const normalized = pattern.trim();
	if (normalized.startsWith(`${DEFAULT_MODEL_ROLE_ALIAS}:`)) {
		return splitThinkingSuffix(normalized, 0, MAX_THINKING_SUFFIX_OPTIONS).base === normalized;
	}
	let prefix: string | undefined;
	if (normalized.startsWith("@")) prefix = "@";
	else if (normalized.startsWith(LEGACY_MODEL_ROLE_ALIAS_PREFIX)) prefix = LEGACY_MODEL_ROLE_ALIAS_PREFIX;
	if (!prefix) return false;
	const colon = normalized.lastIndexOf(":");
	if (colon <= prefix.length) return false;
	if (splitThinkingSuffix(normalized, prefix.length, MAX_THINKING_SUFFIX_OPTIONS).base !== normalized) return false;
	const fullRole = normalized.slice(prefix.length);
	const roleWithoutSuffix = normalized.slice(prefix.length, colon);
	return !knownRoles.has(fullRole) && knownRoles.has(roleWithoutSuffix);
}

function inspectRoleReferences(
	role: string,
	lookup: RoleLookup,
	knownRoles: ReadonlySet<string>,
	visiting = new Set<string>(),
	inspection: ReferenceInspection = { work: 0 },
	depth = 0,
): ReferenceIssue | undefined {
	inspection.work += 1;
	if (depth > MAX_SELECTOR_REFERENCE_DEPTH || inspection.work > MAX_SELECTOR_REFERENCE_WORK) return "complexity";
	if (visiting.has(role)) return "cycle";
	const selector = lookup.getModelRole(role);
	if (selector === undefined) {
		return MODEL_ROLE_IDS.some(candidate => candidate === role) ? undefined : "invalid";
	}
	const nextVisiting = new Set(visiting);
	nextVisiting.add(role);
	for (const pattern of normalizeModelPatternList(selector)) {
		inspection.work += 1;
		if (inspection.work > MAX_SELECTOR_REFERENCE_WORK) return "complexity";
		if (hasInvalidRoleThinkingSuffix(pattern, knownRoles)) return "thinking";
		const reference = roleReference(pattern, knownRoles);
		if (reference === undefined) continue;
		if (!reference || !knownRoles.has(reference)) return "invalid";
		const nested = inspectRoleReferences(reference, lookup, knownRoles, nextVisiting, inspection, depth + 1);
		if (nested) return nested;
	}
	return undefined;
}

type ModelSelectorImportRow = Omit<ModelRoleImportRow, "role">;

function needsSelectorReview(selector: string, message: string): ModelSelectorImportRow {
	return { selector, status: "needs-review", message };
}

function resolvedSelectorRow(
	selector: string,
	status: ModelRoleImportRow["status"],
	model: Model<Api>,
	thinkingLevel: ModelRoleImportRow["thinkingLevel"],
	message?: string,
): ModelSelectorImportRow {
	return {
		selector,
		status,
		provider: model.provider,
		modelId: model.id,
		thinkingLevel,
		message,
	};
}

function isAmbiguousBareSelector(pattern: string, models: readonly Model<Api>[]): boolean {
	const normalized = pattern.trim();
	if (!normalized || normalized.includes("/")) return false;
	let id = normalized;
	let matches = 0;
	for (const model of models) {
		if (model.id.toLowerCase() === id.toLowerCase()) matches += 1;
	}
	if (matches > 0) return matches > 1;
	id = splitThinkingSuffix(normalized, -1, MAX_THINKING_SUFFIX_OPTIONS).base;
	if (id === normalized) return false;
	for (const model of models) {
		if (model.id.toLowerCase() === id.toLowerCase()) matches += 1;
	}
	return matches > 1;
}

function inspectSelectorReferences(
	selector: string,
	lookup: RoleLookup,
	knownRoles: ReadonlySet<string>,
	visiting = new Set<string>(),
	inspection: ReferenceInspection = { work: 0 },
	depth = 0,
): ReferenceIssue | undefined {
	if (depth > MAX_SELECTOR_REFERENCE_DEPTH) return "complexity";
	for (const pattern of normalizeModelPatternList(selector)) {
		inspection.work += 1;
		if (inspection.work > MAX_SELECTOR_REFERENCE_WORK) return "complexity";
		if (hasInvalidRoleThinkingSuffix(pattern, knownRoles)) return "thinking";
		const reference = roleReference(pattern, knownRoles);
		if (reference === undefined) continue;
		if (!reference || !knownRoles.has(reference)) return "invalid";
		if (visiting.has(reference)) return "cycle";
		const referencedSelector = lookup.getModelRole(reference);
		if (referencedSelector === undefined) {
			if (MODEL_ROLE_IDS.some(candidate => candidate === reference)) continue;
			return "invalid";
		}
		const nextVisiting = new Set(visiting);
		nextVisiting.add(reference);
		const nested = inspectSelectorReferences(
			referencedSelector,
			lookup,
			knownRoles,
			nextVisiting,
			inspection,
			depth + 1,
		);
		if (nested) return nested;
	}
	return undefined;
}

function roleReferencesExceedBudget(
	roles: Iterable<string>,
	lookup: RoleLookup,
	knownRoles: ReadonlySet<string>,
): boolean {
	const inspection: ReferenceInspection = { work: 0 };
	for (const role of roles) {
		if (inspectRoleReferences(role, lookup, knownRoles, new Set(), inspection) === "complexity") return true;
	}
	return false;
}

interface SelectorModelPools {
	allModels: Model<Api>[];
	availableModels: Model<Api>[];
	accepts?: (model: Model<Api>) => boolean;
}

type RolePoolCache = Map<(model: Model<Api>) => boolean, SelectorModelPools>;

function selectorModelPools(
	role: string | undefined,
	settings: Settings,
	modelRegistry: ModelRegistry,
	cache: RolePoolCache,
): SelectorModelPools {
	if (role === undefined) {
		return { allModels: modelRegistry.getAll(), availableModels: modelRegistry.getAvailable() };
	}
	const accepts = getRoleInfo(role, settings).accepts;
	const cached = cache.get(accepts);
	if (cached) return cached;
	const pools = {
		allModels: modelRegistry.getAll("all").filter(accepts),
		availableModels: roleCandidatePool(role, settings, modelRegistry),
		accepts,
	};
	cache.set(accepts, pools);
	return pools;
}

function projectSelectorImportRow(
	selector: string | null,
	referenceIssue: ReferenceIssue | undefined,
	roleLookup: RoleLookup,
	recipientSettings: Settings,
	modelRegistry: ModelRegistry,
	role?: string,
	rolePoolCache: RolePoolCache = new Map(),
): ModelSelectorImportRow {
	if (selector === null) return { selector, status: "automatic" };
	if (!selector.trim()) return needsSelectorReview(selector, "The imported selector is empty.");
	if (referenceIssue === "cycle") {
		return needsSelectorReview(selector, "The imported selector contains a model-role reference cycle.");
	}
	if (referenceIssue === "invalid") {
		return needsSelectorReview(selector, "The imported selector references an unknown model role.");
	}
	if (referenceIssue === "thinking") {
		return needsSelectorReview(selector, "The imported role reference uses an unsupported thinking level.");
	}
	if (referenceIssue === "complexity") {
		return needsSelectorReview(selector, "The imported selector expands beyond the supported model-role limit.");
	}

	const { allModels, availableModels, accepts } = selectorModelPools(
		role,
		recipientSettings,
		modelRegistry,
		rolePoolCache,
	);
	const disabledProviders = new Set(recipientSettings.get("disabledProviders"));
	const allResolution = resolveModelRoleValue(selector, allModels, {
		settings: recipientSettings,
		roleLookup,
	});
	const availableResolution = resolveModelRoleValue(selector, availableModels, {
		settings: recipientSettings,
		roleLookup,
	});
	const resolution = availableResolution.model ? availableResolution : allResolution;
	const patterns = resolveConfiguredModelPatterns(selector, roleLookup);
	if (!resolution.model && accepts) {
		const unrestricted = resolveModelRoleValue(selector, modelRegistry.getAll("all"), {
			settings: recipientSettings,
			roleLookup,
		});
		if (unrestricted.model && !accepts(unrestricted.model)) {
			return resolvedSelectorRow(
				selector,
				"needs-review",
				unrestricted.model,
				unrestricted.thinkingLevel,
				"The selected model does not support this model role.",
			);
		}
	}

	if (resolution.model) {
		if (resolution.warning) {
			return resolvedSelectorRow(
				selector,
				"needs-review",
				resolution.model,
				resolution.thinkingLevel,
				resolution.warning,
			);
		}
		if (disabledProviders.has(resolution.model.provider)) {
			return resolvedSelectorRow(
				selector,
				"needs-review",
				resolution.model,
				resolution.thinkingLevel,
				"The selected provider is disabled in this profile.",
			);
		}

		const matchedPattern =
			resolution.matchedPatternIndex === undefined ? undefined : patterns[resolution.matchedPatternIndex];
		const parsed = matchedPattern ? parseModelPattern(matchedPattern, [resolution.model]) : undefined;
		if (parsed?.warning) {
			return resolvedSelectorRow(
				selector,
				"needs-review",
				resolution.model,
				resolution.thinkingLevel,
				parsed.warning,
			);
		}
		if (
			parsed?.explicitThinkingLevel &&
			parsed.thinkingLevel !== undefined &&
			parsed.thinkingLevel !== AUTO_THINKING &&
			parsed.thinkingLevel !== ThinkingLevel.Inherit &&
			resolveThinkingLevelForModel(resolution.model, parsed.thinkingLevel) !== parsed.thinkingLevel
		) {
			return resolvedSelectorRow(
				selector,
				"needs-review",
				resolution.model,
				resolution.thinkingLevel,
				`The selected model does not support the requested ${parsed.thinkingLevel} thinking level.`,
			);
		}
		if (matchedPattern && isAmbiguousBareSelector(matchedPattern, allModels)) {
			return resolvedSelectorRow(
				selector,
				"needs-review",
				resolution.model,
				resolution.thinkingLevel,
				"The selector matches models from multiple local providers; choose the intended provider.",
			);
		}

		if (availableResolution.model || modelRegistry.hasConfiguredAuth(resolution.model)) {
			return resolvedSelectorRow(selector, "ready", resolution.model, resolution.thinkingLevel);
		}
		return resolvedSelectorRow(
			selector,
			"credentials-missing",
			resolution.model,
			resolution.thinkingLevel,
			"The model is known locally, but its provider is not configured for use.",
		);
	}

	const parsed = patterns
		.map(pattern =>
			parseModelString(pattern, {
				...MAX_THINKING_SUFFIX_OPTIONS,
				isLiteralModelId: (provider, id) => allModels.some(model => model.provider === provider && model.id === id),
			}),
		)
		.find(candidate => candidate !== undefined);
	if (!parsed) return needsSelectorReview(selector, "The selector could not be resolved unambiguously.");
	if (disabledProviders.has(parsed.provider)) {
		return {
			selector,
			status: "needs-review",
			provider: parsed.provider,
			modelId: parsed.id,
			thinkingLevel: parsed.thinkingLevel,
			message: "The selected provider is disabled in this profile.",
		};
	}
	if (!modelRegistry.hasProvider(parsed.provider)) {
		return {
			selector,
			status: "provider-missing",
			provider: parsed.provider,
			modelId: parsed.id,
			thinkingLevel: parsed.thinkingLevel,
			message: "The selected provider is not configured in this profile.",
		};
	}
	const discovery = modelRegistry.getProviderDiscoveryState(parsed.provider);
	if (modelRegistry.isProviderDiscoveryPending(parsed.provider) || discovery?.status === "unavailable") {
		return {
			selector,
			status: "needs-review",
			provider: parsed.provider,
			modelId: parsed.id,
			thinkingLevel: parsed.thinkingLevel,
			message: "Provider model discovery is not currently available; recheck after configuring the provider.",
		};
	}
	if (discovery?.status === "unauthenticated") {
		return {
			selector,
			status: "credentials-missing",
			provider: parsed.provider,
			modelId: parsed.id,
			thinkingLevel: parsed.thinkingLevel,
			message: "Provider model discovery requires configured credentials.",
		};
	}
	return {
		selector,
		status: "model-missing",
		provider: parsed.provider,
		modelId: parsed.id,
		thinkingLevel: parsed.thinkingLevel,
		message: "The selected provider is configured, but this model is not available locally.",
	};
}

/**
 * Project one imported selector against the proposed role map only.
 * Agent assignments use this path so recipient-only aliases cannot widen imported semantics.
 */
export function projectModelSelectorImport(
	selector: string | null,
	proposedRoles: ModelRoleAssignments,
	recipientSettings: Settings,
	modelRegistry: ModelRegistry,
	role?: string,
): ModelSelectorImportRow {
	const imported = copyAssignments(proposedRoles);
	const knownRoles = new Set(Object.keys(imported));
	const roleLookup: RoleLookup = {
		getModelRole(role) {
			return Object.hasOwn(imported, role) ? (imported[role] ?? undefined) : undefined;
		},
	};
	const referenceIssue =
		selector === null
			? undefined
			: roleReferencesExceedBudget(Object.keys(imported), roleLookup, knownRoles)
				? "complexity"
				: inspectSelectorReferences(selector, roleLookup, knownRoles);
	return projectSelectorImportRow(selector, referenceIssue, roleLookup, recipientSettings, modelRegistry, role);
}

/**
 * Project imported assignments against local catalogue and credential facts.
 * This function performs no refreshes, requests, credential reads, or settings writes.
 */
export function projectModelRoleImport(
	roles: ModelRoleAssignments,
	recipientSettings: Settings,
	modelRegistry: ModelRegistry,
): ModelRoleImportRow[] {
	const imported = copyAssignments(roles);
	const recipientRoles = recipientSettings.getModelRoles();
	const knownRoles = new Set([...MODEL_ROLE_IDS, ...Object.keys(recipientRoles), ...Object.keys(imported)]);
	const roleLookup: RoleLookup = {
		getModelRole(role) {
			if (Object.hasOwn(imported, role)) return imported[role] ?? undefined;
			return recipientSettings.getModelRole(role);
		},
	};
	const exceedsReferenceBudget = roleReferencesExceedBudget(knownRoles, roleLookup, knownRoles);
	const inspection: ReferenceInspection = { work: 0 };
	const rolePoolCache: RolePoolCache = new Map();
	return Object.entries(imported).map(([role, selector]) => ({
		role,
		...projectSelectorImportRow(
			selector,
			exceedsReferenceBudget
				? "complexity"
				: inspectRoleReferences(role, roleLookup, knownRoles, new Set(), inspection),
			roleLookup,
			recipientSettings,
			modelRegistry,
			role,
			rolePoolCache,
		),
	}));
}
