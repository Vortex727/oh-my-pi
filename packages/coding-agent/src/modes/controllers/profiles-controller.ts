import * as path from "node:path";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { type Component, type OverlayHandle, Text } from "@oh-my-pi/pi-tui";
import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { getAvailableThemes, theme } from "@oh-my-pi/pi-tui/theme";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { type RawSettings, Settings } from "../../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../../config/settings-schema";
import { applySetupModelRoles } from "../../profiles/apply-model-roles";
import {
	createSetupDraft,
	deleteSavedSetup,
	draftModelRoles,
	type LoadedSetup,
	listSavedSetups,
	loadSavedSetup,
	modelsOnlyDraft,
	parseProfileText,
	readConfigPath,
	readProfileFile,
	renameSavedSetup,
	type SavedSetupDescriptor,
	SetupError,
	saveSetup,
	serializeSetup,
	setSavedSetupEmoji,
	setupOverrides,
	writeProfileFile,
} from "../../profiles/setups";
import { buildProfileSnapshot, projectProfileRoles } from "../../profiles/snapshot";
import type { ProfileDraft, ProfileEmoji, ProfileSnapshot } from "../../profiles/types";
import {
	ProfileDashboard,
	type ProfileDashboardActiveControl,
	type ProfileDashboardSavedSetupRef,
	type ProfileDashboardSetupRef,
} from "../components/profile-dashboard";
import { ProfileEditorComponent } from "../components/profile-editor";
import { createModelBrowserSource } from "../model-browser-source";
import { resolveToCwd } from "../../tools/path-utils";
import { copyToClipboard, readTextFromClipboard } from "../../utils/clipboard";
import type { InteractiveModeContext } from "../types";
import type { AgentsDashboardHostOptions, ModelHubHostOptions } from "./selector-controller";

/** Selector-controller capabilities the Profiles tab reuses instead of duplicating. */
export interface ProfilesHost {
	showFullscreenMenu(component: Component): OverlayHandle;
	showModelHub(options: ModelHubHostOptions): () => void;
	showAgentsDashboard(options: AgentsDashboardHostOptions): Promise<() => void>;
	acquireDefaultRoleMutation(): Promise<() => void>;
}

interface Notice {
	message: string;
	tone: "error" | "success";
}

const CURRENT_SETUP: ProfileDashboardSetupRef = { kind: "current" };
const APPLY_MODELS_CHOICE = "Apply models to this conversation";
const NEW_SESSION_CHOICE = "Start a new session";
const FROM_FILE = "From file";
const FROM_CLIPBOARD = "From clipboard";
const WHOLE_PROFILE = "Whole profile";
const MODELS_ONLY = "Models only";
const TO_FILE = "Save to file";
const TO_CLIPBOARD = "Copy to clipboard";
const REVIEW_IMPORT = "Yes, review it first";
const SAVE_IMPORT = "No, save it now";

interface EditorOptions {
	/** Entries the saved file holds that this version could not load; an overwrite drops them. */
	skipped?: readonly string[];
	title?: string;
	name?: string;
	notice?: string;
}

function skippedSummary(warnings: readonly string[]): string {
	return `${warnings.length} entr${warnings.length === 1 ? "y" : "ies"} this version of omp cannot load: ${cleanText(warnings[0])}`;
}

function setupKey(setup: ProfileDashboardSetupRef): string {
	return setup.kind === "current" ? "current" : `saved\0${setup.name}`;
}

function cleanText(value: unknown): string {
	const sanitized = replaceTabs(sanitizeText(String(value ?? "")));
	return oneLineLabel(sanitized, sanitized.length || 1);
}

function errorText(error: unknown, fallback: string): string {
	return cleanText(error instanceof Error ? error.message : fallback);
}

/**
 * The Profiles tab inside Settings: lists saved setups, previews what each one
 * resolves to, and edits, saves, renames, deletes, or loads them. Previews are
 * built in process from read-only settings, so selecting a setup never changes
 * the running session; only an explicit load does.
 */
export class ProfilesController {
	#dashboard: ProfileDashboard | undefined;
	#selector: SettingsSelectorComponent | undefined;
	#overlay: OverlayHandle | undefined;
	#closeSettings: (() => void) | undefined;
	#descriptors: SavedSetupDescriptor[] = [];
	readonly #snapshots = new Map<string, ProfileSnapshot>();
	readonly #previews = new Map<string, Promise<void>>();
	/** Bumped whenever cached previews go stale; in-flight builds from an older generation are dropped. */
	#generation = 0;
	#busy = false;
	#dialogs = new AbortController();
	#closeChild: (() => void) | undefined;
	/** This session's usage reports, once fetched for the current mount. */
	#usage: UsageReport[] | undefined;
	/** Profiles imported during this run of omp, marked "(New)". Kept across Settings mounts. */
	readonly #imported = new Set<string>();

	constructor(
		private readonly ctx: InteractiveModeContext,
		private readonly host: ProfilesHost,
	) {}

	/** Show the Profiles tab in `selector`, or rediscover setups when it is already shown there. */
	async mount(selector: SettingsSelectorComponent, overlay: OverlayHandle, closeSettings: () => void): Promise<void> {
		if (this.#dashboard && this.#selector === selector) {
			if (!this.#busy) await this.#refresh(this.#dashboard.selectedSetup);
			return;
		}
		this.close();
		this.#selector = selector;
		this.#overlay = overlay;
		this.#closeSettings = closeSettings;
		this.#dialogs = new AbortController();
		let descriptors: SavedSetupDescriptor[];
		try {
			descriptors = await listSavedSetups(this.ctx.settings.getAgentDir());
		} catch (error) {
			logger.warn("Failed to list saved setups", { error: String(error) });
			if (this.#selector === selector) {
				selector.setProfilesContent(
					new Text(theme.fg("error", `Unable to list saved profiles: ${errorText(error, "unknown error")}`), 1, 0),
				);
				this.ctx.ui.requestRender();
			}
			return;
		}
		if (this.#selector !== selector) return;
		this.#descriptors = descriptors;
		const dashboard = new ProfileDashboard({
			setups: this.#setupRefs(),
			terminalHeight: this.ctx.ui.terminal.rows,
			callbacks: {
				requestRender: () => {
					if (this.#dashboard === dashboard) this.ctx.ui.requestRender();
				},
				close: () => this.#closeSettings?.(),
				selected: setup => {
					if (!this.#busy) void this.#preview(setup);
				},
				loadSetup: setup => this.#loadSetup(setup),
				editProfile: setup => this.#editSetup(setup),
				saveCurrentSetup: () => this.#editSetup(CURRENT_SETUP),
				importProfile: () => this.#importProfile(),
				exportProfile: setup => this.#exportProfile(setup),
				deleteSetup: setup => this.#deleteSetup(setup),
				renameSetup: setup => this.#renameSetup(setup),
				openActiveControl: control => this.#openActiveControl(control),
			},
		});
		this.#dashboard = dashboard;
		selector.setProfilesContent(dashboard);
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
		void this.#loadUsage(dashboard);
		await this.#preview(dashboard.selectedSetup ?? CURRENT_SETUP);
	}

	/** Abort dialogs and previews and close child overlays. The Settings overlay itself is closed by its owner. */
	close(): void {
		this.#generation++;
		this.#dialogs.abort();
		this.#closeChild?.();
		this.#closeChild = undefined;
		this.#dashboard?.dispose();
		this.#dashboard = undefined;
		this.#selector = undefined;
		this.#overlay = undefined;
		this.#closeSettings = undefined;
		this.#snapshots.clear();
		this.#previews.clear();
		this.#usage = undefined;
		this.#busy = false;
	}

	#setupRefs(): ProfileDashboardSetupRef[] {
		return [
			CURRENT_SETUP,
			...this.#descriptors.map(item => ({
				kind: "saved" as const,
				name: item.name,
				metadata: item.metadata,
				...(this.#imported.has(item.name) ? { imported: true } : {}),
			})),
		];
	}

	#agentDir(): string {
		return this.ctx.settings.getAgentDir();
	}

	/** Rediscover saved setups and rebuild previews, keeping `selected` when it still exists. */
	async #refresh(selected?: ProfileDashboardSetupRef): Promise<void> {
		const dashboard = this.#dashboard;
		if (!dashboard) return;
		const descriptors = await listSavedSetups(this.#agentDir());
		if (this.#dashboard !== dashboard) return;
		this.#descriptors = descriptors;
		this.#generation++;
		this.#snapshots.clear();
		this.#previews.clear();
		dashboard.setSetups(this.#setupRefs(), selected);
		await this.#preview(dashboard.selectedSetup ?? CURRENT_SETUP);
	}

	#preview(setup: ProfileDashboardSetupRef): Promise<void> {
		const key = setupKey(setup);
		const dashboard = this.#dashboard;
		if (!dashboard || this.#snapshots.has(key)) return Promise.resolve();
		const pending = this.#previews.get(key);
		if (pending) return pending;
		const generation = this.#generation;
		const unreadable =
			setup.kind === "saved" ? this.#descriptors.find(item => item.name === setup.name)?.error : undefined;
		if (unreadable) {
			dashboard.setSetupState(setup, { loading: false, error: cleanText(unreadable) });
			return Promise.resolve();
		}
		dashboard.setSetupState(setup, { loading: true });
		const run = this.#buildSnapshot(setup).then(
			snapshot => {
				if (generation !== this.#generation || this.#dashboard !== dashboard) return;
				this.#snapshots.set(key, snapshot);
				dashboard.setSetupState(setup, { snapshot, loading: false, usage: this.#usage });
			},
			(error: unknown) => {
				if (generation !== this.#generation || this.#dashboard !== dashboard) return;
				logger.warn("Failed to preview setup", { setup: key, error: String(error) });
				dashboard.setSetupState(setup, {
					loading: false,
					error: errorText(error, "Unable to preview this profile"),
				});
			},
		);
		this.#previews.set(key, run);
		return run.finally(() => {
			if (this.#previews.get(key) === run) this.#previews.delete(key);
		});
	}

	/**
	 * Fetch this session's account usage once per mount, the same reports `/usage`
	 * shows, and attach them to every preview; each overview shows the providers
	 * its profile uses. A failure or an empty result leaves the section out, as
	 * `/usage` does.
	 */
	async #loadUsage(dashboard: ProfileDashboard): Promise<void> {
		const { session } = this.ctx;
		let reports: UsageReport[] | null;
		try {
			reports = await session.fetchUsageReports(this.#dialogs.signal);
		} catch (error) {
			if (!this.#dialogs.signal.aborted) logger.warn("Failed to fetch usage for Profiles", { error: String(error) });
			return;
		}
		if (this.#dashboard !== dashboard || !reports || reports.length === 0) return;
		this.#usage = reports;
		for (const setup of this.#setupRefs()) {
			const snapshot = this.#snapshots.get(setupKey(setup));
			if (snapshot) dashboard.setSetupState(setup, { snapshot, loading: false, usage: reports });
		}
	}

	async #buildSnapshot(setup: ProfileDashboardSetupRef): Promise<ProfileSnapshot> {
		const { session, sessionManager } = this.ctx;
		const cwd = sessionManager.getCwd();
		if (setup.kind === "current") {
			return buildProfileSnapshot({
				cwd,
				settings: this.ctx.settings,
				modelRegistry: session.modelRegistry,
				currentModel: session.model ?? undefined,
				currentThinkingLevel: session.configuredThinkingLevel(),
			});
		}
		const loaded = await loadSavedSetup(setup.name, this.#agentDir());
		const snapshot = await buildProfileSnapshot({
			cwd,
			settings: await this.#previewSettings(loaded),
			modelRegistry: session.modelRegistry,
		});
		snapshot.warnings.push(...loaded.warnings);
		return snapshot;
	}

	/**
	 * Read-only settings as they resolve with `draft` loaded on top of the
	 * persisted configuration and launch overlays. Building them fires no global
	 * setting hooks, so previews cannot change the live UI.
	 */
	#previewSettings(draft: ProfileDraft | undefined): Promise<Settings> {
		return Settings.loadReadOnly({
			cwd: this.ctx.sessionManager.getCwd(),
			agentDir: this.#agentDir(),
			configFiles: [...this.ctx.settings.configFiles],
			overrides: draft ? setupOverrides(draft) : undefined,
		});
	}

	/** Run one modal flow with the Settings overlay hidden; at most one runs at a time. */
	async #interaction(run: () => Promise<Notice | undefined>): Promise<void> {
		const dashboard = this.#dashboard;
		if (!dashboard || this.#busy) return;
		this.#busy = true;
		this.#overlay?.setHidden(true);
		let notice: Notice | undefined;
		try {
			notice = await run();
		} catch (error) {
			if (!this.#dialogs.signal.aborted) {
				logger.warn("Profiles action failed", { error: String(error) });
				notice = { message: errorText(error, "The Profiles action failed"), tone: "error" };
			}
		} finally {
			this.#busy = false;
			if (this.#dashboard === dashboard) {
				this.#overlay?.setHidden(false);
				if (this.#selector) this.ctx.ui.setFocus(this.#selector);
				if (notice) dashboard.setActionNotice(notice.message, notice.tone);
				this.ctx.ui.requestRender();
			}
		}
	}

	#currentDraft(): ProfileDraft {
		const model = this.ctx.session.model;
		return createSetupDraft(
			this.ctx.settings,
			model
				? { provider: model.provider, id: model.id, thinkingLevel: this.ctx.session.configuredThinkingLevel() }
				: undefined,
		);
	}

	#editSetup(setup: ProfileDashboardSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const loaded = setup.kind === "saved" ? await loadSavedSetup(setup.name, this.#agentDir()) : undefined;
			const draft = loaded ?? this.#currentDraft();
			const saved = await this.#openEditor(
				setup,
				{ metadata: draft.metadata, config: draft.config },
				{ skipped: loaded?.warnings },
			);
			if (saved === undefined) return undefined;
			await this.#refresh({ kind: "saved", name: saved });
			return { message: `Saved profile ${cleanText(saved)}. Load it to use it.`, tone: "success" };
		});
	}

	/**
	 * Save an edited draft, prompting for a name when it is new. Resolves the
	 * saved name, or undefined when cancelled. `skipped` lists entries the
	 * existing file holds that this version could not load; overwriting drops them.
	 */
	async #saveDraft(
		setup: ProfileDashboardSetupRef,
		draft: ProfileDraft,
		saveAsNew: boolean,
		skipped: readonly string[],
	): Promise<string | undefined> {
		const signal = this.#dialogs.signal;
		if (setup.kind === "saved" && !saveAsNew) {
			const drops = skipped.length > 0 ? `\nSaving also drops ${skippedSummary(skipped)}` : "";
			const confirmed = await this.ctx.showHookConfirm(
				`Save changes to ${cleanText(setup.name)}?`,
				`This replaces the saved profile only. The current session does not change.${drops}`,
				{ signal },
			);
			if (!confirmed) return undefined;
			await saveSetup(setup.name, draft, { agentDir: this.#agentDir(), overwrite: true });
			return setup.name;
		}
		let prompt = "Save profile as";
		for (;;) {
			const input = await this.ctx.showHookInput(prompt, "Profile name", { signal });
			if (input === undefined) return undefined;
			try {
				return (await saveSetup(input, draft, { agentDir: this.#agentDir() })).name;
			} catch (error) {
				if (!(error instanceof SetupError) || (error.kind !== "invalid-name" && error.kind !== "exists"))
					throw error;
				prompt = `${cleanText(error.message)}\nSave profile as`;
			}
		}
	}

	/** Commit one saved profile's emoji now; the rest of the open draft stays unsaved. */
	async #saveEmoji(name: string, emoji: ProfileEmoji | undefined, isClosed: () => boolean): Promise<boolean> {
		if (isClosed() || this.#dialogs.signal.aborted) return false;
		const saved = await setSavedSetupEmoji(name, emoji, this.#agentDir());
		this.#descriptors = this.#descriptors.map(item => (item.name === saved.name ? saved : item));
		this.#dashboard?.setSetups(this.#setupRefs(), { kind: "saved", name: saved.name });
		return !isClosed();
	}

	/** Open the isolated draft editor. Resolves the saved profile name, or undefined when the edit was cancelled. */
	async #openEditor(
		setup: ProfileDashboardSetupRef,
		draft: ProfileDraft,
		options: EditorOptions = {},
	): Promise<string | undefined> {
		const skipped = options.skipped ?? [];
		const effective = this.#draftSettings(draft, "default", "PROFILE DRAFT");
		const inherited = setup.kind === "saved" ? await this.#previewSettings(undefined) : this.ctx.settings;
		const availableThemes = await getAvailableThemes();
		const models = this.ctx.session.modelRegistry.getAll();
		const draftModel = resolveModelRoleValue(effective.settings.getModelRole("default"), models, {
			settings: effective.settings,
		}).model;
		if (this.#dialogs.signal.aborted) return undefined;
		const result = Promise.withResolvers<string | undefined>();
		let finished = false;
		const finish = (name: string | undefined): void => {
			if (finished) return;
			finished = true;
			handle.hide();
			if (this.#closeChild === cancel) this.#closeChild = undefined;
			result.resolve(name);
		};
		const cancel = (): void => finish(undefined);
		const reveal = (): void => {
			if (finished) return;
			handle.setHidden(false);
			this.ctx.ui.setFocus(editor);
			this.ctx.ui.requestRender();
		};
		const editor = new ProfileEditorComponent({
			draft,
			effectiveSettings: effective.settings,
			inheritedSettings: inherited,
			name: options.name ?? (setup.kind === "saved" ? setup.name : "Current profile"),
			title: options.title ?? "Edit profile",
			notice: options.notice,
			saveLabel: "Save",
			allowSaveAsNew: setup.kind === "saved",
			terminalHeight: this.ctx.ui.terminal.rows,
			agentNames: this.#snapshots.get(setupKey(CURRENT_SETUP))?.agents.map(agent => agent.name) ?? [],
			settingsContext: {
				availableThinkingLevels: [...(draftModel ? getSupportedEfforts(draftModel) : THINKING_EFFORTS)],
				availableThemes,
				providers: [...new Set(models.map(model => model.provider))].sort((a, b) => a.localeCompare(b)),
				model: draftModel,
				imageBudget: this.ctx.ui.imageBudget,
				composerPreviewStatus: this.ctx.statusLine,
			},
			callbacks: {
				requestRender: () => {
					if (!finished) this.ctx.ui.requestRender();
				},
				onEditRole: async (role, value) => {
					handle.setHidden(true);
					try {
						return await this.#chooseRole(role, value, "PROFILE DRAFT");
					} finally {
						reveal();
					}
				},
				onEditAgent: async (agent, value) => {
					handle.setHidden(true);
					try {
						return await this.#chooseAgent(agent, value);
					} finally {
						reveal();
					}
				},
				onSave: async (value, saveAsNew) => {
					handle.setHidden(true);
					try {
						const name = await this.#saveDraft(setup, value, saveAsNew || setup.kind === "current", skipped);
						if (name !== undefined) finish(name);
					} finally {
						reveal();
					}
				},
				onCancel: cancel,
				onSaveEmoji:
					setup.kind === "saved" ? emoji => this.#saveEmoji(setup.name, emoji, () => finished) : undefined,
				roleWarnings: value => this.#roleWarnings(value),
			},
		});
		const handle = this.host.showFullscreenMenu(editor);
		this.#closeChild = cancel;
		return result.promise;
	}

	/** The preview's per-role warnings for `draft`, so the editor flags models that are not available here. */
	#roleWarnings(draft: ProfileDraft): ReadonlyMap<string, string> {
		const roles = draftModelRoles(draft);
		const rows = projectProfileRoles({
			cwd: this.ctx.sessionManager.getCwd(),
			settings: this.#isolatedDraftSettings(draft),
			modelRegistry: this.ctx.session.modelRegistry,
		});
		const warnings = new Map<string, string>();
		for (const row of rows) {
			if (row.warning && Object.hasOwn(roles, row.role)) warnings.set(row.role, row.warning);
		}
		return warnings;
	}

	/**
	 * Isolated settings describing `draft` on top of the effective configuration.
	 * Kept in one global scope: a profile is a single overlay, not a global/project pair.
	 */
	#isolatedDraftSettings(draft: ProfileDraft): Settings {
		const overrides: Partial<Record<SettingPath, unknown>> = {};
		for (const settingPath of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const saved = readConfigPath(draft.config, settingPath);
			overrides[settingPath] = saved.present ? saved.value : this.ctx.settings.get(settingPath);
		}
		overrides.modelRoles = { ...this.ctx.settings.getModelRoles(), ...draftModelRoles(draft) };
		overrides.modelRoleStorage = "global";
		return Settings.isolated(overrides, { storage: this.ctx.settings.getStorage() });
	}

	/** Draft settings plus a model-hub source whose role lookups read the draft. */
	#draftSettings(draft: ProfileDraft, role: string, label: string): { settings: Settings; source: ModelHubSource } {
		const roles = draftModelRoles(draft);
		const settings = this.#isolatedDraftSettings(draft);
		const baseSource = createModelBrowserSource(settings);
		return {
			settings,
			source: {
				...baseSource,
				getModelRole: candidate =>
					Object.hasOwn(roles, candidate) ? (roles[candidate] ?? undefined) : baseSource.getModelRole(candidate),
				getRoleInfo: candidate => {
					const info = baseSource.getRoleInfo(candidate);
					if (candidate !== role) return info;
					return { ...info, tag: `${label} · ${info.tag ?? info.name ?? candidate}` };
				},
			},
		};
	}

	/** Pick a model for one draft role in the focused model hub. Resolves the changed draft, or undefined. */
	async #chooseRole(role: string, draft: ProfileDraft, label: string): Promise<ProfileDraft | undefined> {
		if (this.#dialogs.signal.aborted) return undefined;
		const staged = structuredClone(draft);
		const roles = draftModelRoles(staged);
		staged.config.modelRoles = roles;
		const preview = this.#draftSettings(staged, role, label);
		const result = Promise.withResolvers<ProfileDraft | undefined>();
		let changed = false;
		let finished = false;
		const close = this.host.showModelHub({
			initialAssignRole: role,
			source: preview.source,
			roleCallbacks: {
				onAssign: (model, assignedRole, thinkingLevel, selector) => {
					if (finished || assignedRole !== role) return false;
					roles[role] = formatModelSelectorValue(selector ?? `${model.provider}/${model.id}`, thinkingLevel);
					changed = true;
					return true;
				},
				onUnassign: assignedRole => {
					if (finished || assignedRole !== role) return false;
					roles[role] = null;
					changed = true;
					return true;
				},
			},
			onDone: () => {
				finished = true;
				result.resolve(this.#dialogs.signal.aborted || !changed ? undefined : staged);
			},
		});
		const previousChild = this.#closeChild;
		this.#closeChild = close;
		try {
			return await result.promise;
		} finally {
			if (this.#closeChild === close) this.#closeChild = previousChild;
		}
	}

	/** Edit one agent's model override and fallbacks in the draft. Resolves the changed draft, or undefined. */
	async #chooseAgent(agent: string, source: ProfileDraft): Promise<ProfileDraft | undefined> {
		const signal = this.#dialogs.signal;
		const draft = structuredClone(source);
		const task = (draft.config.task ??= {}) as RawSettings;
		const overrides = (task.agentModelOverrides ??= {}) as Record<string, string | string[] | null>;
		let edited = false;
		for (;;) {
			if (signal.aborted) return undefined;
			const configured = overrides[agent];
			const chain = Array.isArray(configured) ? configured : typeof configured === "string" ? [configured] : [];
			const entries = chain.map((selector, index) => ({
				label: `${index + 1}. ${cleanText(selector)}`,
				description: "Replace this assignment without changing other fallback positions",
			}));
			const choice = await this.ctx.showHookSelector(
				`Agent ${cleanText(agent)} — draft only`,
				[
					...entries,
					"Choose model",
					...(chain.length > 0 ? ["Add fallback", "Remove fallback"] : []),
					...(chain.length > 1 ? ["Move fallback earlier"] : []),
					"Use Automatic",
					"Remove saved override",
					"Use changes",
					"Cancel",
				],
				{ signal },
			);
			if (choice === undefined || choice === "Cancel") return undefined;
			if (choice === "Use changes") return edited ? draft : source;
			edited = true;
			if (choice === "Use Automatic") {
				overrides[agent] = null;
				continue;
			}
			if (choice === "Remove saved override") {
				delete overrides[agent];
				continue;
			}
			if (choice === "Remove fallback" || choice === "Move fallback earlier") {
				const candidates = choice === "Move fallback earlier" ? entries.slice(1) : entries;
				const selected = await this.ctx.showHookSelector(choice, [...candidates, "Cancel"], { signal });
				if (selected === undefined || selected === "Cancel") return undefined;
				const index = entries.findIndex(entry => entry.label === selected);
				if (index < 0) continue;
				const next = [...chain];
				if (choice === "Remove fallback") next.splice(index, 1);
				else [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
				if (next.length === 0) delete overrides[agent];
				else overrides[agent] = Array.isArray(configured) ? next : next[0]!;
				continue;
			}
			const index = entries.findIndex(entry => entry.label === choice);
			if (index < 0 && choice !== "Choose model" && choice !== "Add fallback") continue;
			const picked = await this.#chooseRole("default", draft, `AGENT ${cleanText(agent)} DRAFT`);
			if (!picked) return undefined;
			const selector = draftModelRoles(picked).default ?? null;
			if (selector === null || choice === "Choose model") overrides[agent] = selector;
			else if (choice === "Add fallback") overrides[agent] = [...chain, selector];
			else if (Array.isArray(configured)) {
				const next = [...configured];
				next[index] = selector;
				overrides[agent] = next;
			} else overrides[agent] = selector;
		}
	}

	#renameSetup(setup: ProfileDashboardSavedSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const input = await this.ctx.showHookInput("Rename profile", setup.name, { signal: this.#dialogs.signal });
			if (input === undefined) return undefined;
			const renamed = await renameSavedSetup(setup.name, input, this.#agentDir());
			if (this.#imported.delete(setup.name)) this.#imported.add(renamed);
			await this.#refresh({ kind: "saved", name: renamed });
			return { message: `Renamed profile ${cleanText(setup.name)} to ${cleanText(renamed)}`, tone: "success" };
		});
	}

	#deleteSetup(setup: ProfileDashboardSavedSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const confirmed = await this.ctx.showHookConfirm(
				`Delete profile ${cleanText(setup.name)}?`,
				"This deletes only the saved profile file. The current session and your settings are unchanged.",
				{ signal: this.#dialogs.signal },
			);
			if (!confirmed) return undefined;
			await deleteSavedSetup(setup.name, this.#agentDir());
			this.#imported.delete(setup.name);
			await this.#refresh(CURRENT_SETUP);
			return { message: `Deleted profile ${cleanText(setup.name)}`, tone: "success" };
		});
	}

	#importProfile(): Promise<void> {
		return this.#interaction(async () => {
			const source = await this.ctx.showHookSelector(
				"Import profile",
				[
					{ label: FROM_FILE, description: "Read an exported profile file" },
					{ label: FROM_CLIPBOARD, description: "Read profile text copied from omp" },
					"Cancel",
				],
				{ signal: this.#dialogs.signal },
			);
			const imported =
				source === FROM_FILE
					? await this.#readImportFile()
					: source === FROM_CLIPBOARD
						? parseProfileText(await readTextFromClipboard())
						: undefined;
			if (!imported) return undefined;
			const draft: ProfileDraft = { metadata: imported.metadata, config: imported.config };
			const unavailable = this.#roleWarnings(draft).size;
			const findings = [
				...(unavailable > 0
					? [`${unavailable} model${unavailable === 1 ? "" : "s"} not available on this machine`]
					: []),
				...(imported.warnings.length > 0
					? [`${imported.warnings.length} entr${imported.warnings.length === 1 ? "y" : "ies"} skipped`]
					: []),
			];
			const review = await this.ctx.showHookSelector(
				"Look over the imported profile before saving it?",
				[
					{
						label: REVIEW_IMPORT,
						description: `Open the full settings menu to check or change it${findings.length > 0 ? ` (${findings.join(", ")})` : ""}`,
					},
					{ label: SAVE_IMPORT, description: "Name it and save it as a new profile" },
					"Cancel",
				],
				{ signal: this.#dialogs.signal },
			);
			let saved: string | undefined;
			if (review === SAVE_IMPORT) {
				saved = await this.#saveDraft(CURRENT_SETUP, draft, true, []);
			} else if (review === REVIEW_IMPORT) {
				saved = await this.#openEditor(CURRENT_SETUP, draft, {
					title: "Import profile",
					name: "Imported profile",
					notice: [
						"Not imported yet: review it, fix any ⚠ model, then Ctrl+S to save it as a new profile (Esc discards).",
						...(imported.warnings.length > 0 ? [`Skipped ${skippedSummary(imported.warnings)}.`] : []),
					].join(" "),
				});
			}
			if (saved === undefined) return undefined;
			this.#imported.add(saved);
			await this.#refresh({ kind: "saved", name: saved });
			return { message: `Imported profile ${cleanText(saved)}. Load it to use it.`, tone: "success" };
		});
	}

	/** Prompt for an exported profile file until one reads; undefined when cancelled or left empty. */
	async #readImportFile(): Promise<(ProfileDraft & { warnings: string[] }) | undefined> {
		let prompt = "Import profile from file";
		for (;;) {
			const input = await this.ctx.showHookInput(prompt, "Path to an exported profile", {
				signal: this.#dialogs.signal,
			});
			if (!input?.trim()) return undefined;
			try {
				const target = resolveToCwd(input.trim(), this.ctx.sessionManager.getCwd());
				return await readProfileFile(target, this.#displayPath(target));
			} catch (error) {
				if (!(error instanceof SetupError)) throw error;
				prompt = `${cleanText(error.message)}\nImport profile from file`;
			}
		}
	}

	#exportProfile(setup: ProfileDashboardSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const signal = this.#dialogs.signal;
			const label = setup.kind === "saved" ? setup.name : "Current profile";
			let draft: ProfileDraft;
			let skipped: readonly string[] = [];
			if (setup.kind === "saved") {
				const loaded = await loadSavedSetup(setup.name, this.#agentDir());
				const scope = await this.ctx.showHookSelector(
					`Export profile ${cleanText(label)}`,
					[
						{ label: WHOLE_PROFILE, description: "Every model role and setting this profile includes" },
						{ label: MODELS_ONLY, description: "Model roles and thinking only" },
						"Cancel",
					],
					{ signal },
				);
				if (scope !== WHOLE_PROFILE && scope !== MODELS_ONLY) return undefined;
				draft = scope === WHOLE_PROFILE ? loaded : modelsOnlyDraft(loaded);
				skipped = loaded.warnings;
			} else {
				// The current profile is already models-only; save it first to share settings groups.
				draft = this.#currentDraft();
			}
			const destination = await this.ctx.showHookSelector(
				`Export profile ${cleanText(label)}`,
				[
					{ label: TO_FILE, description: "Write a profile file; an existing file is never replaced" },
					{ label: TO_CLIPBOARD, description: "Copy the profile text" },
					"Cancel",
				],
				{ signal },
			);
			let where: string;
			if (destination === TO_CLIPBOARD) {
				await copyToClipboard(serializeSetup(draft));
				where = "the clipboard";
			} else if (destination === TO_FILE) {
				const written = await this.#writeExportFile(draft, setup.kind === "saved" ? setup.name : "profile");
				if (written === undefined) return undefined;
				where = this.#displayPath(written);
			} else {
				return undefined;
			}
			const without = skipped.length > 0 ? `, without ${skippedSummary(skipped)}` : "";
			return { message: `Exported profile ${cleanText(label)} to ${cleanText(where)}${without}`, tone: "success" };
		});
	}

	/** Prompt for an export path (empty accepts the suggestion) until the create-only write succeeds. */
	async #writeExportFile(draft: ProfileDraft, baseName: string): Promise<string | undefined> {
		const cwd = this.ctx.sessionManager.getCwd();
		const suggested = path.join(cwd, `${baseName}.profile.yml`);
		const title = `Export profile to file (empty saves ${this.#displayPath(suggested)})`;
		let prompt = title;
		for (;;) {
			const input = await this.ctx.showHookInput(prompt, suggested, { signal: this.#dialogs.signal });
			if (input === undefined) return undefined;
			const target = input.trim() ? resolveToCwd(input.trim(), cwd) : suggested;
			try {
				await writeProfileFile(target, draft, this.#displayPath(target));
				return target;
			} catch (error) {
				if (!(error instanceof SetupError)) throw error;
				prompt = `${cleanText(error.message)}\n${title}`;
			}
		}
	}

	/** `target` relative to the session folder when inside it, so prompts and notices stay readable. */
	#displayPath(target: string): string {
		const relative = path.relative(this.ctx.sessionManager.getCwd(), target);
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target;
	}

	#loadSetup(setup: ProfileDashboardSavedSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const choice = await this.ctx.showHookSelector(
				`Load profile ${cleanText(setup.name)}`,
				[
					{
						label: APPLY_MODELS_CHOICE,
						description:
							"Switch model roles and thinking now; other settings and this conversation stay as they are",
					},
					{
						label: NEW_SESSION_CHOICE,
						description: "Save this conversation and start a new one with every setting the profile includes",
					},
					"Cancel",
				],
				{ signal: this.#dialogs.signal },
			);
			if (choice === APPLY_MODELS_CHOICE) return this.#applyModels(setup);
			if (choice === NEW_SESSION_CHOICE) return this.#startSession(setup);
			return undefined;
		});
	}

	async #applyModels(setup: ProfileDashboardSavedSetupRef): Promise<Notice> {
		const loaded = await loadSavedSetup(setup.name, this.#agentDir());
		const release = await this.host.acquireDefaultRoleMutation();
		try {
			await applySetupModelRoles({
				session: this.ctx.session,
				settings: this.ctx.settings,
				roles: draftModelRoles(loaded),
				signal: this.#dialogs.signal,
				getBlockReason: () =>
					this.ctx.session.isStreaming
						? "Wait for the current response to finish before changing models"
						: undefined,
			});
		} finally {
			release();
		}
		await this.#refresh(CURRENT_SETUP);
		return {
			message: `This conversation now uses the models from profile ${cleanText(loaded.name)}`,
			tone: "success",
		};
	}

	/**
	 * Start a new session in this process with the whole setup applied. The
	 * setup becomes the session's setup layer, so it outranks persisted config
	 * until another setup is loaded or omp restarts.
	 */
	async #startSession(setup: ProfileDashboardSavedSetupRef): Promise<Notice | undefined> {
		const loaded = await loadSavedSetup(setup.name, this.#agentDir());
		const confirmed = await this.ctx.showHookConfirm(
			`Start a new session with profile ${cleanText(loaded.name)}?`,
			"This conversation is saved and can be resumed. The profile applies until you load another profile or restart omp.",
			{ signal: this.#dialogs.signal },
		);
		if (!confirmed) return undefined;
		this.#closeSettings?.();
		if (!(await this.ctx.startNewSession(`New session with profile ${loaded.name}`))) return undefined;
		this.ctx.settings.applySetupLayer(loaded.config);
		await this.ctx.session.refreshBaseSystemPrompt();
		await this.#useSetupDefaultModel(loaded);
		if (loaded.warnings.length > 0) {
			this.ctx.showWarning(
				`Profile ${cleanText(loaded.name)} skipped ${loaded.warnings.length} entr${loaded.warnings.length === 1 ? "y" : "ies"}: ${cleanText(loaded.warnings[0])}`,
			);
		}
		return undefined;
	}

	/** Switch the fresh session to the setup's default role without persisting a model choice. */
	async #useSetupDefaultModel(setup: LoadedSetup): Promise<void> {
		const { session, settings } = this.ctx;
		const selector = settings.getModelRole("default");
		if (!selector) return;
		const resolved = resolveModelRoleValue(selector, session.getAvailableModels(), {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
		if (!resolved.model || !session.modelRegistry.hasConfiguredAuth(resolved.model)) {
			const current = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
			this.ctx.showWarning(
				`Profile ${cleanText(setup.name)}: default model ${cleanText(selector)} is not available; keeping ${current}`,
			);
			return;
		}
		const thinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;
		if (modelsAreEqual(session.model, resolved.model) && thinkingLevel === undefined) return;
		await session.setModelTemporary(resolved.model, thinkingLevel);
	}

	#openActiveControl(control: ProfileDashboardActiveControl): void {
		if (this.#dashboard?.selectedSetup?.kind !== "current" || this.#busy) return;
		if (control === "settings") {
			this.#selector?.selectTab("appearance");
			return;
		}
		void this.#interaction(async () => {
			const done = Promise.withResolvers<void>();
			if (control === "model") {
				this.#closeChild = this.host.showModelHub({ onDone: () => done.resolve() });
			} else {
				this.#closeChild = await this.host.showAgentsDashboard({
					isCancelled: () => this.#dialogs.signal.aborted,
					onDone: () => done.resolve(),
				});
			}
			await done.promise;
			this.#closeChild = undefined;
			await this.#refresh(CURRENT_SETUP);
			return undefined;
		});
	}
}
