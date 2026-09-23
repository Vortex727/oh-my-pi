import { TERMINAL } from "@oh-my-pi/pi-tui";
import { SETTING_TABS, type SettingsDisplayEntry, type SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { normalizeProviderMaxInFlightRequests, settings, validateProviderMaxInFlightRequests } from "./settings";
import {
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	type SettingPath,
} from "./settings-schema";

export interface SettingsHostSource {
	get(path: SettingPath): unknown;
	set(path: SettingPath, value: unknown): void;
}

export interface CreateSettingsHostOptions {
	/** Read/write source. Supplying one prevents writes to the live Settings singleton. */
	source?: SettingsHostSource;
	/** Optional condition overrides keyed by schema `ui.condition`. */
	conditions?: Readonly<Record<string, () => boolean>>;
}

function createConditions(source: SettingsHostSource): Record<string, () => boolean> {
	const equals = (path: SettingPath, value: unknown) => (): boolean => {
		try {
			return source.get(path) === value;
		} catch {
			return false;
		}
	};
	return {
		macOS: () => process.platform === "darwin",
		hasImageProtocol: () => !!TERMINAL.imageProtocol,
		advisorEnabled: equals("advisor.enabled", true),
		vimModeEnabled: equals("tui.vimMode", true),
		hindsightActive: equals("memory.backend", "hindsight"),
		mnemopiActive: equals("memory.backend", "mnemopi"),
		autolearnActive: equals("autolearn.enabled", true),
		autoThinkingActive: equals("defaultThinkingLevel", "auto"),
		usageAwareFallbackEnabled: equals("retry.usageAwareFallback", true),
		planModeEnabled: equals("plan.enabled", true),
		planAutosaveEnabled: () => {
			try {
				return source.get("plan.enabled") === true && source.get("plan.autosave") === true;
			} catch {
				return false;
			}
		},
		unexpectedStopSmart: equals("features.unexpectedStopDetection", "smart"),
	};
}

/** Adapt the application schema and a supplied settings source to the terminal overlay. */
export function createSettingsHost(options: CreateSettingsHostOptions = {}): SettingsHost {
	const source: SettingsHostSource = options.source ?? {
		get: path => settings.get(path),
		set: (path, value) => settings.set(path, value as never),
	};
	const conditions = { ...createConditions(source), ...options.conditions };
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const ui = getUi(path);
			entries.push({
				path,
				type: getType(path),
				defaultValue: getDefault(path),
				ui,
				enumValues: getEnumValues(path),
				credential: isCredential(path),
				condition: ui?.condition ? conditions[ui.condition] : undefined,
			});
		}
	}
	return {
		entries,
		get: path => source.get(path as SettingPath),
		set: (path, value) => source.set(path as SettingPath, value),
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
