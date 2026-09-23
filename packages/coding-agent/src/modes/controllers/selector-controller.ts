import * as path from "node:path";
import { type AgentMessage, type AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, PASTE_CODE_LOGIN_PROVIDERS as PasteCodeLoginProviders, UsageReport } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { getOAuthProviders as GetOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { Component, OverlayHandle, ResizeScrollbackMode } from "@oh-my-pi/pi-tui";
import { Loader, Spacer, setTuiTight, Text } from "@oh-my-pi/pi-tui";
import {
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
	normalizePathForComparison,
	sanitizeText,
} from "@oh-my-pi/pi-utils";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
} from "../../advisor";
import { reset as resetCapabilities } from "../../capability";
import type { AdvisorConfigScope } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { showGitOverlay } from "../../cli/git-tui";
import { collectUsageSnapshot } from "../../cli/usage-cli";
import { getProfileLaunchConfigFiles } from "../../cli/profile-bootstrap";
import { resolveAdvisorRoleSelection, resolveModelRoleValue } from "../../config/model-resolver";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { getRoleInfo } from "../../config/model-roles";
import { SETTINGS_SCHEMA, Settings, settings, type RawSettings, type SettingPath } from "../../config/settings";
import { createSettingsHost } from "../../config/settings-ui";
import { createPluginSettingsHost } from "../../extensibility/plugins/settings-host";
import type { disableProvider as DisableProvider, enableProvider as EnableProvider } from "../../discovery";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import {
	getAvailableThemes,
	getSymbolTheme,
	previewTheme,
	setColorBlindMode,
	setMarkdownMermaidRendering,
	setSymbolPreset,
	setTheme,
	theme,
} from "@oh-my-pi/pi-tui/theme";
import type { AgentHubOpenOptions, InteractiveModeContext } from "../../modes/types";
import {
	ProfileDashboard,
	type ProfileDashboardActiveControl,
	type ProfileDashboardSavedSetupRef,
	type ProfileDashboardSetupRef,
} from "../components/profile-dashboard";
import { ProfileEditorComponent } from "../components/profile-editor";
import { ProfileImportPreview } from "../components/profile-import-preview";
import type { SessionOAuthAccountList } from "../../session/agent-session-types";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "../../session/auth-storage";
import {
	createForeignSessionStore,
	foreignSessionInfoToSessionInfo,
	foreignSessionSourceName,
	persistForeignSession,
} from "../../session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "../../session/foreign-session-store";
import { isTranscriptEntry, type TranscriptEntry } from "../../session/session-context";
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { SessionEntry, SessionTreeNode } from "../../session/session-entries";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { loadPinnedSessionIds } from "../../session/session-pins";
import { hasProfileLaunchContext, inspectProfile } from "../../profiles/client";
import { serializeModelRoles, writeModelRolesFile } from "../../profiles/role-sharing";
import {
	parseProfileArtifact,
	readProfileArtifactFile,
	serializeProfile,
	writeProfileFile,
} from "../../profiles/profile-sharing";
import {
	profileAssignmentKey,
	projectProfileCompatibility,
	replaceProfileAssignment,
	removeUnavailableProfileAgent,
	type ProfileAssignmentIdentity,
} from "../../profiles/profile-compatibility";
import { getUi } from "../../config/settings-schema";
import { applySetupModelRoles } from "../../profiles/apply-model-roles";
import { applyProfileModelPerformance, buildProfileSnapshot } from "../../profiles/snapshot";
import {
	createProfileDraft,
	deleteSavedSetup,
	getProfileGroupPaths,
	listSavedSetups,
	loadSavedSetup as readSavedSetup,
	normalizeSetupName,
	renameSavedSetup,
	saveProfileDraft,
	type SavedSetupDescriptor,
} from "../../profiles/setups";
import {
	PROFILE_SETTINGS_GROUPS,
	type ModelRoleAssignments,
	type ModelRoleImportRow,
	type ProfileDraft,
	type ProfileSnapshot,
} from "../../profiles/types";
import { PROFILE_USAGE_STALE_MS, sanitizeProfileUsageSnapshot } from "../../profiles/usage";
import { FileSessionStorage } from "../../session/session-storage";
import { toLogoutAccounts } from "../../slash-commands/helpers/logout";
import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { describeRedeemOutcome, toResetUsageAccounts } from "../../slash-commands/helpers/reset-usage";
import { toSessionPinAccounts } from "../../slash-commands/helpers/session-pin";
import { loadDailyActivity } from "../../stats/activity-client";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";
import type { ToolSession } from "../../tools";
import { AskTool, type AskToolInput } from "../../tools/ask";
import { type AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import { replaceTabs, sanitizeDisplayWarnings, shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";
import { ToolAbortError } from "../../tools/tool-errors";
import { resolveToCwd } from "../../tools/path-utils";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { captureBrowserSession } from "../../utils/browser-session";
import { copyToClipboard, readTextFromClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import {
	setSessionTerminalTitle,
	setTerminalTitleSpinnerStyle,
	setTerminalTitleStateEnabled,
} from "../../utils/title-generator";
import { getAssistantMessageLinkTargets } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { type AdvisorConfigDeps, AdvisorConfigOverlayComponent } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { createAgentsHubDeps } from "../agents-hub-deps";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { collapseSharedUsageReports } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { limitMatchesActiveAccount } from "../../slash-commands/helpers/active-oauth-account";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { createAgentHubRuntime } from "../agent-hub-runtime";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { CopySelectorComponent } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import { ExtensionDashboard } from "@oh-my-pi/pi-tui/overlays/extensions/extension-dashboard";
import { listLiveToolRecords, liveToolRecordFromSession } from "@oh-my-pi/pi-tui/overlays/extensions/live-tool-session";
import { createExtensionDashboardRuntime } from "../components/extensions/dashboard-runtime";
import { HistorySearchComponent } from "@oh-my-pi/pi-tui/overlays/history-search";
import type { LoginDialogComponent as LoginDialogComponentType } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import type { LogoutAccountSelectorComponent as LogoutAccountSelectorComponentType } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import type {
	ModelHubCallbacks,
	ModelHubComponent as ModelHubComponentType,
	ModelHubSource,
	ModelRoleSelectionScope,
} from "@oh-my-pi/pi-tui/overlays/model-hub";
import { createModelBrowserSource } from "../model-browser-source";
import type { ModelPickerComponent as ModelPickerComponentType } from "@oh-my-pi/pi-tui/overlays/model-picker";
import type { OAuthSelectorComponent as OAuthSelectorComponentType } from "@oh-my-pi/pi-tui/overlays/oauth-selector";
import { PluginSelectorComponent } from "@oh-my-pi/pi-tui/overlays/plugin-selector";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { type ResetUsageAccount, ResetUsageSelectorComponent } from "@oh-my-pi/pi-tui/overlays/reset-usage-selector";
import { type BranchVariantPath, RewindSelectorComponent } from "@oh-my-pi/pi-tui/overlays/rewind-selector";
import { renderSegmentTrack } from "@oh-my-pi/pi-tui/chrome/segment-track";
import { SessionAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-account-selector";
import { SessionSelectorComponent, type SessionSelectorOptions } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { SettingsSelectorComponent, type SettingsNavigationTab } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptBlock } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { renderUsageReports } from "./command-controller";
import type { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";

interface CachedProfileSnapshot {
	snapshot: ProfileSnapshot;
	storedAt: number;
	sourceUpdatedAt?: number;
}

type ProfileDashboardRefresh = (contentChanged: boolean) => Promise<boolean>;
const MANUAL_LOGIN_PROMPT = "Paste the authorization code (or full redirect URL), then press Enter:";

interface ModelOverlayModules {
	ModelHubComponent: typeof ModelHubComponentType;
	ModelPickerComponent: typeof ModelPickerComponentType;
}

interface ModelHubHostOptions {
	initialProviderId?: string;
	initialAssignRole?: string;
	source?: ModelHubSource;
	roleCallbacks?: Pick<ModelHubCallbacks, "onAssign" | "onUnassign">;
	isCancelled?: () => boolean;
	setClose?: (close: () => void) => void;
	onDone?: () => void;
}

interface AgentsDashboardHostOptions {
	isCancelled?: () => boolean;
	onDone?: () => void;
}

interface ProfileRoleSourceOptions {
	config?: RawSettings;
	modelRoles?: Readonly<Record<string, string | null>>;
	snapshot?: ProfileSnapshot;
	label: string;
	role: string;
}

function savedSettingValue(config: RawSettings, settingPath: SettingPath): { found: boolean; value?: unknown } {
	let current: unknown = config;
	for (const segment of settingPath.split(".")) {
		if (
			typeof current !== "object" ||
			current === null ||
			Array.isArray(current) ||
			!Object.hasOwn(current, segment)
		) {
			return { found: false };
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return { found: true, value: current };
}

function cleanRoleSharingText(value: unknown): string {
	const sanitized = replaceTabs(sanitizeText(String(value ?? "")));
	return oneLineLabel(sanitized, sanitized.length || 1);
}

function roleImportStatusLabel(status: ModelRoleImportRow["status"]): string {
	switch (status) {
		case "ready":
			return "Ready";
		case "automatic":
			return "Automatic";
		case "provider-missing":
			return "Provider missing";
		case "credentials-missing":
			return "Credentials missing";
		case "model-missing":
			return "Model missing";
		case "needs-review":
			return "Needs review";
	}
}

function describeRoleImportStatus(row: ModelRoleImportRow): string {
	const detail = row.message ? cleanRoleSharingText(row.message) : "";
	switch (row.status) {
		case "ready": {
			const target = row.provider && row.modelId ? `${row.provider}/${row.modelId}` : "local model";
			const thinking = row.thinkingLevel ? `, thinking ${row.thinkingLevel}` : "";
			return [
				`${roleImportStatusLabel(row.status)} — ${cleanRoleSharingText(target)}${thinking}`,
				detail ? ` · ${detail}` : "",
			].join("");
		}
		case "automatic":
			return "Automatic model assignment";
		case "provider-missing":
		case "credentials-missing":
		case "model-missing":
		case "needs-review":
			return `${roleImportStatusLabel(row.status)}${detail ? ` — ${detail}` : ""}`;
	}
}

/** Synchronous first-use boundary for model overlays; key callbacks require immediate mounting. */
function loadModelOverlayComponents(): ModelOverlayModules {
	return {
		ModelHubComponent: require("@oh-my-pi/pi-tui/overlays/model-hub.js").ModelHubComponent,
		ModelPickerComponent: require("@oh-my-pi/pi-tui/overlays/model-picker.js").ModelPickerComponent,
	};
}

interface ProviderAuthUiModules {
	PASTE_CODE_LOGIN_PROVIDERS: typeof PasteCodeLoginProviders;
	getOAuthProviders: typeof GetOAuthProviders;
	LoginDialogComponent: typeof LoginDialogComponentType;
	LogoutAccountSelectorComponent: typeof LogoutAccountSelectorComponentType;
	OAuthSelectorComponent: typeof OAuthSelectorComponentType;
}

/** Synchronous first-use boundary for provider auth catalog and dialog components. */
function loadProviderAuthUi(): ProviderAuthUiModules {
	return {
		PASTE_CODE_LOGIN_PROVIDERS: require("@oh-my-pi/pi-ai/index.js").PASTE_CODE_LOGIN_PROVIDERS,
		getOAuthProviders: require("@oh-my-pi/pi-ai/registry/oauth/index.js").getOAuthProviders,
		LoginDialogComponent: require("@oh-my-pi/pi-tui/overlays/login-dialog.js").LoginDialogComponent,
		LogoutAccountSelectorComponent: require("@oh-my-pi/pi-tui/overlays/logout-account-selector.js")
			.LogoutAccountSelectorComponent,
		OAuthSelectorComponent: require("@oh-my-pi/pi-tui/overlays/oauth-selector.js").OAuthSelectorComponent,
	};
}

interface ProviderToggleModules {
	disableProvider: typeof DisableProvider;
	enableProvider: typeof EnableProvider;
}

/** Settings-only boundary for provider discovery mutations. */
function loadProviderToggles(): ProviderToggleModules {
	const discovery = require("../../discovery");
	return { disableProvider: discovery.disableProvider, enableProvider: discovery.enableProvider };
}

export class SelectorController {
	constructor(private ctx: InteractiveModeContext) {}
	readonly #profileSnapshotCache = new Map<string, CachedProfileSnapshot>();
	#closeProfileDashboard: (() => void) | undefined;
	#profileDashboardOpeningGeneration = 0;
	#closeSettingsOverlay: (() => void) | undefined;
	#settingsSelector: SettingsSelectorComponent | undefined;
	#mountProfilesContent: (() => Promise<void>) | undefined;
	#settingsOpeningGeneration = 0;
	/**
	 * Mount a primary fullscreen menu through the one polished modal path shared
	 * by Settings, Model Hub, and Agent Hub.
	 */
	#showFullscreenMenu(component: Component): OverlayHandle {
		const handle = this.ctx.ui.showOverlay(component, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(component);
		this.ctx.ui.requestRender();
		return handle;
	}

	#defaultRoleMutationTail = Promise.resolve();

	async #acquireDefaultRoleMutation(): Promise<() => void> {
		const previous = this.#defaultRoleMutationTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#defaultRoleMutationTail = previous.then(() => promise);
		await previous;
		return resolve;
	}

	#createProfileRoleSource(options: ProfileRoleSourceOptions): {
		settings: Settings;
		source: ModelHubSource;
	} {
		const overrides: Partial<Record<SettingPath, unknown>> = {};
		const displayed = new Map(
			options.snapshot?.settings.filter(row => !row.hidden).map(row => [row.path, row.value]),
		);
		for (const settingPath of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const saved = options.config ? savedSettingValue(options.config, settingPath) : undefined;
			overrides[settingPath] = saved?.found
				? saved.value
				: displayed.has(settingPath)
					? displayed.get(settingPath)
					: this.ctx.settings.get(settingPath);
		}
		if (options.modelRoles) {
			overrides.modelRoles = {
				...this.ctx.settings.getModelRoles(),
				...options.modelRoles,
			};
		}
		// A saved or imported setup is one atomic overlay, not a
		// global/project settings pair. Keeping its editor in one scope prevents
		// scope controls from promising writes to layers that the setup file does
		// not have.
		overrides.modelRoleStorage = "global";
		const previewSettings = Settings.isolated(overrides, { storage: this.ctx.settings.getStorage() });
		const baseSource = createModelBrowserSource(previewSettings);
		return {
			settings: previewSettings,
			source: {
				...baseSource,
				getModelRole: candidate =>
					options.modelRoles && Object.hasOwn(options.modelRoles, candidate)
						? (options.modelRoles[candidate] ?? undefined)
						: baseSource.getModelRole(candidate),
				getRoleInfo: candidate => {
					const info = baseSource.getRoleInfo(candidate);
					if (candidate !== options.role) return info;
					return { ...info, tag: `${options.label} · ${info.tag ?? info.name ?? candidate}` };
				},
			},
		};
	}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const { getOAuthProviders } = loadProviderAuthUi();
		const oauthProviders = getOAuthProviders();
		await Promise.all(
			oauthProviders.map(provider =>
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}

	/**
	 * Restore keyboard focus to whatever currently owns the editor slot. The
	 * slot can hold the editor itself or a hook selector/input/editor pushed
	 * in by `ExtensionUiController` — e.g. an approval prompt that fired while
	 * a fullscreen overlay was up. `overlayHandle.hide()` restores focus to
	 * the component focused when the overlay opened, which is stale in that
	 * case (the editor was swapped out): keys land on a hidden editor and the
	 * visible prompt receives nothing (issue #3349). Call this after the
	 * overlay hides to re-target focus at the visible slot owner.
	 */
	focusActiveEditorArea(): void {
		const visible = this.ctx.editorContainer.children[0] ?? this.ctx.editor;
		this.ctx.ui.setFocus(visible);
	}

	/**
	 * Temporarily replaces the editor slot with a selector, restoring the prior
	 * slot contents and focus when the selector finishes.
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const previousChildren = [...this.ctx.editorContainer.children];
		const previousFocus = this.ctx.ui.getFocused();
		const done = () => {
			this.ctx.editorContainer.clear();
			for (const child of previousChildren) this.ctx.editorContainer.addChild(child);
			const focus =
				previousFocus && previousChildren.includes(previousFocus)
					? previousFocus
					: (previousChildren[0] ?? this.ctx.editor);
			this.ctx.ui.setFocus(focus);
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	closeSettingsSelector(): void {
		this.#settingsOpeningGeneration++;
		this.#profileDashboardOpeningGeneration++;
		this.#closeSettingsOverlay?.();
	}

	async showSettingsSelector(initialTab?: SettingsNavigationTab): Promise<void> {
		const requestedTab = initialTab ?? "appearance";
		if (this.#closeSettingsOverlay) {
			const selector = this.#settingsSelector;
			if (selector) {
				selector.selectTab(requestedTab);
				if (requestedTab === "profiles") await this.#mountProfilesContent?.();
			}
			return;
		}

		const generation = ++this.#settingsOpeningGeneration;
		const availableThemes = await getAvailableThemes();
		if (generation !== this.#settingsOpeningGeneration || this.ctx.isShuttingDown) return;

		let closed = false;
		let profilesRequested = false;
		let profileRefresh: ProfileDashboardRefresh | undefined;
		let profileRefreshPromise: Promise<boolean> | undefined;
		let profileMountPromise: Promise<ProfileDashboardRefresh | undefined> | undefined;
		const settingsOverlay: {
			selector?: SettingsSelectorComponent;
			handle?: OverlayHandle;
		} = {};
		const restoreStatusLine = () => {
			this.ctx.statusLine.updateSettings({
				preset: this.ctx.settings.get("statusLine.preset"),
				leftSegments: this.ctx.settings.get("statusLine.leftSegments"),
				rightSegments: this.ctx.settings.get("statusLine.rightSegments"),
				separator: this.ctx.settings.get("statusLine.separator"),
				showHookStatus: this.ctx.settings.get("statusLine.showHookStatus"),
				sessionAccent: this.ctx.settings.get("statusLine.sessionAccent"),
				transparent: this.ctx.settings.get("statusLine.transparent"),
				compactThinkingLevel: this.ctx.settings.get("statusLine.compactThinkingLevel"),
				contextLine: this.ctx.settings.get("statusLine.contextLine"),
			});
			this.ctx.ui.requestRender();
		};
		const done = () => {
			if (closed) return;
			closed = true;
			this.#settingsOpeningGeneration++;
			this.#profileDashboardOpeningGeneration++;
			this.#closeProfileDashboard?.();
			settingsOverlay.handle?.hide();
			if (this.#closeSettingsOverlay === done) {
				this.#closeSettingsOverlay = undefined;
				this.#mountProfilesContent = undefined;
				this.#settingsSelector = undefined;
			}
			restoreStatusLine();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const mountProfiles = async (): Promise<void> => {
			profilesRequested = true;
			const { selector, handle } = settingsOverlay;
			if (!selector || !handle || closed) return;
			if (!profileMountPromise) {
				profileMountPromise = this.#mountProfilesDashboard(selector, handle, done);
				profileRefresh = await profileMountPromise;
				return;
			}
			if (!profileRefresh) {
				await profileMountPromise;
				return;
			}
			if (profileRefreshPromise) {
				await profileRefreshPromise;
				return;
			}
			const pending = profileRefresh(false);
			profileRefreshPromise = pending;
			try {
				await pending;
			} finally {
				if (profileRefreshPromise === pending) profileRefreshPromise = undefined;
			}
		};

		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
				thinkingLevel: this.ctx.session.thinkingLevel,
				availableThemes,
				providers: [...new Set(this.ctx.session.getAvailableModels().map(model => model.provider))].sort((a, b) =>
					a.localeCompare(b),
				),
				settings: createSettingsHost({
					source: this.ctx.settings,
				}),
				plugins: createPluginSettingsHost(getProjectDir()),
				model: this.ctx.session.model,
				imageBudget: this.ctx.ui.imageBudget,
				requestRender: () => this.ctx.ui.requestRender(),
				composerPreviewStatus: this.ctx.statusLine,
			},
			{
				onChange: (id, value) => this.handleSettingChange(id, value),
				onThemePreview: async themeName => {
					const result = await previewTheme(themeName);
					if (result.success) {
						this.ctx.statusLine.invalidate();
						this.ctx.ui.invalidate();
						this.ctx.ui.requestRender();
					}
				},
				onStatusLinePreview: previewSettings => {
					this.ctx.statusLine.updateSettings({
						preset: this.ctx.settings.get("statusLine.preset"),
						leftSegments: this.ctx.settings.get("statusLine.leftSegments"),
						rightSegments: this.ctx.settings.get("statusLine.rightSegments"),
						separator: this.ctx.settings.get("statusLine.separator"),
						showHookStatus: this.ctx.settings.get("statusLine.showHookStatus"),
						sessionAccent: this.ctx.settings.get("statusLine.sessionAccent"),
						transparent: this.ctx.settings.get("statusLine.transparent"),
						compactThinkingLevel: this.ctx.settings.get("statusLine.compactThinkingLevel"),
						contextLine: this.ctx.settings.get("statusLine.contextLine"),
						...previewSettings,
					});
					this.ctx.ui.requestRender();
				},
				getStatusLinePreview: () => {
					const availableWidth = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
					return this.ctx.statusLine.getPreviewLines(availableWidth).join("\n");
				},
				onPluginsChanged: async () => {
					const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
					clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
					await this.ctx.refreshSkillState();
					await this.ctx.refreshSlashCommandState();
					resetCapabilities();
					this.ctx.ui.requestRender();
				},
				onProfilesSelected: () => {
					void mountProfiles();
				},
				onCancel: done,
			},
			{
				initialTab: requestedTab,
				profiles: new Text(theme.fg("muted", "Loading profiles…"), 1, 0),
			},
		);
		settingsOverlay.selector = selector;
		const overlayHandle = this.#showFullscreenMenu(selector);
		settingsOverlay.handle = overlayHandle;
		this.#settingsSelector = selector;
		this.#closeSettingsOverlay = done;
		this.#mountProfilesContent = mountProfiles;
		if (profilesRequested || requestedTab === "profiles") await mountProfiles();
	}

	/**
	 * Fullscreen `/usage` dashboard on the alternate screen (the /settings
	 * idiom): compact subscriptions grid + daily activity heatmap, with the
	 * classic full report one keypress away. Takes no transcript space.
	 */
	showUsageDashboard(reports: UsageReport[]): void {
		const currentProvider = this.ctx.session.model?.provider;
		const activeAccount = currentProvider
			? this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
					currentProvider,
					this.ctx.session.sessionId,
				)
			: undefined;
		const usageModelSelectors = this.ctx.session.getUsageReportingModelSelectors(reports);
		const done = () => {
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const dashboard = new UsageDashboardComponent({
			reports,
			renderDetail: width =>
				renderUsageReports(
					reports,
					theme,
					Date.now(),
					width,
					provider => (provider === currentProvider ? activeAccount : undefined),
					usageModelSelectors,
				),
			loadActivity: loadDailyActivity,
			requestRender: () => this.ctx.ui.requestRender(),
			onClose: done,
		});
		const overlayHandle = this.#showFullscreenMenu(dashboard);
	}

	showAdvisorConfigure(): void {
		const cwd = this.ctx.sessionManager.getCwd();
		const agentDir = getAgentDir() ?? getProjectDir();
		const initialScope: AdvisorConfigScope = "project";
		void (async () => {
			// "Project" scope edits the repo-root WATCHDOG.yml (the project-level file
			// discovery walks), not the launch subdir — `getProjectDir()` is only cwd.
			let projectDir = cwd;
			try {
				projectDir = vcs.repo(cwd)?.root() ?? cwd;
			} catch {
				projectDir = cwd;
			}
			const dirs = { projectDir, agentDir };
			const initialDoc = await loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(initialScope, dirs));
			if (initialDoc.warnings?.length) {
				this.ctx.showWarning(`WATCHDOG.yml: ${sanitizeDisplayWarnings(initialDoc.warnings).join("; ")}`);
			}
			// Fullscreen editor on the alternate screen (the /settings idiom): the
			// overlay holds the alt buffer + mouse tracking; the transcript stays put.
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			// Label the seeded implicit-default row with the actual advisor-role model
			// (NOT the first live advisor, which may be a named advisor from another scope).
			const advisorRoleSel = resolveAdvisorRoleSelection(
				this.ctx.settings,
				this.ctx.session.modelRegistry.getAvailable(),
			);
			const defaultAdvisorModel = advisorRoleSel?.model;
			const deps: AdvisorConfigDeps = {
				getAvailableModels: () => this.ctx.session.modelRegistry.getAvailable(),
				browserSource: createModelBrowserSource(this.ctx.settings),
				defaultToolNames: ADVISOR_DEFAULT_TOOL_NAMES,
				externalEditor: text => {
					const command = getEditorCommand();
					return command ? openInEditor(command, text) : Promise.resolve(null);
				},
				scopedModels: this.ctx.session.scopedModels,
				availableToolNames: this.ctx.session.getAdvisorAvailableToolNames(),
				defaultModelLabel: defaultAdvisorModel
					? `${defaultAdvisorModel.provider}/${defaultAdvisorModel.id}`
					: undefined,
			};
			const overlay = new AdvisorConfigOverlayComponent(this.ctx.ui, deps, initialScope, initialDoc, {
				loadDoc: async scope => loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs)),
				save: async (scope, doc) => {
					await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), doc);
					// Re-discover the merged roster (project + user) so the live advisors
					// reflect cross-level precedence, not just the edited file.
					const discovered = await discoverAdvisorConfigs(cwd, agentDir);
					const count = this.ctx.session.applyAdvisorConfigs(
						discovered.advisors,
						discovered.sharedInstructions,
						discovered.sharedMaxNotesPerUpdate,
					);
					this.ctx.statusLine.invalidate();
					if (discovered.warnings.length > 0) {
						this.ctx.showWarning(`WATCHDOG.yml: ${sanitizeDisplayWarnings(discovered.warnings).join("; ")}`);
					}
					this.ctx.showStatus(
						count > 0
							? `Saved ${scope} WATCHDOG.yml — ${count} advisor${count === 1 ? "" : "s"} active.`
							: `Saved ${scope} WATCHDOG.yml. Run /advisor on to activate the configured advisors.`,
					);
					this.ctx.ui.requestRender();
				},
				close: done,
				requestRender: () => this.ctx.ui.requestRender(),
				notify: message => this.ctx.showStatus(message),
				// Scope switches happen inside the overlay; the initial file's warnings
				// were already shown above, so only newly activated files arrive here.
				warn: message => this.ctx.showWarning(message),
				getAdvisorStats: () => this.ctx.session.getAdvisorStats().advisors,
				getUsageReports: async () => {
					const reports = await this.ctx.session.fetchUsageReports?.();
					return reports ? collapseSharedUsageReports(reports) : null;
				},
				getQuotaLimitFilter: (provider, sessionId) => {
					const identity = this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
						provider,
						sessionId ?? this.ctx.session.sessionId,
					);
					return identity ? (report, limit) => limitMatchesActiveAccount(report, limit, identity) : undefined;
				},
			});
			const overlayHandle = this.ctx.ui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(overlay);
			this.ctx.ui.requestRender();
		})();
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create({
			runtime: createExtensionDashboardRuntime({
				cwd: getProjectDir(),
				settings: this.ctx.settings,
				mcpManager: this.ctx.mcpManager,
				eventBus: this.ctx.eventBus,
				onMcpToolsChanged: tools => this.ctx.session.refreshMCPTools(tools),
				browserMcpFilterEnabled: () =>
					this.ctx.session.getEvalPreludes().some(definition => definition.name === "browser"),
			}),
			terminalHeight: this.ctx.ui.terminal.rows,
			toolSource: {
				getLiveTool: name => liveToolRecordFromSession(this.ctx.session, name),
				listLiveTools: () => listLiveToolRecords(this.ctx.session),
			},
		});
		// Fullscreen dashboard on the alternate screen (the /settings idiom): the
		// overlay borrows the terminal's alt buffer and enables mouse tracking for
		// its lifetime, leaving the transcript untouched underneath.
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		dashboard.onClose = () => {
			dashboard.dispose();
			overlay.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	/**
	 * Mount the saved-setup control center inside the active Settings overlay.
	 * Every asynchronous request is scoped to that parent lifetime so closing
	 * Settings cannot be followed by a late child mount or mutation.
	 */
	async #mountProfilesDashboard(
		settingsSelector: SettingsSelectorComponent,
		overlayHandle: OverlayHandle,
		closeParent: () => void,
	): Promise<ProfileDashboardRefresh | undefined> {
		this.#profileDashboardOpeningGeneration++;
		this.#closeProfileDashboard?.();
		const openingGeneration = this.#profileDashboardOpeningGeneration;
		const agentDir = this.ctx.settings.getAgentDir();
		let descriptors: SavedSetupDescriptor[];
		try {
			descriptors = await listSavedSetups(agentDir);
		} catch {
			if (openingGeneration === this.#profileDashboardOpeningGeneration) {
				settingsSelector.setProfilesContent(new Text(theme.fg("error", "Unable to discover saved profiles"), 1, 0));
				this.ctx.ui.requestRender();
			}
			return;
		}
		if (openingGeneration !== this.#profileDashboardOpeningGeneration || this.ctx.isShuttingDown) return;

		const currentSetup: ProfileDashboardSetupRef = { kind: "current" };
		const toSetupRefs = (items: readonly SavedSetupDescriptor[]): ProfileDashboardSetupRef[] => [
			currentSetup,
			...items.map(item => ({ kind: "saved" as const, name: item.name, metadata: item.metadata })),
		];
		let setups = toSetupRefs(descriptors);
		const cwd = this.ctx.sessionManager.getCwd();
		const activeProfile = getActiveProfile() ?? "default";
		const canLaunchSetups = hasProfileLaunchContext();
		const launchRequiredMessage = "Saved setup preview and loading require the OMP CLI";
		const versions = new Map<string, number>();
		const controllers = new Map<string, AbortController>();
		const dialogController = new AbortController();
		const snapshots = new Map<string, ProfileSnapshot>();
		let refreshedSettingsRevision = this.ctx.settings.revision;
		let closed = false;
		let interactionPending = false;
		let closeRoleEditor: (() => void) | undefined;
		let closeDraftEditor: (() => void) | undefined;
		let closeActiveControl: (() => void) | undefined;

		const setupKey = (setup: ProfileDashboardSetupRef): string =>
			setup.kind === "current" ? "current" : `saved\0${setup.name}`;
		const cacheKey = (setup: ProfileDashboardSetupRef): string => `${cwd}\0${activeProfile}\0${setupKey(setup)}`;
		const setupExists = (setup: ProfileDashboardSetupRef): boolean =>
			setup.kind === "current" || descriptors.some(item => item.name === setup.name);
		const setupUpdatedAt = (setup: ProfileDashboardSetupRef): number | undefined =>
			setup.kind === "saved" ? descriptors.find(item => item.name === setup.name)?.updatedAt : undefined;
		const teardown = (): void => {
			if (closed) return;
			closed = true;
			for (const controller of controllers.values()) controller.abort();
			controllers.clear();
			dialogController.abort();
			closeRoleEditor?.();
			closeRoleEditor = undefined;
			closeDraftEditor?.();
			closeDraftEditor = undefined;
			closeActiveControl?.();
			closeActiveControl = undefined;
			dashboard.dispose();
			if (this.#closeProfileDashboard === teardown) this.#closeProfileDashboard = undefined;
		};
		const handleUserClose = (): void => {
			if (!closed) closeParent();
		};
		const shareCurrentUsage = (usage: ProfileSnapshot["usage"], storedAt: number): void => {
			if (!usage) return;
			for (const setup of setups) {
				if (setup.kind !== "saved") continue;
				const snapshot = snapshots.get(setupKey(setup));
				if (!snapshot) continue;
				snapshot.usage = usage;
				this.#profileSnapshotCache.set(cacheKey(setup), {
					snapshot,
					storedAt,
					sourceUpdatedAt: setupUpdatedAt(setup),
				});
			}
		};
		const commitSnapshot = (
			setup: ProfileDashboardSetupRef,
			version: number,
			snapshot: ProfileSnapshot,
			storedAt: number,
			refreshError?: string,
			cache = true,
		): void => {
			const key = setupKey(setup);
			if (closed || versions.get(key) !== version || !setupExists(setup)) return;
			snapshots.set(key, snapshot);
			if (cache) {
				this.#profileSnapshotCache.set(cacheKey(setup), {
					snapshot,
					storedAt,
					sourceUpdatedAt: setupUpdatedAt(setup),
				});
			}
			dashboard.setSetupState(setup, { snapshot, loading: false, refreshError });
			if (setup.kind === "current") shareCurrentUsage(snapshot.usage, storedAt);
		};
		const loadSetup = async (setup: ProfileDashboardSetupRef, force = false): Promise<void> => {
			if (closed || !setupExists(setup)) return;
			const key = setupKey(setup);
			const scopedCacheKey = cacheKey(setup);
			const cached = this.#profileSnapshotCache.get(scopedCacheKey);
			const previous = snapshots.get(key) ?? cached?.snapshot;
			const cacheFresh = cached !== undefined && Date.now() - cached.storedAt < PROFILE_USAGE_STALE_MS;
			const sourceUnchanged = cached?.sourceUpdatedAt === setupUpdatedAt(setup);
			if (setup.kind === "saved" && !force && cached && cacheFresh && sourceUnchanged) {
				snapshots.set(key, cached.snapshot);
				dashboard.setSetupState(setup, { snapshot: cached.snapshot, loading: false });
				return;
			}
			if (setup.kind === "saved" && !canLaunchSetups) {
				dashboard.setSetupState(setup, {
					snapshot: previous,
					loading: false,
					error: previous ? undefined : launchRequiredMessage,
				});
				return;
			}

			controllers.get(key)?.abort();
			const controller = new AbortController();
			controllers.set(key, controller);
			const version = (versions.get(key) ?? 0) + 1;
			versions.set(key, version);
			dashboard.setSetupState(setup, { snapshot: previous, loading: true });

			try {
				if (setup.kind === "saved") {
					const snapshot = await inspectProfile(
						activeProfile,
						{ cwd, usage: false, setup: setup.name },
						controller.signal,
					);
					if (controller.signal.aborted) return;
					applyProfileModelPerformance(snapshot.roles, this.ctx.settings.getStorage()?.getModelPerf());
					const currentUsageCache = this.#profileSnapshotCache.get(cacheKey(currentSetup));
					const sharedUsage =
						snapshots.get(setupKey(currentSetup))?.usage ?? cached?.snapshot.usage ?? previous?.usage;
					const usageStoredAt = currentUsageCache?.storedAt ?? cached?.storedAt ?? Date.now();
					commitSnapshot(
						setup,
						version,
						sharedUsage ? { ...snapshot, usage: sharedUsage } : snapshot,
						usageStoredAt,
					);
					return;
				}

				const baseSnapshot = await buildProfileSnapshot({
					profile: activeProfile,
					cwd,
					settings: this.ctx.settings,
					modelRegistry: this.ctx.session.modelRegistry,
					authStorage: this.ctx.session.modelRegistry.authStorage,
					sessionId: this.ctx.session.sessionId,
					currentModel: this.ctx.session.model ?? undefined,
					currentThinkingLevel: this.ctx.session.configuredThinkingLevel(),
				});
				if (closed || controller.signal.aborted || versions.get(key) !== version) return;
				const cachedUsage = cached?.snapshot.usage ?? previous?.usage;
				const projected = cachedUsage ? { ...baseSnapshot, usage: cachedUsage } : baseSnapshot;
				snapshots.set(key, projected);
				dashboard.setSetupState(setup, { snapshot: projected, loading: !cacheFresh || force });
				shareCurrentUsage(projected.usage, cached?.storedAt ?? Date.now());
				if (!force && cached && cacheFresh) {
					this.#profileSnapshotCache.set(scopedCacheKey, { snapshot: projected, storedAt: cached.storedAt });
					dashboard.setSetupState(setup, { snapshot: projected, loading: false });
					return;
				}

				try {
					const collection = await collectUsageSnapshot(this.ctx.session.modelRegistry.authStorage, {
						signal: controller.signal,
						modelRegistry: this.ctx.session.modelRegistry,
					});
					if (controller.signal.aborted) return;
					commitSnapshot(
						setup,
						version,
						{ ...baseSnapshot, usage: sanitizeProfileUsageSnapshot(collection.snapshot) },
						Date.now(),
					);
				} catch {
					if (controller.signal.aborted) return;
					commitSnapshot(setup, version, projected, cached?.storedAt ?? Date.now(), "Usage refresh failed", false);
				}
			} catch {
				if (controller.signal.aborted || closed || versions.get(key) !== version) return;
				dashboard.setSetupState(setup, {
					snapshot: previous,
					loading: false,
					error: previous
						? undefined
						: setup.kind === "saved"
							? "Saved setup preview failed"
							: "Current setup failed",
					refreshError: previous ? "Setup refresh failed" : undefined,
				});
			} finally {
				if (controllers.get(key) === controller) controllers.delete(key);
			}
		};
		const restoreDashboard = (): void => {
			if (closed) return;
			dashboard.setLoadBlockReason(canLaunchSetups ? this.ctx.getProfileSwitchBlockReason() : launchRequiredMessage);
			overlayHandle.setHidden(false);
			this.ctx.ui.setFocus(settingsSelector);
			this.ctx.ui.requestRender();
		};
		const syncSetups = async (selectedSetup?: ProfileDashboardSetupRef): Promise<boolean> => {
			const discovered = await listSavedSetups(agentDir);
			if (closed) return false;
			const descriptorsChanged =
				discovered.length !== descriptors.length ||
				descriptors.some((item, index) => {
					const next = discovered[index];
					return (
						!next ||
						next.name !== item.name ||
						next.updatedAt !== item.updatedAt ||
						!Bun.deepEquals(next.metadata, item.metadata)
					);
				});
			for (const setup of setups) {
				if (setup.kind !== "saved") continue;
				const next = discovered.find(item => item.name === setup.name);
				if (next && next.updatedAt === setupUpdatedAt(setup) && Bun.deepEquals(next.metadata, setup.metadata)) {
					continue;
				}
				const key = setupKey(setup);
				controllers.get(key)?.abort();
				controllers.delete(key);
				versions.set(key, (versions.get(key) ?? 0) + 1);
				snapshots.delete(key);
				this.#profileSnapshotCache.delete(cacheKey(setup));
			}
			descriptors = discovered;
			setups = toSetupRefs(descriptors);
			if (descriptorsChanged) dashboard.setSetups(setups, selectedSetup);
			return true;
		};
		const refreshDashboard: ProfileDashboardRefresh = async contentChanged => {
			if (closed || interactionPending) return false;
			interactionPending = true;
			try {
				const refreshContent = contentChanged || this.ctx.settings.revision !== refreshedSettingsRevision;
				if (refreshContent) await this.ctx.settings.flush();
				if (closed) return false;
				const settingsRevision = this.ctx.settings.revision;
				const selected = dashboard.selectedSetup;
				if (!(await syncSetups(selected))) return false;
				for (const setup of setups) {
					if (!refreshContent && snapshots.has(setupKey(setup))) continue;
					void loadSetup(setup, refreshContent && setup.kind === "saved");
				}
				refreshedSettingsRevision = settingsRevision;
				return true;
			} catch {
				if (!closed) this.ctx.showError("Unable to refresh saved setups");
				return false;
			} finally {
				interactionPending = false;
			}
		};
		const readDraft = async (setup: ProfileDashboardSetupRef): Promise<ProfileDraft> => {
			if (setup.kind === "saved") {
				const { config, metadata } = await readSavedSetup(setup.name, agentDir);
				return { config, metadata };
			}
			const snapshot = snapshots.get(setupKey(currentSetup));
			if (!snapshot) throw new Error("Current setup is not ready");
			return createProfileDraft(this.ctx.settings, snapshot);
		};
		const chooseDraftRole = async (
			role: string,
			draft: ProfileDraft,
			label = "PROFILE DRAFT",
		): Promise<ProfileDraft | undefined> => {
			if (closed) return undefined;
			const staged = structuredClone(draft);
			const stagedRoles = staged.config.modelRoles as ModelRoleAssignments;
			const preview = this.#createProfileRoleSource({
				config: staged.config,
				modelRoles: stagedRoles,
				label,
				role,
			});
			const result = Promise.withResolvers<ProfileDraft | undefined>();
			let changed = false;
			let finished = false;
			const closeEditor = this.#showModelHub({
				initialAssignRole: role,
				source: preview.source,
				roleCallbacks: {
					onAssign: (model, assignedRole, thinkingLevel, selector) => {
						if (closed || finished || assignedRole !== role) return false;
						stagedRoles[role] = formatModelSelectorValue(
							selector ?? `${model.provider}/${model.id}`,
							thinkingLevel,
						);
						changed = true;
						return true;
					},
					onUnassign: assignedRole => {
						if (closed || finished || assignedRole !== role) return false;
						stagedRoles[role] = null;
						changed = true;
						return true;
					},
				},
				onDone: () => {
					finished = true;
					result.resolve(closed || !changed ? undefined : staged);
				},
			});
			closeRoleEditor = closeEditor;
			const value = await result.promise;
			if (closeRoleEditor === closeEditor) closeRoleEditor = undefined;
			return value;
		};
		const chooseDraftAgent = async (agent: string, source: ProfileDraft): Promise<ProfileDraft | undefined> => {
			const draft = structuredClone(source);
			const task = (draft.config.task ??= {}) as RawSettings;
			const overrides = (task.agentModelOverrides ??= {}) as Record<string, string | string[] | null>;
			let edited = false;
			for (;;) {
				if (closed) return undefined;
				const configured = overrides[agent];
				const chain = Array.isArray(configured) ? configured : typeof configured === "string" ? [configured] : [];
				const entries = chain.map((selector, index) => ({
					label: `${index + 1}. ${cleanRoleSharingText(selector)}`,
					description: "Replace this assignment without changing other fallback positions",
				}));
				const actions = [
					...entries,
					"Choose model",
					...(chain.length > 0 ? ["Add fallback", "Remove fallback"] : []),
					...(chain.length > 1 ? ["Move fallback earlier"] : []),
					"Use Automatic",
					"Remove saved override",
					"Use changes",
					"Cancel profile edit",
				];
				const choice = await this.ctx.showHookSelector(
					`Agent ${cleanRoleSharingText(agent)} — draft only`,
					actions,
					{ signal: dialogController.signal },
				);
				if (closed || choice === undefined || choice === "Cancel profile edit") return undefined;
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
					const selected = await this.ctx.showHookSelector(choice, [...candidates, "Cancel profile edit"], {
						signal: dialogController.signal,
					});
					if (closed || selected === undefined || selected === "Cancel profile edit") return undefined;
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
				const picked = await chooseDraftRole("default", draft, `AGENT ${cleanRoleSharingText(agent)} DRAFT`);
				if (closed || !picked) return undefined;
				const selector = (picked.config.modelRoles as ModelRoleAssignments).default ?? null;
				if (selector === null || choice === "Choose model") overrides[agent] = selector;
				else if (choice === "Add fallback") overrides[agent] = [...chain, selector];
				else if (Array.isArray(configured)) {
					const next = [...configured];
					next[index] = selector;
					overrides[agent] = next;
				} else overrides[agent] = selector;
			}
		};
		const reviewDraft = async (
			setup: ProfileDashboardSetupRef,
			draft: ProfileDraft,
			forExport = false,
			saveDraft?: (draft: ProfileDraft, saveAsNew: boolean) => Promise<boolean>,
		): Promise<{ draft: ProfileDraft; saveAsNew: boolean } | undefined> => {
			// Construct once: even Settings.isolated().override() invokes global setting hooks.
			const effective = this.#createProfileRoleSource({
				config: draft.config,
				snapshot: snapshots.get(setupKey(setup)),
				label: "PROFILE DRAFT",
				role: "default",
			});
			const inheritedSettings =
				setup.kind === "saved"
					? await Settings.loadReadOnly({ cwd, agentDir, configFiles: [...getProfileLaunchConfigFiles()] })
					: this.ctx.settings;
			const availableThemes = await getAvailableThemes();
			const availableModels = this.ctx.session.modelRegistry.getAll();
			const draftModel = resolveModelRoleValue(effective.settings.getModelRole("default"), availableModels, {
				settings: effective.settings,
			}).model;
			if (closed) return undefined;
			const result = Promise.withResolvers<{ draft: ProfileDraft; saveAsNew: boolean } | undefined>();
			let finished = false;
			const finish = (value?: { draft: ProfileDraft; saveAsNew: boolean }): void => {
				if (finished) return;
				finished = true;
				handle.hide();
				result.resolve(closed ? undefined : value);
			};
			const editor = new ProfileEditorComponent({
				draft,
				effectiveSettings: effective.settings,
				inheritedSettings,
				registry: this.ctx.session.modelRegistry,
				name: setup.kind === "saved" ? setup.name : "Current setup",
				title: forExport ? "Prepare profile export" : "Edit profile",
				saveLabel: forExport ? "Continue to export" : "Save",
				allowSaveAsNew: !forExport,
				terminalHeight: this.ctx.ui.terminal.rows,
				agentNames: snapshots.get(setupKey(currentSetup))?.agents.map(agent => agent.name) ?? [],
				settingsContext: {
					availableThinkingLevels: [...(draftModel ? getSupportedEfforts(draftModel) : THINKING_EFFORTS)],
					availableThemes,
					providers: [...new Set(availableModels.map(model => model.provider))].sort((a, b) => a.localeCompare(b)),
					model: draftModel,
					imageBudget: this.ctx.ui.imageBudget,
					composerPreviewStatus: this.ctx.statusLine,
				},
				callbacks: {
					requestRender: () => {
						if (!closed && !finished) this.ctx.ui.requestRender();
					},
					onSaveEmoji:
						setup.kind === "saved" && !forExport
							? async emoji => {
									if (closed || finished) return false;
									const { config, metadata } = await readSavedSetup(setup.name, agentDir);
									if (closed || finished) return false;
									metadata.emoji = emoji;
									const saved = await saveProfileDraft(
										setup.name,
										{ config, metadata },
										{ overwrite: true, agentDir },
									);
									if (closed || finished) return false;
									descriptors = descriptors.map(item => (item.name === saved.name ? saved : item));
									setups = toSetupRefs(descriptors);
									const cached = this.#profileSnapshotCache.get(cacheKey(setup));
									if (cached) cached.sourceUpdatedAt = saved.updatedAt;
									dashboard.setSetups(setups, {
										kind: "saved",
										name: saved.name,
										metadata: saved.metadata,
									});
									return true;
								}
							: undefined,
					onEditRole: async (role, value) => {
						handle.setHidden(true);
						const next = await chooseDraftRole(role, value);
						if (!closed && !finished) {
							handle.setHidden(false);
							this.ctx.ui.setFocus(editor);
							this.ctx.ui.requestRender();
						}
						return next;
					},
					onEditAgent: async (agent, value) => {
						handle.setHidden(true);
						const next = await chooseDraftAgent(agent, value);
						if (!closed && !finished) {
							handle.setHidden(false);
							this.ctx.ui.setFocus(editor);
							this.ctx.ui.requestRender();
						}
						return next;
					},
					onSave: async (value, saveAsNew) => {
						if (!saveDraft) {
							finish({ draft: value, saveAsNew });
							return;
						}
						handle.setHidden(true);
						try {
							if (!(await saveDraft(value, saveAsNew))) {
								finish();
								return;
							}
							finish({ draft: value, saveAsNew });
						} catch (error) {
							if (!closed && !finished) {
								handle.setHidden(false);
								this.ctx.ui.setFocus(editor);
								this.ctx.ui.requestRender();
							}
							throw error;
						}
					},
					onCancel: () => finish(),
				},
			});
			const handle = this.#showFullscreenMenu(editor);
			const cancel = (): void => finish();
			closeDraftEditor = cancel;
			const value = await result.promise;
			if (closeDraftEditor === cancel) closeDraftEditor = undefined;
			return value;
		};
		const editProfile = async (setup: ProfileDashboardSetupRef): Promise<void> => {
			if (closed || interactionPending || !setupExists(setup)) return;
			interactionPending = true;
			overlayHandle.setHidden(true);
			let notice: { message: string; tone: "error" | "success" } | undefined;
			try {
				await reviewDraft(setup, await readDraft(setup), false, async (draft, saveAsNew) => {
					const overwrite = setup.kind === "saved" && !saveAsNew;
					let name = setup.kind === "saved" ? setup.name : "";
					if (overwrite) {
						const confirmed = await this.ctx.showHookConfirm(
							`Save changes to ${cleanRoleSharingText(name)}?`,
							"This replaces this saved profile only. It does not reapply it to the current session.",
							{ signal: dialogController.signal },
						);
						if (!confirmed || closed) return false;
					} else {
						let prompt = "Save profile as";
						for (;;) {
							const input = await this.ctx.showHookInput(prompt, "Setup name", {
								signal: dialogController.signal,
							});
							if (input === undefined || closed) return false;
							try {
								name = normalizeSetupName(input);
							} catch (error) {
								prompt = `${cleanRoleSharingText(error instanceof Error ? error.message : "Invalid setup name")}\nSave profile as`;
								continue;
							}
							const existing = (await listSavedSetups(agentDir)).some(
								item =>
									item.name === name ||
									(process.platform === "win32" && item.name.toLowerCase() === name.toLowerCase()),
							);
							if (closed) return false;
							if (!existing) break;
							prompt = "That setup already exists. Choose another name.\nSave profile as";
						}
					}
					if (closed) return false;
					const saved = await saveProfileDraft(name, draft, { overwrite, agentDir });
					if (closed) return false;
					const savedRef: ProfileDashboardSavedSetupRef = {
						kind: "saved",
						name: saved.name,
						metadata: saved.metadata,
					};
					if (!(await syncSetups(savedRef))) return false;
					await loadSetup(savedRef, true);
					notice = {
						message: `Saved profile ${cleanRoleSharingText(saved.name)}. Load it explicitly to activate.`,
						tone: "success",
					};
					return true;
				});
			} catch (error) {
				notice = {
					message: cleanRoleSharingText(error instanceof Error ? error.message : "Unable to save profile"),
					tone: "error",
				};
			} finally {
				interactionPending = false;
				restoreDashboard();
				if (!closed && notice) dashboard.setActionNotice(notice.message, notice.tone);
			}
		};
		const saveCurrentSetup = (): Promise<void> => editProfile(currentSetup);
		const exportRoles = async (setup: ProfileDashboardSetupRef): Promise<void> => {
			if (closed || interactionPending || !setupExists(setup)) return;
			interactionPending = true;
			overlayHandle.setHidden(true);
			let notice: { message: string; tone: "error" | "success" } | undefined;
			try {
				const scope = await this.ctx.showHookSelector(
					"Export scope",
					[
						{ label: "Profile", description: "Models, emoji and only this profile's enabled settings groups" },
						{
							label: "Model roles only",
							description: "Explicitly omit emoji, optional groups and agent overrides",
						},
						"Cancel",
					],
					{ signal: dialogController.signal },
				);
				if (closed || scope === undefined || scope === "Cancel") return;
				let draft = await readDraft(setup);
				if (closed) return;
				if (scope === "Profile" && setup.kind === "current") {
					const reviewed = await reviewDraft(setup, draft, true);
					if (!reviewed || closed) return;
					draft = reviewed.draft;
				}
				const name = setup.kind === "saved" ? setup.name : undefined;
				const roles = draft.config.modelRoles as ModelRoleAssignments;
				// Validate before touching either transport; legacy exclusions name the saved path.
				const payload = scope === "Profile" ? serializeProfile(draft, name) : serializeModelRoles(roles);
				const transport = await this.ctx.showHookSelector(
					`Export ${scope === "Profile" ? "profile" : "model roles"}`,
					[
						{ label: "Copy to clipboard", description: "Copy the portable YAML payload" },
						{ label: "To file", description: "Create a YAML file without replacing an existing file" },
						"Cancel",
					],
					{ signal: dialogController.signal },
				);
				if (closed || transport === undefined || transport === "Cancel") return;
				if (transport === "Copy to clipboard") {
					await copyToClipboard(payload);
					notice = {
						message: `Copied ${scope === "Profile" ? "profile" : "model roles"} to clipboard`,
						tone: "success",
					};
					return;
				}
				let prompt = "Export to";
				for (;;) {
					const input = await this.ctx.showHookInput(
						prompt,
						scope === "Profile" ? "profile.yml" : "model-roles.yml",
						{
							signal: dialogController.signal,
						},
					);
					if (closed || input === undefined) return;
					let filePath: string;
					try {
						filePath = resolveToCwd(input.trim(), cwd);
					} catch {
						prompt = "Invalid export path\nExport to";
						continue;
					}
					try {
						if (scope === "Profile") await writeProfileFile(filePath, draft, name);
						else await writeModelRolesFile(filePath, roles);
					} catch (error) {
						if (error instanceof Error && /exist/i.test(error.message)) {
							prompt = "That file already exists. Choose another export path.\nExport to";
							continue;
						}
						throw error;
					}
					notice = { message: `Exported to ${cleanRoleSharingText(shortenPath(filePath))}`, tone: "success" };
					return;
				}
			} catch (error) {
				notice = {
					message: cleanRoleSharingText(
						shortenPath(error instanceof Error ? error.message : "Unable to export profile"),
					),
					tone: "error",
				};
			} finally {
				interactionPending = false;
				restoreDashboard();
				if (!closed && notice) dashboard.setActionNotice(notice.message, notice.tone);
			}
		};
		const importRoles = async (): Promise<void> => {
			if (closed || interactionPending) return;
			interactionPending = true;
			overlayHandle.setHidden(true);
			let notice: { message: string; tone: "error" | "success" } | undefined;
			try {
				const transport = await this.ctx.showHookSelector(
					"Import profile or model roles",
					[
						{ label: "From clipboard", description: "Read an omp-profile or omp-model-roles YAML payload" },
						{ label: "From file", description: "Read a portable YAML file" },
						"Cancel",
					],
					{ signal: dialogController.signal },
				);
				if (closed || transport === undefined || transport === "Cancel") return;
				let artifact;
				if (transport === "From clipboard") {
					const content = await readTextFromClipboard();
					if (closed) return;
					artifact = parseProfileArtifact(content);
				} else {
					const input = await this.ctx.showHookInput("Import from", "profile.yml", {
						signal: dialogController.signal,
					});
					if (closed || input === undefined) return;
					artifact = await readProfileArtifactFile(resolveToCwd(input.trim(), cwd));
				}
				if (closed) return;
				let draft = artifact.draft;
				const registry = this.ctx.session.modelRegistry;
				const snapshot =
					snapshots.get(setupKey(currentSetup)) ??
					(await buildProfileSnapshot({
						profile: activeProfile,
						cwd,
						settings: this.ctx.settings,
						modelRegistry: registry,
						authStorage: registry.authStorage,
						sessionId: this.ctx.session.sessionId,
					}));
				if (closed) return;
				const knownAgents = new Set(snapshot.agents.map(agent => agent.name));
				const project = () => projectProfileCompatibility(draft, this.ctx.settings, registry, knownAgents);
				const original = project();
				const assignmentLabel = (identity: ProfileAssignmentIdentity): string =>
					identity.kind === "role"
						? `Role ${cleanRoleSharingText(identity.role)}`
						: `Agent ${cleanRoleSharingText(identity.agent)}${identity.fallbackIndex === null ? "" : ` fallback ${identity.fallbackIndex + 1}`}`;
				const explicitlyResolved = new Set<string>();
				const oauthProviderIds = new Set(
					loadProviderAuthUi()
						.getOAuthProviders()
						.map(provider => provider.id),
				);
				const showPreview = async (final: boolean): Promise<boolean> => {
					const review = project();
					const entries: Array<{ label: string; description: string }> = [
						{
							label: `${draft.metadata.emoji ?? "None"} · ${cleanRoleSharingText(artifact.name ?? "Imported profile")}`,
							description: "Emoji is a user label, not a price, speed or offline guarantee.",
						},
					];
					for (const row of review.assignments) {
						const before = original.assignments.find(
							item => profileAssignmentKey(item.identity) === profileAssignmentKey(row.identity),
						);
						entries.push({
							label: `${assignmentLabel(row.identity)} — ${roleImportStatusLabel(row.status)} — ${
								final ? `${cleanRoleSharingText(before?.selector ?? "Automatic")} → ` : ""
							}${cleanRoleSharingText(row.selector ?? "Automatic")}`,
							description: describeRoleImportStatus({ ...row, role: assignmentLabel(row.identity) }),
						});
					}
					for (const agent of review.agents) {
						entries.push({
							label: `Agent ${cleanRoleSharingText(agent.agent)} — ${agent.status}`,
							description:
								agent.status === "missing"
									? "No local definition. Explicit removal is required; no agent will be created."
									: "Local definition available; imported enable/disable and assignment values remain draft-only.",
						});
					}
					for (const group of PROFILE_SETTINGS_GROUPS) {
						const enabled = draft.metadata.enabledGroups.includes(group.id);
						entries.push({
							label: `${group.label} — ${enabled ? "ON" : "OFF"}`,
							description: enabled
								? "Only the saved paths below are owned. Local service availability is unverified."
								: "Use local configuration",
						});
						if (!enabled) continue;
						for (const settingPath of getProfileGroupPaths(group.id)) {
							const saved = savedSettingValue(draft.config, settingPath);
							if (!saved.found) continue;
							const ui = getUi(settingPath);
							entries.push({
								label: `${cleanRoleSharingText(settingPath)}: ${cleanRoleSharingText(JSON.stringify(saved.value))}`,
								description: [
									`Local: ${cleanRoleSharingText(JSON.stringify(this.ctx.settings.get(settingPath)))}`,
									ui?.warning,
								]
									.filter(Boolean)
									.join(" · "),
							});
						}
					}
					if (closed || dialogController.signal.aborted) return false;
					const result = Promise.withResolvers<boolean>();
					let finished = false;
					const finish = (proceed: boolean): void => {
						if (finished) return;
						finished = true;
						dialogController.signal.removeEventListener("abort", abort);
						preview.dispose();
						previewHandle.hide();
						result.resolve(proceed);
					};
					const abort = (): void => finish(false);
					const preview = new ProfileImportPreview({
						title: final ? "Final imported profile preview" : "Imported profile preview",
						entries,
						nextStep: final
							? "Continue to choose a setup name. Saving does not activate the profile or transfer credentials."
							: "Continue to resolve compatibility requirements. Saving remains blocked until every required item is resolved.",
						terminalHeight: this.ctx.ui.terminal.rows,
						onContinue: () => finish(true),
						onCancel: () => finish(false),
						requestRender: () => {
							if (!closed && !finished) this.ctx.ui.requestRender();
						},
					});
					dialogController.signal.addEventListener("abort", abort, { once: true });
					const previewHandle = this.#showFullscreenMenu(preview);
					if (closed || dialogController.signal.aborted) finish(false);
					return result.promise;
				};
				if (!(await showPreview(false)) || closed) return;
				for (;;) {
					const review = project();
					const missingAgent = review.agents.find(agent => agent.status === "missing");
					if (missingAgent) {
						const choice = await this.ctx.showHookSelector(
							`Missing local agent: ${cleanRoleSharingText(missingAgent.agent)}`,
							[
								{
									label: "Remove this agent from the draft",
									description:
										"Remove its saved override and disabled-agent entry; leave other agents unchanged",
								},
								"Cancel import",
							],
							{ signal: dialogController.signal },
						);
						if (closed || choice !== "Remove this agent from the draft") return;
						draft = removeUnavailableProfileAgent(draft, missingAgent.agent);
						continue;
					}
					const attention = review.assignments.find(
						row =>
							row.status !== "ready" &&
							row.status !== "automatic" &&
							!explicitlyResolved.has(profileAssignmentKey(row.identity)),
					);
					if (!attention) break;
					const identity = attention.identity;
					const key = profileAssignmentKey(identity);
					const before = original.assignments.find(row => profileAssignmentKey(row.identity) === key);
					let currentSelector: string | null = null;
					if (identity.kind === "role") currentSelector = this.ctx.settings.getModelRole(identity.role) ?? null;
					else {
						const overrides = this.ctx.settings.get("task.agentModelOverrides");
						const current = Object.hasOwn(overrides, identity.agent) ? overrides[identity.agent] : undefined;
						currentSelector = Array.isArray(current)
							? (current[identity.fallbackIndex ?? 0] ?? null)
							: (current ?? null);
					}
					const loginLabel = attention.provider
						? `Login to ${cleanRoleSharingText(attention.provider)}`
						: undefined;
					const actions: Array<string | { label: string; description: string }> = [
						{
							label: "Keep current assignment",
							description: cleanRoleSharingText(currentSelector ?? "Automatic"),
						},
						{
							label: "Use Automatic",
							description:
								identity.kind === "agent" && identity.fallbackIndex !== null
									? "Replace this agent's entire fallback chain with Automatic"
									: "Save a null assignment; this is not :auto thinking",
						},
						{
							label: "Choose replacement model",
							description: "Choose a replacement for this draft assignment only",
						},
					];
					if (attention.provider && loginLabel && oauthProviderIds.has(attention.provider)) {
						actions.push({
							label: loginLabel,
							description: "Explicitly save local credentials; cancellation does not undo login",
						});
					}
					actions.push("Show provider configuration help", "Recheck provider", "Cancel import");
					const action = await this.ctx.showHookSelector(
						`${assignmentLabel(identity)}\nRequested: ${cleanRoleSharingText(before?.selector ?? "Automatic")}\n${describeRoleImportStatus({ ...attention, role: assignmentLabel(identity) })}`,
						actions,
						{ signal: dialogController.signal },
					);
					if (closed || action === undefined || action === "Cancel import") return;
					if (action === "Keep current assignment" || action === "Use Automatic") {
						draft = replaceProfileAssignment(
							draft,
							identity,
							action === "Use Automatic" ? null : currentSelector,
						);
						explicitlyResolved.add(key);
						continue;
					}
					if (attention.provider && loginLabel && action === loginLabel) {
						await this.#handleOAuthLogin(attention.provider);
						if (closed) return;
						continue;
					}
					if (action === "Show provider configuration help") {
						const choice = await this.ctx.showHookSelector(
							"Configure the provider explicitly outside this importer",
							[
								{
									label: "Back",
									description: `Set its API-key environment variable or edit ${cleanRoleSharingText(shortenPath(path.join(agentDir, "models.yml")))}`,
								},
								"Cancel import",
							],
							{ signal: dialogController.signal },
						);
						if (closed || choice !== "Back") return;
						continue;
					}
					if (action === "Recheck provider") {
						if (attention.provider) await registry.refreshProvider(attention.provider, "online");
						else await registry.refresh("offline");
						if (closed) return;
						continue;
					}
					if (action !== "Choose replacement model") continue;
					const pickerRole = identity.kind === "role" ? identity.role : "default";
					const picked = await chooseDraftRole(pickerRole, draft, `${assignmentLabel(identity)} · IMPORT DRAFT`);
					if (closed || !picked) return;
					const replacement = (picked.config.modelRoles as ModelRoleAssignments)[pickerRole] ?? null;
					draft = replaceProfileAssignment(draft, identity, replacement);
					explicitlyResolved.add(key);
					const matching = project().assignments.filter(
						row =>
							row.status !== "ready" &&
							row.status !== "automatic" &&
							!explicitlyResolved.has(profileAssignmentKey(row.identity)) &&
							original.assignments.some(
								item =>
									profileAssignmentKey(item.identity) === profileAssignmentKey(row.identity) &&
									item.selector === before?.selector,
							),
					);
					if (matching.length === 0) continue;
					const grouped = await this.ctx.showHookConfirm(
						`Replace ${matching.length} matching assignments too?`,
						"These roles or agent fallback entries requested the identical original selector. Other fallback positions retain their order.",
						{ signal: dialogController.signal },
					);
					if (closed) return;
					if (grouped) {
						for (const row of matching) {
							if (
								!project().assignments.some(
									item => profileAssignmentKey(item.identity) === profileAssignmentKey(row.identity),
								)
							)
								continue;
							draft = replaceProfileAssignment(draft, row.identity, replacement);
							explicitlyResolved.add(profileAssignmentKey(row.identity));
						}
					}
				}
				if (!(await showPreview(true)) || closed) return;
				let prompt = "Save imported profile as";
				for (;;) {
					const input = await this.ctx.showHookInput(prompt, artifact.name ?? "Setup name", {
						signal: dialogController.signal,
					});
					if (closed || input === undefined) return;
					let name: string;
					try {
						name = normalizeSetupName(input);
					} catch {
						prompt = "Invalid setup name\nSave imported profile as";
						continue;
					}
					const confirmed = await this.ctx.showHookConfirm(
						`Save imported profile as ${cleanRoleSharingText(name)}?`,
						"This creates a new setup only. The current session, models, settings and conversation are unchanged.",
						{ signal: dialogController.signal },
					);
					if (closed || !confirmed) return;
					let saved: SavedSetupDescriptor;
					try {
						saved = await saveProfileDraft(name, draft, { agentDir });
					} catch (error) {
						if (error instanceof Error && /already exists/i.test(error.message)) {
							prompt = "That setup already exists. Choose another name.\nSave imported profile as";
							continue;
						}
						throw error;
					}
					if (closed) return;
					const savedRef: ProfileDashboardSavedSetupRef = {
						kind: "saved",
						name: saved.name,
						metadata: saved.metadata,
					};
					if (!(await syncSetups(savedRef))) return;
					await loadSetup(savedRef, true);
					notice = {
						message: `Saved imported profile ${cleanRoleSharingText(saved.name)}. Press l to load it.`,
						tone: "success",
					};
					return;
				}
			} catch (error) {
				notice = {
					message: `Unable to import profile: ${cleanRoleSharingText(error instanceof Error ? error.message : "Invalid artifact")}`,
					tone: "error",
				};
			} finally {
				interactionPending = false;
				restoreDashboard();
				if (!closed && notice) dashboard.setActionNotice(notice.message, notice.tone);
			}
		};
		const renameSetup = async (setup: ProfileDashboardSavedSetupRef): Promise<void> => {
			if (closed || interactionPending || !setupExists(setup)) return;
			interactionPending = true;
			overlayHandle.setHidden(true);
			try {
				const input = await this.ctx.showHookInput("Rename saved setup", setup.name, {
					signal: dialogController.signal,
				});
				if (closed || input === undefined) return;
				const renamed = await renameSavedSetup(setup.name, input, agentDir);
				if (closed) return;
				const renamedRef: ProfileDashboardSavedSetupRef = { kind: "saved", name: renamed.name };
				if (!(await syncSetups(renamedRef))) return;
				await loadSetup(renamedRef, true);
				if (!closed) this.ctx.showStatus(`Renamed setup ${setup.name} to ${renamed.name}`);
			} catch (error) {
				if (!closed) this.ctx.showError(error instanceof Error ? error.message : "Unable to rename setup");
			} finally {
				interactionPending = false;
				restoreDashboard();
			}
		};
		const deleteSetup = async (setup: ProfileDashboardSavedSetupRef): Promise<void> => {
			if (closed || interactionPending || !setupExists(setup)) return;
			interactionPending = true;
			overlayHandle.setHidden(true);
			try {
				const confirmed = await this.ctx.showHookConfirm(
					`Delete setup ${setup.name}?`,
					"This deletes only the saved setup. Your current session, accounts, and credentials are unchanged.",
					{ signal: dialogController.signal },
				);
				if (closed || !confirmed) return;
				await deleteSavedSetup(setup.name, agentDir);
				if (closed || !(await syncSetups(currentSetup))) return;
				await loadSetup(currentSetup);
				if (!closed) this.ctx.showStatus(`Deleted setup ${setup.name}`);
			} catch (error) {
				if (!closed) this.ctx.showError(error instanceof Error ? error.message : "Unable to delete setup");
			} finally {
				interactionPending = false;
				restoreDashboard();
			}
		};
		const loadSavedSetup = async (setup: ProfileDashboardSavedSetupRef): Promise<void> => {
			if (closed || interactionPending || !setupExists(setup)) return;
			interactionPending = true;
			overlayHandle.setHidden(true);
			let noticeAfterRestore: { message: string; tone: "error" | "success" } | undefined;
			let choice: string | undefined;
			try {
				choice = await this.ctx.showHookSelector(
					`Load setup ${cleanRoleSharingText(setup.name)}`,
					[
						{
							label: "Apply models to current session",
							description:
								"Model roles and thinking only; keeps this conversation and draft. Optional settings require a fresh session",
						},
						{
							label: "Start a new session",
							description:
								"Loads models and only enabled groups' saved paths; OFF groups inherit local configuration",
						},
						"Cancel",
					],
					{ signal: dialogController.signal },
				);
				if (closed || choice === undefined || choice === "Cancel") return;

				const blockReason = canLaunchSetups ? this.ctx.getProfileSwitchBlockReason() : launchRequiredMessage;
				dashboard.setLoadBlockReason(blockReason);
				if (blockReason) {
					noticeAfterRestore = { message: cleanRoleSharingText(blockReason), tone: "error" };
					return;
				}

				if (choice === "Start a new session") {
					await this.ctx.requestProfileSwitch(activeProfile, setup.name);
					return;
				}

				const { config } = await readSavedSetup(setup.name, agentDir);
				if (closed || dialogController.signal.aborted) return;
				const recheckReason = this.ctx.getProfileSwitchBlockReason();
				if (recheckReason) {
					noticeAfterRestore = { message: cleanRoleSharingText(recheckReason), tone: "error" };
					return;
				}

				const releaseDefaultMutation = await this.#acquireDefaultRoleMutation();
				try {
					if (closed || dialogController.signal.aborted) return;
					await applySetupModelRoles({
						session: this.ctx.session,
						settings: this.ctx.settings,
						roles: { ...(config.modelRoles as ModelRoleAssignments) },
						signal: dialogController.signal,
						getBlockReason: () => this.ctx.getProfileSwitchBlockReason(),
					});
				} finally {
					releaseDefaultMutation();
				}
				if (closed || dialogController.signal.aborted) return;
				dashboard.setSetups(setups, currentSetup);
				await loadSetup(currentSetup, true);
				if (!closed) {
					noticeAfterRestore = {
						message: `Applied setup ${cleanRoleSharingText(setup.name)} models to current session`,
						tone: "success",
					};
				}
			} catch (error) {
				if (closed) return;
				if (choice === "Apply models to current session") {
					const detail = error instanceof Error ? cleanRoleSharingText(error.message) : "";
					noticeAfterRestore = {
						message: `Unable to apply setup models${detail ? `: ${detail}` : ""}`,
						tone: "error",
					};
				} else {
					this.ctx.showError("Unable to load saved setup");
				}
			} finally {
				interactionPending = false;
				restoreDashboard();
				if (!closed && noticeAfterRestore) {
					dashboard.setActionNotice(noticeAfterRestore.message, noticeAfterRestore.tone);
				}
			}
		};
		const openActiveControl = (control: ProfileDashboardActiveControl): void => {
			if (dashboard.selectedSetup?.kind !== "current" || closeActiveControl) return;
			if (control === "settings") {
				settingsSelector.selectTab("appearance");
				return;
			}
			interactionPending = true;
			overlayHandle.setHidden(true);
			if (control === "model") {
				const closeModelHub = this.#showModelHub({
					isCancelled: () => closed,
					setClose: close => {
						if (closed) close();
						else closeActiveControl = close;
					},
					onDone: () => {
						closeActiveControl = undefined;
						interactionPending = false;
						restoreDashboard();
						void refreshDashboard(true);
					},
				});
				closeActiveControl = closeModelHub;
				return;
			}
			let cancelled = false;
			const pendingClose = () => {
				cancelled = true;
			};
			closeActiveControl = pendingClose;
			void this.showAgentsDashboard({
				isCancelled: () => closed || cancelled,
				onDone: () => {
					closeActiveControl = undefined;
					interactionPending = false;
					restoreDashboard();
					void refreshDashboard(true);
				},
			})
				.then(closeAgents => {
					if (closed || cancelled) {
						closeAgents();
					} else if (closeActiveControl === pendingClose) {
						closeActiveControl = closeAgents;
					}
				})
				.catch(error => {
					if (closed) return;
					closeActiveControl = undefined;
					interactionPending = false;
					restoreDashboard();
					this.ctx.showError(error instanceof Error ? error.message : "Unable to open Agents");
				});
		};

		const dashboard = new ProfileDashboard({
			setups,
			terminalHeight: this.ctx.ui.terminal.rows,
			loadBlockReason: canLaunchSetups ? this.ctx.getProfileSwitchBlockReason() : launchRequiredMessage,
			callbacks: {
				requestRender: () => {
					if (!closed) this.ctx.ui.requestRender();
				},
				close: handleUserClose,
				selected: setup => {
					if (closed || interactionPending) return;
					dashboard.setLoadBlockReason(
						canLaunchSetups ? this.ctx.getProfileSwitchBlockReason() : launchRequiredMessage,
					);
					const key = setupKey(setup);
					if (!snapshots.has(key) && !controllers.has(key)) void loadSetup(setup);
				},
				deleteSetup,
				renameSetup,
				loadSetup: loadSavedSetup,
				editProfile,
				saveCurrentSetup,
				importRoles,
				exportRoles,
				openActiveControl,
			},
		});
		this.#closeProfileDashboard = teardown;
		settingsSelector.setProfilesContent(dashboard);
		this.ctx.ui.setFocus(settingsSelector);
		this.ctx.ui.requestRender();
		const selected = dashboard.selectedSetup;
		if (selected) void loadSetup(selected);
		for (const setup of setups) {
			if (selected && setupKey(setup) === setupKey(selected)) continue;
			void loadSetup(setup);
		}
		return refreshDashboard;
	}

	/**
	 * Fullscreen git UI on the alternate screen (the /models idiom): split
	 * diff viewer, staging sidebar, and commit composer. Resolves focus back
	 * to the editor when the user closes it.
	 */
	async showGitTui(revision?: string): Promise<void> {
		try {
			await showGitOverlay(this.ctx.ui, { cwd: getProjectDir(), revision });
		} catch (error) {
			this.ctx.showStatus(error instanceof Error ? error.message : String(error));
		}
		this.focusActiveEditorArea();
		this.ctx.ui.requestRender();
	}

	/**
	 * Fullscreen agents hub on the alternate screen (the /models idiom): scope
	 * sidebar, agent rows, and chip strips that dive into the model browser.
	 */
	async showAgentsDashboard(options: AgentsDashboardHostOptions = {}): Promise<() => void> {
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			hub?.dispose();
			overlayHandle.hide();
			if (options.onDone) options.onDone();
			else {
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			}
		};
		const hub = await AgentsHubComponent.create(
			this.ctx.ui,
			createAgentsHubDeps(
				getProjectDir(),
				this.ctx.settings,
				this.ctx.session.modelRegistry,
				() => this.ctx.session.effectiveExtensionRoots,
				activeModelPattern,
				defaultModelPattern,
			),
			{ onCancel: done },
		);
		if (options.isCancelled?.()) {
			closed = true;
			hub.dispose();
			return () => {};
		}
		const overlayHandle = this.#showFullscreenMenu(hub);
		return done;
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	handleSettingChange(id: string, value: unknown): void {
		// Discovery provider toggles
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			const { disableProvider, enableProvider } = loadProviderToggles();
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		switch (id) {
			// Session-managed settings (not in SettingsManager)
			case "autoCompact":
				this.ctx.session.setAutoCompactionEnabled(value as boolean, true);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "composer.shape":
				this.ctx.syncComposerShape();
				break;
			case "advisor.enabled":
				this.ctx.session.setAdvisorEnabled(value as boolean);
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
				break;
			case "advisor.maxNotesPerUpdate":
				if (this.ctx.session.isAdvisorEnabled()) {
					this.ctx.session.setAdvisorEnabled(true);
					this.ctx.ui.requestRender();
				}
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time", true);
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time", true);
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait", true);
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ConfiguredThinkingLevel, true);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;
			case "personality":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply personality: ${err}`);
				});
				break;
			case "tools.xdevDocs":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply xd:// prompt docs setting: ${err}`);
				});
				break;
			case "memory.backend":
				void this.ctx.session.applyMemoryBackend().catch(err => {
					this.ctx.showError(`Failed to apply memory backend: ${err}`);
				});
				break;
			case "externalThinking":
				void this.ctx.session.setThinkToolEnabled(value as boolean).catch(err => {
					this.ctx.showError(`Failed to apply external thinking: ${err}`);
				});
				break;
			case "compaction.idleEnabled":
			case "compaction.idleThresholdTokens":
			case "compaction.idleTimeoutSeconds":
				this.ctx.eventController.refreshIdleCompactionTimer();
				break;

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;
			case "spelling.typoDetection":
			case "spelling.autocomplete":
			case "spelling.autocorrect":
				this.ctx.syncEditorSpelling();
				this.ctx.ui.requestRender();
				break;

			case "tui.vimMode":
			case "tui.vimModeDisplay":
				this.ctx.applyVimModeSetting();
				break;
			case "display.pinnedAgents":
				this.ctx.applyPinnedAgentsSetting();
				break;

			// Settings with UI side effects
			case "display.hideToolActivity": {
				const hidden = value as boolean;
				this.ctx.hideToolActivity = hidden;
				if (!hidden) this.ctx.toolOutputExpanded = false;
				for (const child of this.ctx.chatContainer.children) {
					if (!hidden && (child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent)) {
						child.setExpanded(false);
					} else if (child instanceof AssistantMessageComponent) {
						child.setToolResultImagesVisible(!hidden);
					}
				}
				this.ctx.chatContainer.setToolActivityVisible(!hidden);
				if (hidden) this.ctx.ui.clearInlineImages();
				// Match the shortcut path: visibility changes must rebuild retired terminal history.
				this.ctx.ui.resetDisplay();
				break;
			}
			case "terminal.showImages":
			case "showImages": {
				const visible = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(visible);
					} else if (child instanceof AssistantMessageComponent) {
						child.setImagesVisible(visible);
					}
				}
				if (!visible) this.ctx.ui.clearInlineImages();
				this.ctx.ui.requestRender(true);
				break;
			}
			case "hideThinkingBlock":
				this.ctx.hideThinkingBlock = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
					}
				}
				this.ctx.ui.requestRender(true);
				break;
			case "proseOnlyThinking":
				this.ctx.proseOnlyThinking = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setProseOnlyThinking(value as boolean);
					}
				}
				this.ctx.ui.requestRender(true);
				break;
			case "omitThinking":
				this.ctx.session.agent.hideThinkingSummary = value as boolean;
				break;
			case "display.cacheMissMarker":
				// Rebuild re-runs the usage-based detection under the new setting so
				// markers appear/disappear; full reset retires any already committed
				// to native scrollback (mirrors hideThinking).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.collapseCompacted":
				// Rebuild swaps between the collapsed tail and the full inline
				// history; full reset retires blocks already committed to native
				// scrollback (mirrors cacheMissMarker).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.showTokenUsage":
				// Rebuild reruns usage-row detection under the new setting; resetDisplay
				// retires rows already committed to native scrollback.
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.showTurnTime":
				// Same as showTokenUsage: the prompt→yield delta lives in the same
				// usage row, so toggling it must rebuild and retire committed rows.
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "tui.tight":
				setTuiTight(value as boolean);
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;
			case "tui.hyperlinks":
				applyHyperlinkSetting();
				this.ctx.statusLine.invalidate();
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;
			case "tui.titleState":
				setTerminalTitleStateEnabled(value as boolean);
				break;
			case "tui.titleSpinner":
				setTerminalTitleSpinnerStyle(value as string);
				break;
			case "tui.resizeScrollback":
				this.ctx.ui.setResizeScrollback(value as ResizeScrollbackMode);
				break;

			case "tui.renderMermaid":
				setMarkdownMermaidRendering(value as boolean);
				this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply Mermaid rendering setting: ${err}`);
				});
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;

			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
					if (!result.success) {
						this.ctx.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
					}
				});
				break;
			}
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(() => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(() => {
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "temperature": {
				const temp = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
				break;
			}
			case "topP": {
				const topP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topP = topP >= 0 ? topP : undefined;
				break;
			}
			case "topK": {
				const topK = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topK = topK >= 0 ? topK : undefined;
				break;
			}
			case "minP": {
				const minP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.minP = minP >= 0 ? minP : undefined;
				break;
			}
			case "presencePenalty": {
				const presencePenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
				break;
			}
			case "repetitionPenalty": {
				const repetitionPenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
				break;
			}
			case "git.enabled":
			case "statusLinePreset":
			case "statusLine.preset":
			case "statusLineSeparator":
			case "statusLine.separator":
			case "statusLineShowHooks":
			case "statusLine.showHookStatus":
			case "statusLine.sessionAccent":
			case "statusLine.transparent":
			case "statusLine.compactThinkingLevel":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				const statusLineSettings = {
					preset: settings.get("statusLine.preset"),
					leftSegments: settings.get("statusLine.leftSegments"),
					rightSegments: settings.get("statusLine.rightSegments"),
					separator: settings.get("statusLine.separator"),
					showHookStatus: settings.get("statusLine.showHookStatus"),
					sessionAccent: settings.get("statusLine.sessionAccent"),
					transparent: settings.get("statusLine.transparent"),
					segmentOptions: settings.get("statusLine.segmentOptions"),
					compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.ui.requestRender();
				break;
			}

			// MCP update injection - live subscribe/unsubscribe
			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		if (options?.temporaryOnly) {
			this.#showModelPicker();
			return;
		}
		this.#showModelHub({});
	}

	/**
	 * Session-only model switch (`/switch <selector>`): applies the resolved
	 * model without persisting it. Compacts first when the transcript exceeds
	 * the target's context window, mirroring an over-context pick in the alt+p
	 * picker. Failures surface as status errors.
	 */
	async switchSessionModel(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void> {
		const contextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const contextWindow = model.contextWindow ?? 0;
		const overContext = contextWindow > 0 && contextTokens > contextWindow;
		try {
			await this.#applySessionModel(model, `${model.provider}/${model.id}`, thinkingLevel, overContext);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Apply a session-only model: update agent state but never persist to
	 * settings. `compactFirst` runs compaction with the current model before
	 * switching (the target cannot fit the transcript); the switch runs in the
	 * before-flush hook so any prompt queued during compaction executes on the
	 * target model, and the idempotent post-return call covers the early
	 * "nothing to compact" return that skips the hook. A cancelled or failed
	 * compaction keeps the current model.
	 */
	async #applySessionModel(
		model: Model,
		selector: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		compactFirst: boolean,
	): Promise<void> {
		const apply = async () => {
			const level = thinkingLevel ?? this.ctx.session.resolveTemporaryModelThinkingLevel(model);
			await this.ctx.session.setModelTemporary(model, level);
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			const roleSelectorHint = this.ctx.keybindings.getKeys("app.model.select")[0] ?? "Alt+M";
			this.ctx.showStatus(`Session-only model: ${selector}. Use ${roleSelectorHint} or /model for roles.`);
		};
		if (!compactFirst) {
			await apply();
			return;
		}
		let switched = false;
		const switchAfterCompaction = async (outcome: CompactionOutcome) => {
			if (switched || outcome !== "ok") return;
			switched = true;
			await apply();
		};
		const outcome = await this.ctx.handleCompactCommand(undefined, undefined, switchAfterCompaction);
		await switchAfterCompaction(outcome);
	}

	/**
	 * Compact session-only model picker (alt+p / `/switch`): a floating
	 * bottom-anchored overlay over the transcript. The current model is
	 * highlighted and preselected; a leading `@` searches ctrl+p quick roles.
	 */
	#showModelPicker(): void {
		const { ModelPickerComponent } = loadModelOverlayComponents();
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const current = this.ctx.session.model;
		const quickRoleOrder = this.ctx.settings.get("cycleOrder");
		const quickRoleCycle = this.ctx.session.getRoleModelCycle(quickRoleOrder);
		const currentSelector = current ? `${current.provider}/${current.id}` : undefined;
		// Preselect the effective Task model in task mode: the configured override,
		// else the session model (the bundled task agent inherits it by default).
		const taskOverride = this.ctx.settings.get("task.agentModelOverrides").task;
		const taskSelector = (Array.isArray(taskOverride) ? taskOverride[0] : taskOverride) ?? currentSelector;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const picker = new ModelPickerComponent(
			this.ctx.ui,
			createModelBrowserSource(this.ctx.settings),
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onPick: async (model, selector, { overContext }) => {
					try {
						// Over-context pick: close the picker first so the compaction
						// loader is visible.
						if (overContext) done();
						await this.#applySessionModel(model, selector, undefined, overContext);
						if (!overContext) done();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onPickRole: async entry => {
					try {
						await this.ctx.session.applyRoleModel(entry);
						this.ctx.statusLine.invalidate();
						this.ctx.updateEditorBorderColor();
						this.ctx.showModelCycleTrack(
							renderSegmentTrack(
								quickRoleOrder.map(role => ({ label: role })),
								quickRoleOrder.indexOf(entry.role),
							),
						);
						done();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onPickTask: (_model, selector) => {
					// Session-only: layer the Task override onto the runtime settings
					// layer so it is never persisted, mirroring the session-model pick.
					this.ctx.settings.override("task.agentModelOverrides", {
						...this.ctx.settings.get("task.agentModelOverrides"),
						task: selector,
					});
					this.ctx.showStatus(`Task subagent model (session-only): ${selector}. Use /agents to persist.`);
					done();
				},
				onCancel: done,
			},
			{
				currentContextTokens,
				currentSelector,
				taskModeKeys: this.ctx.keybindings.getKeys("app.model.selectTemporary"),
				taskModeKeyLabel: this.ctx.keybindings.getDisplayString("app.model.selectTemporary") || "alt+p",
				taskSelector,
				quickRoles: quickRoleCycle?.models,
				quickRoleOrder,
				currentQuickRole: quickRoleCycle?.models[quickRoleCycle.currentIndex]?.role,
			},
		);
		const overlayHandle = this.ctx.ui.showOverlay(picker, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(picker);
		this.ctx.ui.requestRender();
	}

	/**
	 * Fullscreen model hub on the alternate screen (the /settings idiom): the
	 * overlay enables mouse tracking for its lifetime and the transcript stays
	 * untouched underneath. Provider and focused-role entry points share the
	 * same live mutation callbacks unless an isolated role destination is supplied.
	 */
	#showModelHub(hubOptions: ModelHubHostOptions): () => void {
		const { ModelHubComponent } = loadModelOverlayComponents();
		let closed = false;
		const closeOverlay = (): boolean => {
			if (closed) return false;
			closed = true;
			hub?.dispose();
			overlayHandle?.hide();
			return true;
		};
		const done = () => {
			if (!closeOverlay()) return;
			if (hubOptions.onDone) hubOptions.onDone();
			else {
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			}
		};
		const hub = new ModelHubComponent(
			this.ctx.ui,
			hubOptions.source ?? createModelBrowserSource(this.ctx.settings),
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onAssign: async (model, role, thinkingLevel, selector, scope?: ModelRoleSelectionScope) => {
					if (hubOptions.roleCallbacks) {
						return hubOptions.roleCallbacks.onAssign(model, role, thinkingLevel, selector, scope);
					}
					const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
					const configuredStorage = this.ctx.settings.get("modelRoleStorage");
					const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
					const selectorValue = selector ?? `${model.provider}/${model.id}`;
					const scopeLabel =
						configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
					const defaultStatusLabel = configuredStorage === "project" ? `${scopeLabel}default` : "Default";
					try {
						if (role === "default") {
							// `auto` on the default role configures the active session. Other roles
							// persist an explicit `:auto` suffix and must not mutate the current model.
							const isAuto = thinkingLevel === AUTO_THINKING;
							const concreteThinking = isAuto || thinkingLevel === undefined ? undefined : thinkingLevel;
							const effectiveProvenance = this.ctx.settings.getModelRoleProvenance("default");
							const shadowedGlobal =
								configuredStorage === "project" &&
								targetScope === "global" &&
								(effectiveProvenance === "project" ||
									effectiveProvenance === "overlay" ||
									(effectiveProvenance === "runtime" &&
										this.ctx.settings.isProjectModelRoleRuntimeOverrideActive("default")));
							const shadowedProject =
								configuredStorage === "project" &&
								targetScope === "project" &&
								effectiveProvenance === "overlay";
							if (shadowedGlobal) {
								this.ctx.settings.setModelRole(
									"default",
									formatModelSelectorValue(selectorValue, concreteThinking),
								);
								if (isAuto) {
									this.ctx.settings.set("defaultThinkingLevel", AUTO_THINKING);
								}
							} else if (shadowedProject) {
								this.ctx.settings.setProjectModelRole(
									"default",
									formatModelSelectorValue(selectorValue, concreteThinking),
								);
								if (isAuto) {
									this.ctx.settings.set("defaultThinkingLevel", AUTO_THINKING);
								}
							} else {
								const { switched } = await this.ctx.session.setModel(model, role, {
									selector,
									thinkingLevel: isAuto ? ThinkingLevel.Inherit : concreteThinking,
									persist: targetScope === "global",
								});
								if (!switched) return false;
								if (targetScope === "project") {
									this.ctx.settings.setProjectModelRole(
										"default",
										formatModelSelectorValue(selectorValue, concreteThinking),
									);
								}
								if (isAuto) {
									this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
								} else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
									this.ctx.session.setThinkingLevel(concreteThinking);
								}
								this.ctx.statusLine.invalidate();
								this.ctx.updateEditorBorderColor();
							}
							this.ctx.showStatus(`${defaultStatusLabel} model: ${selector ?? model.id}`);
						} else {
							// Other roles (smol, slow, custom): update settings, not the current model.
							const modelRoleValue = formatModelSelectorValue(selectorValue, thinkingLevel);
							if (targetScope === "project") {
								this.ctx.settings.setProjectModelRole(role, modelRoleValue);
							} else {
								this.ctx.settings.setModelRole(role, modelRoleValue);
							}
							const roleInfo = getRoleInfo(role, settings);
							this.ctx.showStatus(
								`${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} model: ${selector ?? model.id}`,
							);
						}
						return true;
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
						return false;
					} finally {
						releaseDefaultMutation?.();
						hub?.refreshAfterExternalMutation();
					}
				},
				onUnassign: async (role, scope?: ModelRoleSelectionScope) => {
					if (hubOptions.roleCallbacks) return hubOptions.roleCallbacks.onUnassign(role, scope);
					const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
					const configuredStorage = this.ctx.settings.get("modelRoleStorage");
					const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
					const scopeLabel =
						configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
					try {
						const previousEffectiveRoleValue =
							role === "default" ? this.ctx.settings.getModelRole("default") : undefined;
						if (targetScope === "project") {
							this.ctx.settings.clearProjectModelRole(role);
						} else {
							this.ctx.settings.setModelRole(role, undefined);
						}
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(
							`${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} role cleared — auto-selection applies`,
						);
						// Clearing either persisted scope can also remove a captured
						// runtime override. When that changes the effective default,
						// resolve the newly exposed persisted layer and switch the live
						// session without writing it back to global settings. Overlay
						// and runtime provenance remain authoritative and session-neutral.
						if (role === "default") {
							const fallbackRoleValue = this.ctx.settings.getModelRole("default");
							const fallbackProvenance = this.ctx.settings.getModelRoleProvenance("default");
							const exposesPersistedFallback =
								fallbackProvenance === "project" || fallbackProvenance === "global";
							if (
								fallbackRoleValue &&
								fallbackRoleValue !== previousEffectiveRoleValue &&
								exposesPersistedFallback
							) {
								const scopedModels = this.ctx.session.scopedModels.map(sm => sm.model);
								const availableModels =
									scopedModels.length > 0 ? scopedModels : this.ctx.session.getAvailableModels();
								const resolved = resolveModelRoleValue(fallbackRoleValue, availableModels, {
									settings: this.ctx.settings,
								});
								if (resolved.model) {
									const fallbackModel = resolved.model;
									const isAuto = resolved.thinkingLevel === AUTO_THINKING;
									let concreteThinking = concreteThinkingLevel(resolved.thinkingLevel);
									let isAutoFromDefault = false;
									if (!resolved.explicitThinkingLevel && !concreteThinking) {
										const defaultLevel = parseConfiguredThinkingLevel(
											this.ctx.settings.get("defaultThinkingLevel"),
										);
										if (defaultLevel === AUTO_THINKING) {
											isAutoFromDefault = true;
										} else if (defaultLevel) {
											concreteThinking = defaultLevel;
										}
									}
									const effectiveIsAuto = isAuto || isAutoFromDefault;
									const { switched } = await this.ctx.session.setModel(fallbackModel, "default", {
										persist: false,
										thinkingLevel: effectiveIsAuto
											? ThinkingLevel.Inherit
											: (concreteThinking ?? ThinkingLevel.Inherit),
									});
									if (!switched) return;
									if (effectiveIsAuto) {
										this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
									} else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
										this.ctx.session.setThinkingLevel(concreteThinking);
									}
									this.ctx.statusLine.invalidate();
									this.ctx.updateEditorBorderColor();
								}
							}
						}
						return true;
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
						return false;
					} finally {
						releaseDefaultMutation?.();
						hub?.refreshAfterExternalMutation();
					}
				},
				onFallbackChainChange: hubOptions.roleCallbacks
					? undefined
					: (role, chain) => {
							try {
								const chains = { ...this.ctx.settings.get("retry.fallbackChains") };
								if (chain.length === 0) {
									delete chains[role];
								} else {
									chains[role] = chain;
								}
								this.ctx.settings.set("retry.fallbackChains", chains);
								const roleInfo = getRoleInfo(role, settings);
								this.ctx.showStatus(
									chain.length > 0
										? `${roleInfo?.tag ?? roleInfo?.name ?? role} fallbacks: ${chain.join(" → ")}`
										: `${roleInfo?.tag ?? roleInfo?.name ?? role} fallbacks cleared`,
								);
							} catch (error) {
								this.ctx.showError(error instanceof Error ? error.message : String(error));
							}
						},

				onLoginRequest: hubOptions.initialAssignRole
					? undefined
					: providerId => {
							if (hubOptions.onDone) {
								if (!closeOverlay()) return;
								void this.#loginThenReopenModelHub(providerId, hubOptions);
							} else {
								done();
								void this.#loginThenReopenModelHub(providerId);
							}
						},
				onCycleOrderChange: hubOptions.roleCallbacks
					? undefined
					: order => {
							try {
								this.ctx.settings.set("cycleOrder", order);
								this.ctx.showStatus(
									order.length > 0 ? `Quick-switch cycle: ${order.join(" → ")}` : "Quick-switch cycle cleared",
								);
							} catch (error) {
								this.ctx.showError(error instanceof Error ? error.message : String(error));
							}
						},
				onCancel: () => done(),
			},
			{
				initialProviderId: hubOptions.initialProviderId,
				initialAssignRole: hubOptions.initialAssignRole,
			},
		);
		const overlayHandle = this.#showFullscreenMenu(hub);
		hubOptions.setClose?.(done);
		return done;
	}

	/** /login round-trip for a locked provider; reopen the hub on that provider only after a successful login. */
	async #loginThenReopenModelHub(
		providerId: string,
		hostOptions?: Pick<ModelHubHostOptions, "isCancelled" | "onDone" | "setClose">,
	): Promise<void> {
		const succeeded = await this.#handleOAuthLogin(providerId);
		if (hostOptions?.isCancelled?.()) return;
		if (succeeded) {
			this.#showModelHub({ initialProviderId: providerId, ...hostOptions });
		} else {
			hostOptions?.onDone?.();
		}
	}

	async showPluginSelector(mode: "install" | "uninstall" = "install"): Promise<void> {
		const mgr = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const [marketplaces, installed] = await Promise.all([mgr.listMarketplaces(), mgr.listInstalledPlugins()]);
		const installedIds = new Set(installed.map(p => p.id));

		if (mode === "uninstall") {
			// Show only installed plugins for uninstall
			const items = installed.map(p => {
				const entry = p.entries[0];
				const atIdx = p.id.lastIndexOf("@");
				const pluginName = atIdx > 0 ? p.id.slice(0, atIdx) : p.id;
				const mkt = atIdx > 0 ? p.id.slice(atIdx + 1) : "unknown";
				return {
					plugin: { name: pluginName, version: entry?.version, description: undefined as string | undefined },
					marketplace: mkt,
					scope: p.scope,
				};
			});
			this.showSelector(done => {
				const selector = new PluginSelectorComponent(marketplaces.length, items, new Set(), {
					onSelect: async (name, marketplace, scope) => {
						done();
						const pluginId = `${name}@${marketplace}`;
						this.ctx.showStatus(`Uninstalling ${pluginId}...`);
						this.ctx.ui.requestRender();
						try {
							await mgr.uninstallPlugin(pluginId, scope);
							this.ctx.showStatus(`Uninstalled ${pluginId}`);
						} catch (err) {
							this.ctx.showStatus(`Uninstall failed: ${err}`);
						}
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						this.ctx.ui.requestRender();
					},
				});
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		// Install mode: show all available plugins from all marketplaces
		const allPlugins: Array<{
			plugin: { name: string; version?: string; description?: string };
			marketplace: string;
		}> = [];
		for (const mkt of marketplaces) {
			const plugins = await mgr.listAvailablePlugins(mkt.name);
			for (const plugin of plugins) {
				allPlugins.push({ plugin, marketplace: mkt.name });
			}
		}

		this.showSelector(done => {
			const selector = new PluginSelectorComponent(marketplaces.length, allPlugins, installedIds, {
				onSelect: async (name, marketplace) => {
					done();
					this.ctx.showStatus(`Installing ${name} from ${marketplace}...`);
					this.ctx.ui.requestRender();
					try {
						const force = installedIds.has(`${name}@${marketplace}`);
						await mgr.installPlugin(name, marketplace, { force });
						this.ctx.showStatus(`Installed ${name} from ${marketplace}`);
					} catch (err) {
						this.ctx.showStatus(`Install failed: ${err}`);
					}
					this.ctx.ui.requestRender();
				},
				onCancel: () => {
					done();
					this.ctx.ui.requestRender();
				},
			});
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	showUserMessageSelector(): void {
		const entries = this.ctx.sessionManager.getBranch().filter(isTranscriptEntry);
		if (entries.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		const done = () => {
			overlayHandle?.hide();
			selector?.dispose();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new RewindSelectorComponent(entries, {
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			isBuiltInTool: name => this.ctx.session.hasBuiltInTool(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			linkTargets: getAssistantMessageLinkTargets(this.ctx),
			requestRender: () => this.ctx.ui.requestRender(),
			siblingPaths: entryId => this.#siblingBranchPaths(entryId),
			onSelect: entryId => void this.#rewindFromTranscript(entryId, done),
			onCancel: done,
		});
		if (selector.targetCount === 0) {
			selector.dispose();
			this.ctx.showStatus("No messages to branch from");
			return;
		}
		// Fullscreen alternate-screen overlay: the transcript replica draws over
		// the live one, and the normal screen stays untouched until the rewind
		// itself rewrites it.
		const overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	/**
	 * Alternate branches of `entryId`'s turn for the rewind selector's strip:
	 * every other child of its parent, each unrolled along its most-recent
	 * descendants (children are timestamp-ordered, so the last child chain is
	 * the branch's latest continuation) and filtered to message entries.
	 */
	#siblingBranchPaths(entryId: string): BranchVariantPath[] {
		const entry = this.ctx.sessionManager.getEntry(entryId);
		if (!entry) return [];
		const forest = this.ctx.sessionManager.getTree();
		const byId = new Map<string, SessionTreeNode>();
		const stack = [...forest];
		while (stack.length > 0) {
			const node = stack.pop()!;
			byId.set(node.entry.id, node);
			stack.push(...node.children);
		}
		const siblings =
			entry.parentId === null
				? forest.filter(node => node.entry.id !== entryId)
				: (byId.get(entry.parentId)?.children ?? []).filter(node => node.entry.id !== entryId);
		const paths: BranchVariantPath[] = [];
		for (const sibling of siblings) {
			const entries: TranscriptEntry[] = [];
			let node: SessionTreeNode | undefined = sibling;
			while (node) {
				if (isTranscriptEntry(node.entry)) entries.push(node.entry);
				node = node.children.at(-1);
			}
			if (entries.length > 0) paths.push({ rootId: sibling.entry.id, entries });
		}
		return paths;
	}

	/**
	 * Complete an esc-esc rewind in place via `navigateTree`: the session tree
	 * keeps the old path as a sibling branch instead of forking a child
	 * session. A user-request target (plain prompt, user-invoked skill/collab
	 * prompt) rewinds PAST itself (leaf moves to its parent) and its draft
	 * replaces the editor text, so it is a real move even when it is the
	 * current leaf; every other target lands the leaf on the entry. `done`
	 * closes the fullscreen selector after the transcript is rebuilt so the
	 * alternate screen never flashes a stale transcript.
	 */
	async #rewindFromTranscript(entryId: string, done: () => void): Promise<void> {
		const entry = this.ctx.sessionManager.getEntry(entryId);
		if (!entry || !isTranscriptEntry(entry)) {
			done();
			return;
		}

		const isUserTarget = isUserRequestEntry(entry);
		const realLeafId = this.ctx.sessionManager.getLeafId();
		if (entryId === realLeafId && !isUserTarget) {
			done();
			this.ctx.showStatus("Already at this point");
			return;
		}
		const treeRewind = this.#treeRewindBoundary(entryId, realLeafId);
		try {
			const result = await this.ctx.session.navigateTree(entryId, { summarize: false });
			if (result.cancelled) {
				done();
				this.ctx.showStatus("Navigation cancelled");
				return;
			}
			const fastRewind =
				treeRewind !== undefined &&
				this.ctx.sessionManager.getLeafId() === treeRewind.expectedLeafId &&
				this.ctx.truncateTranscriptFromMessage(treeRewind.message);
			if (!fastRewind) {
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
			}
			await this.ctx.reloadTodos();
			if (result.editorText && (isUserTarget || !this.ctx.editor.getText().trim())) {
				this.ctx.editor.setDraft(result.editorText, result.editorImages);
			}
			done();
			this.ctx.showStatus("Rewound to selected point");
		} catch (error) {
			done();
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	showCopySelector(): void {
		const entries = this.ctx.sessionManager.getBranch().filter(isTranscriptEntry);
		if (entries.length === 0) {
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}

		const done = () => {
			overlayHandle?.hide();
			selector?.dispose();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new CopySelectorComponent(entries, {
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			isBuiltInTool: name => this.ctx.session.hasBuiltInTool(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			linkTargets: getAssistantMessageLinkTargets(this.ctx),
			requestRender: () => this.ctx.ui.requestRender(),
			onPick: (content, label) => {
				done();
				if (!content.trim()) {
					this.ctx.showStatus("Nothing to copy in that item");
					return;
				}
				void copyToClipboard(content);
				this.ctx.showStatus(`Copied ${label} to clipboard`);
			},
			onOpen: (href, label) => {
				done();
				openPath(href);
				this.ctx.showStatus(`Opening ${label}: ${href}`);
			},
			onCancel: done,
		});
		if (selector.targetCount === 0) {
			selector.dispose();
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}
		const overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async (entryId, options) => {
					// Selecting the current leaf is normally a no-op (already there) —
					// unless it's an `ask` toolResult, in which case the re-answer flow
					// must still be allowed to reopen the picker even though the leaf
					// doesn't move (chatgpt-codex review on #5895).
					if (entryId === realLeafId) {
						const currentEntry = this.ctx.sessionManager.getEntry(entryId);
						const currentIsAskResult =
							currentEntry?.type === "message" &&
							currentEntry.message.role === "toolResult" &&
							currentEntry.message.toolName === "ask";
						if (!currentIsAskResult) {
							done();
							this.ctx.showStatus("Already at this point");
							return;
						}
					}

					// Ask about summarization
					done(); // Close selector first

					// Pure-rewind probe (before navigation mutates the leaf): when the
					// target sits on the current leaf's path and no summary is added,
					// the post-navigation transcript is a strict prefix of the rendered
					// one and the tail can be dropped in place.
					const treeRewind = this.#treeRewindBoundary(entryId, realLeafId);

					// Loop until user makes a complete choice or cancels to tree.
					// Shift+Enter in the tree selector pre-answers "Summarize" and
					// skips the prompt entirely.
					let wantsSummary = options.summarize;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (!wantsSummary && branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						let result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
							allowAskReopen: true,
						});

						// Selecting an `ask` toolResult doesn't land the leaf directly —
						// re-open the picker with the original questions first, then
						// complete the navigation as a new sibling branch (issue #5642).
						if (result.reopenAsk) {
							const reanswer = await this.#reanswerAsk(result.reopenAsk.questions);
							if (!reanswer) {
								this.ctx.showStatus("Re-answer cancelled");
								return;
							}
							result = await this.ctx.session.navigateTree(entryId, {
								summarize: wantsSummary,
								customInstructions,
								allowAskReopen: true,
								reanswerAskResult: reanswer,
							});
						}

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						// Update UI — rebuild the display transcript for the new leaf (the
						// context from navigateTree is the LLM context, not the transcript).
						const fastRewind =
							treeRewind !== undefined &&
							!wantsSummary &&
							!result.summaryEntry &&
							!result.askReanswerCommitted &&
							this.ctx.sessionManager.getLeafId() === treeRewind.expectedLeafId &&
							this.ctx.truncateTranscriptFromMessage(treeRewind.message);
						if (!fastRewind) {
							await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
						}
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setDraft(result.editorText, result.editorImages);
						}
						this.ctx.showStatus("Navigated to selected point");

						// Re-answering a past `ask` commits a new sibling answer but,
						// unlike a live `ask`, leaves the agent idle. Resume it now —
						// after the transcript rebuild above — so the model consumes the
						// new answer without the resumed turn rendering against the stale
						// pre-rebuild UI (issue #6483).
						if (result.askReanswerCommitted) {
							this.ctx.session.resumeAfterAskReanswer();
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.disposeChildren();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * First rendered message a pure tree rewind drops, plus the leaf id the
	 * navigation is expected to land on. `targetId` must sit on the current
	 * leaf's path; a user-request target rewinds PAST itself (navigateTree
	 * moves the leaf to its parent and hands the draft back to the editor),
	 * every other target keeps the target as the new leaf. Returns undefined
	 * when the navigation is not a pure rewind or the boundary entry cannot
	 * anchor an in-place truncation (non-message boundary; custom messages
	 * render unkeyed components, so a skill/collab target takes the replay).
	 */
	#treeRewindBoundary(
		targetId: string,
		leafId: string | null,
	): { message: AgentMessage; expectedLeafId: string } | undefined {
		if (!leafId) return undefined;
		const target = this.ctx.sessionManager.getEntry(targetId);
		if (!target) return undefined;
		const rewindsPastTarget = isUserRequestEntry(target);
		if (!rewindsPastTarget && target.type === "custom_message") return undefined;
		// Walk leaf → root: proves the target is on the current path and finds
		// the first entry the rewind drops.
		let firstDropped: SessionEntry | undefined;
		let cursor = this.ctx.sessionManager.getEntry(leafId);
		while (cursor && cursor.id !== targetId) {
			firstDropped = cursor;
			cursor = cursor.parentId ? this.ctx.sessionManager.getEntry(cursor.parentId) : undefined;
		}
		if (!cursor) return undefined;
		const boundary = rewindsPastTarget ? target : firstDropped;
		if (boundary?.type !== "message") return undefined;
		// A root rewind (expected leaf null) empties the transcript but may leave
		// components rendered before the first message stale — take the
		// destructive replay instead.
		const expectedLeafId = rewindsPastTarget ? target.parentId : targetId;
		if (expectedLeafId === null) return undefined;
		return {
			message: boundary.message,
			expectedLeafId,
		};
	}

	/**
	 * Re-open the `ask` picker with the original `questions` (issue #5642):
	 * runs a standalone `AskTool.execute()` outside a normal agent turn,
	 * reusing the same picker/dialog primitives a live `ask` tool call gets.
	 * Returns `undefined` when the user cancels — mirrors `navigateTree`'s
	 * cancellation contract instead of throwing.
	 */
	async #reanswerAsk(questions: AskToolInput["questions"]): Promise<AgentToolResult<AskToolDetails> | undefined> {
		const uiContext = this.ctx.getToolUIContext();
		if (!uiContext) {
			this.ctx.showError("Ask tool UI is not ready");
			return undefined;
		}
		const toolSession: ToolSession = {
			cwd: this.ctx.sessionManager.getCwd(),
			hasUI: true,
			settings: this.ctx.settings,
			getSessionFile: () => this.ctx.sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			getPlanModeState: () => this.ctx.session.getPlanModeState(),
		};
		const askTool = new AskTool(toolSession);
		const context = this.ctx.session.buildAskReanswerContext(uiContext);
		let result: AgentToolResult<AskToolDetails>;
		try {
			result = await askTool.execute("tree-reanswer", { questions }, undefined, undefined, context);
		} catch (error) {
			if (error instanceof ToolAbortError) return undefined;
			throw error;
		}
		// The rich ask dialog can race a collab guest choosing "Chat about this"
		// (`AskTool`'s `chatRedirect` result); that's meaningful inside a live
		// agent turn, where the model sees the redirect and starts a
		// conversation, but this standalone re-answer has no turn to hand it
		// to — completing the navigation with it would silently drop the
		// user's intent to chat (roboomp review on #5895).
		if (result.details?.chatRedirect) {
			this.ctx.showError(
				"Chat about this isn't available when re-answering from the tree — pick an option or type a custom answer instead.",
			);
			return undefined;
		}
		return result;
	}

	async showSessionSelector(source?: ForeignSessionSource): Promise<void> {
		let sessions: SessionInfo[];
		let onSelectSession: (session: SessionInfo) => Promise<boolean>;
		let selectorOptions: SessionSelectorOptions<SessionInfo>;

		if (source) {
			const sourceName = foreignSessionSourceName(source);
			const store = createForeignSessionStore(source);
			let foreignSessions: ForeignSessionInfo[];
			try {
				foreignSessions = await store.list();
			} catch (error) {
				this.ctx.showError(
					`Failed to list ${sourceName} sessions: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			if (foreignSessions.length === 0) {
				this.ctx.showWarning(`No ${sourceName} sessions found`);
				return;
			}
			const foreignByPath = new Map(foreignSessions.map(session => [session.path, session]));
			sessions = foreignSessions.map(foreignSessionInfoToSessionInfo);
			onSelectSession = async session => {
				try {
					await this.ctx.settings.flush();
				} catch (error) {
					this.ctx.showError(
						`Failed to save pending settings: ${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				}
				const foreignSession = foreignByPath.get(session.path);
				if (!foreignSession) throw new Error(`Selected ${sourceName} session is no longer available`);
				const imported = await persistForeignSession(store, foreignSession, {
					fallbackCwd: this.ctx.sessionManager.getCwd(),
					suppressBreadcrumb: true,
				});
				const sessionFile = imported.getSessionFile();
				if (!sessionFile) throw new Error(`Failed to persist ${sourceName} session`);
				await imported.close();
				return await this.handleResumeSession(sessionFile, { settingsFlushed: true });
			};
			selectorOptions = {
				title: `Import ${sourceName} Session`,
				scopeLabel: false,
				showCwd: true,
			};
		} else {
			const [loadedSessions, pinnedIds] = await Promise.all([
				SessionManager.listForPicker(this.ctx.sessionManager.getCwd(), this.ctx.sessionManager.getSessionDir()),
				loadPinnedSessionIds(),
			]);
			sessions = loadedSessions;
			const historyStorage = this.ctx.historyStorage;
			const historyMatcher = historyStorage
				? (query: string) => historyStorage.matchingSessionIds(query)
				: undefined;
			onSelectSession = session => this.handleResumeSession(session.path);
			selectorOptions = {
				onDelete: async (session: SessionInfo) => {
					if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
						return false;
					}
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(session.path);
						return true;
					} catch (error) {
						throw new Error(
							`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						);
					}
				},
				historyMatcher,
				loadAllSessions: () => SessionManager.listAllForPicker(),
				pinnedIds,
				// Live getter so detach/newSession stays accurate; tolerant of partial
				// contexts and in-memory sessions (undefined file means no marker).
				currentSessionPath: () => this.ctx.sessionManager.getSessionFile?.() ?? undefined,
			};
		}

		// Keep the fullscreen picker on the alternate buffer while a selected
		// session is loaded and its transcript is rebuilt.
		const done = () => {
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new SessionSelectorComponent(
			sessions,
			async (session: SessionInfo) => {
				selector.lockInput();
				let keepOpen = false;
				try {
					const success = await onSelectSession(session);
					if (!success) {
						keepOpen = true;
						selector.unlockInput();
						this.ctx.ui.requestRender();
					}
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (!keepOpen) done();
				}
			},
			done,
			() => {
				// Release the alt buffer before teardown: shutdown() awaits flush/save/
				// dispose/drain before stop() leaves the alt screen.
				done();
				void this.ctx.shutdown();
			},
			{
				...selectorOptions,
				getTerminalRows: () => this.ctx.ui.terminal.rows,
				fillHeight: true,
			},
		);
		selector.setOnRequestRender(() => this.ctx.ui.requestRender());
		const overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		await this.ctx.prepareSessionSwitch();
		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.ctx.resetObserverRegistry();
		this.#refreshSessionTerminalTitle();

		this.ctx.clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.ui.requestRender();
		this.ctx.updateEditorBorderColor();
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async handleResumeSession(sessionPath: string, options?: { settingsFlushed?: boolean }): Promise<boolean> {
		const previousCwd = this.ctx.sessionManager.getCwd();
		// Flush pending settings writes before switching sessions so a save
		// failure leaves the session, process project dir, and Settings in the
		// source scope.
		if (!options?.settingsFlushed) {
			try {
				await this.ctx.settings.flush();
			} catch (err) {
				this.ctx.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
		}
		await this.ctx.prepareSessionSwitch();
		this.ctx.resetObserverRegistry();
		// AgentSession owns the transaction. It restores the complete source state
		// if applying the target project's cwd fails, including in-memory sessions.
		if (
			(await this.ctx.session.switchSession(sessionPath, {
				onCwdChange: async (newCwd, sourceCwd) => {
					if (normalizePathForComparison(newCwd) === normalizePathForComparison(sourceCwd)) return true;
					return this.ctx.applyCwdChange(newCwd);
				},
			})) === false
		) {
			return false;
		}
		this.ctx.clearTransientSessionUi();
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.showStatus(movedProject ? `Resumed session in ${shortenPath(newCwd)}` : "Resumed session");
		return true;
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}

	/**
	 * Run the OAuth login flow for `providerId` inside a cancellable
	 * {@link LoginDialogComponent} that replaces the editor slot. Esc aborts:
	 * the dialog's abort signal reaches the provider flow, any pending prompt
	 * rejects, and the editor is restored immediately. Returns true when
	 * credentials were stored.
	 */
	async #handleOAuthLogin(providerId: string): Promise<boolean> {
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const { LoginDialogComponent, PASTE_CODE_LOGIN_PROVIDERS } = loadProviderAuthUi();
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		let restored = false;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		const dialog = new LoginDialogComponent(
			this.ctx.ui,
			providerId,
			(_success, message) => {
				// Fires on Esc: unblock the editor immediately; the aborted flow's
				// rejection settles the awaited login below.
				restoreEditor();
				if (message) this.ctx.showStatus(message);
			},
			openPath,
		);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(dialog);
		this.ctx.ui.setFocus(dialog);
		this.ctx.ui.requestRender();
		try {
			const identity = await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onBrowserSession: captureBrowserSession,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					// The dialog renders the full URL (SSH-safe copy target) and
					// opens the browser best-effort.
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
				},
				onPrompt: prompt => dialog.showPrompt(prompt),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},
				// Paste-code providers (e.g. Codex) may need the user to paste the
				// fallback redirect URL when the loopback callback can't complete
				// (headless/remote/Windows). Mount a focused input in the dialog so
				// the paste lands somewhere the OAuth flow consumes — the hidden
				// editor's `/login <url>` path is unreachable while the dialog holds
				// focus (#5339).
				onManualCodeInput: useManualInput
					? signal => dialog.showManualInput(MANUAL_LOGIN_PROMPT, signal)
					: undefined,
			});
			// Scope the post-login refresh to the just-authenticated provider with an
			// `online` strategy: the default all-provider `online-if-uncached` reuses
			// a fresh authoritative cache row (e.g. an empty result fetched before
			// login), so newly persisted credentials would never re-run discovery and
			// models would stay unavailable in-session (#5780). Unrelated providers
			// are left untouched. `refreshProvider` swallows discovery failures, so
			// awaiting cannot reject the login.
			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const block = new TranscriptBlock();
			// Name the account (and Anthropic organization) that was stored so a
			// login that lands on an unintended account/subscription is visible
			// immediately instead of silently replacing an existing registration.
			const whoBase = identity?.type === "oauth" ? (identity.email ?? identity.accountId) : undefined;
			const whoOrg = identity?.type === "oauth" ? (identity.orgName ?? identity.orgId) : undefined;
			const who = whoBase ? ` as ${whoBase}${whoOrg ? ` (${whoOrg})` : ""}` : whoOrg ? ` as ${whoOrg}` : "";
			block.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}${who}`),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0));
			this.ctx.present(block);
			return true;
		} catch (error: unknown) {
			if (dialog.signal.aborted) {
				// User-cancelled: the dialog already restored the editor and
				// surfaced "Login cancelled".
				return false;
			}
			this.ctx.showError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			restoreEditor();
		}
	}

	async #handleCredentialLogout(providerId: string, account: LogoutAccount): Promise<void> {
		try {
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.removeCredential(providerId, account.credentialId);
			if (!removed) {
				this.ctx.showError(`Logout skipped: ${account.label} is no longer stored for ${providerId}.`);
				return;
			}

			// Provider-scoped online refresh so the removed credential's stale
			// endpoint/deployment models are invalidated deterministically; the
			// default all-provider `online-if-uncached` would reuse the fresh
			// authoritative cache row and keep showing models the credential
			// unlocked (#5780). Other providers are left untouched.
			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg(
						"success",
						`${theme.status.success} Successfully logged out ${account.label} from ${providerId}`,
					),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credential removed from ${getAgentDbPath()}`), 1, 0));
			const remainingSource = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			if (remainingSource) {
				block.addChild(
					new Text(theme.fg("warning", `${providerId} is still authenticated via ${remainingSource}`), 1, 0),
				);
			}
			this.ctx.present(block);
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #showOAuthLogoutAccountSelector(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.reload();
		} catch (error: unknown) {
			this.ctx.showError(
				`Could not load stored credentials: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const { getOAuthProviders, LogoutAccountSelectorComponent } = loadProviderAuthUi();
		const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
		const accounts = toLogoutAccounts(providerId, authStorage.listStoredCredentials(providerId), {
			activeIdentity: authStorage.getOAuthAccountIdentity(providerId, this.ctx.session.sessionId),
			activeApiKey: authStorage.getCredentialOrigin(providerId)?.kind === "api_key",
		});
		if (accounts.length === 0) {
			const source = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
			this.ctx.showError(`Logout skipped: no stored credentials for ${providerId}.${suffix}`);
			return;
		}

		this.showSelector(done => {
			const selector = new LogoutAccountSelectorComponent(
				provider?.name ?? providerId,
				accounts,
				account => {
					done();
					void this.#handleCredentialLogout(providerId, account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		if (providerId) {
			if (mode === "login") {
				await this.#handleOAuthLogin(providerId);
			} else {
				await this.#showOAuthLogoutAccountSelector(providerId);
			}
			return;
		}

		const { getOAuthProviders, OAuthSelectorComponent } = loadProviderAuthUi();
		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.has(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No stored provider credentials to log out. Remove env or config auth at its source.");
				return;
			}
		}

		this.showSelector(done => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.ctx.session.modelRegistry.authStorage,
				async (selectedProviderId: string) => {
					selector.stopValidation();
					done();
					if (mode === "login") {
						await this.#handleOAuthLogin(selectedProviderId);
					} else {
						await this.#showOAuthLogoutAccountSelector(selectedProviderId);
					}
				},
				() => {
					selector.stopValidation();
					done();
					this.ctx.ui.requestRender();
				},
				{
					disabledProviders: settings.get("disabledProviders"),
					validateAuth: async (selectedProviderId: string) => {
						const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
							selectedProviderId,
							this.ctx.session.sessionId,
						);
						return !!apiKey;
					},
					requestRender: () => {
						this.ctx.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showSessionPinSelector(): Promise<void> {
		const session = this.ctx.session;
		if (session.isStreaming) {
			this.ctx.showStatus("Cannot pin an account while the session is streaming.");
			return;
		}
		this.ctx.showStatus("Loading provider accounts…", { dim: true });
		let accountList: SessionOAuthAccountList | undefined;
		try {
			accountList = await session.listCurrentProviderOAuthAccounts();
		} catch (error) {
			this.ctx.showError(
				`Could not load provider accounts: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (!accountList) {
			this.ctx.showStatus("Select a model before pinning a provider account.");
			return;
		}
		const { getOAuthProviders } = loadProviderAuthUi();
		const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
		const providerName = provider?.name ?? accountList.provider;
		const accounts = toSessionPinAccounts(accountList.accounts);
		if (accounts.length === 0) {
			const source = session.modelRegistry.authStorage.describeCredentialSource(
				accountList.provider,
				session.sessionId,
			);
			this.ctx.showStatus(
				source
					? `No stored OAuth accounts for ${providerName}. Current auth comes from ${source}.`
					: `No stored OAuth accounts for ${providerName}. Use /login to add one.`,
			);
			return;
		}

		this.showSelector(done => {
			const selector = new SessionAccountSelectorComponent(
				providerName,
				accounts,
				account => {
					done();
					if (!session.pinCurrentProviderOAuthAccount(account.credentialId)) {
						this.ctx.showWarning(`${account.label} is no longer available to pin.`);
						return;
					}
					this.ctx.showStatus(`Pinned ${account.label} to this session for ${providerName}.`);
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showResetUsageSelector(): Promise<void> {
		const session = this.ctx.session;
		this.ctx.showStatus("Checking saved rate-limit resets…", { dim: true });
		let statuses: ResetCreditAccountStatus[];
		try {
			statuses = await session.listResetCredits();
		} catch (error) {
			this.ctx.showError(
				sanitizeText(
					`Could not load saved resets: ${error instanceof Error ? error.message : String(error)}`.replace(
						/[\r\n\t]+/g,
						" ",
					),
				),
			);
			return;
		}
		const accounts = toResetUsageAccounts(statuses);
		if (accounts.length === 0) {
			this.ctx.showStatus("No provider accounts found. Use /login to add one.");
			return;
		}
		if (!accounts.some(account => account.availableCount > 0)) {
			this.ctx.showStatus(
				accounts.some(account => account.error)
					? "No saved resets available — some accounts couldn't be reached (try /login)."
					: "No saved rate-limit resets available to spend right now.",
			);
			return;
		}
		this.showSelector(done => {
			const selector = new ResetUsageSelectorComponent(
				accounts,
				account => {
					done();
					void this.#redeemReset(account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async #redeemReset(account: ResetUsageAccount): Promise<void> {
		this.ctx.showStatus(
			`Spending 1 saved reset for ${sanitizeText(account.label.replace(/[\r\n\t]+/g, " "))} (${account.providerLabel})…`,
			{ dim: true },
		);
		let outcome: ResetCreditRedeemOutcome;
		try {
			outcome = await this.ctx.session.redeemResetCredit(account.target);
		} catch (error) {
			this.ctx.showError(
				sanitizeText(
					`Reset failed for ${account.label}: ${error instanceof Error ? error.message : String(error)}`.replace(
						/[\r\n\t]+/g,
						" ",
					),
				),
			);
			return;
		}
		const message = sanitizeText(describeRedeemOutcome(outcome, account.label).replace(/[\r\n\t]+/g, " "));
		if (outcome.ok) {
			this.ctx.showStatus(message);
			// Refresh the status-line usage so the freshly-reset window shows.
			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		} else {
			this.ctx.showWarning(message);
		}
	}

	async showDebugSelector(): Promise<void> {
		const { DebugSelectorComponent } = await import("../../debug");
		this.showSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}

	showAgentHub(observers: SessionObserverRegistry, options?: AgentHubOpenOptions): void {
		const hubKeys = [
			...this.ctx.keybindings.getKeys("app.agents.hub"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		];
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;

		const done = () => {
			if (closed) return;
			closed = true;
			hub.dispose();
			overlayHandle?.hide();
			// A gated empty Hub may never have been mounted. Restoring editor
			// focus in that case would steal focus from a menu opened meanwhile.
			if (overlayHandle) this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};

		const hub = new AgentHubOverlayComponent({
			...createAgentHubRuntime({
				settings: this.ctx.settings,
				registry: this.ctx.collabGuest?.agentRegistry,
				remote: this.ctx.collabGuest?.hubRemote,
				sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
			}),
			observers,
			hubKeys,
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			initialSection: options?.initialSection,
			onDone: done,
			requestRender: () => this.ctx.ui.requestRender(),
			remote: this.ctx.collabGuest?.hubRemote,
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			isBuiltInTool: name => this.ctx.session.hasBuiltInTool(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			focusAgent: id => this.ctx.focusAgentSession(id),
			sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
		});

		const showReadyHub = () => {
			if (closed) return;
			// The double-← gesture stays inert when neither live nor persisted
			// subagents are available, so wait for discovery before making the gate.
			if (options?.requireContent && hub.isEmpty) {
				done();
				return;
			}

			// Prime the detector before the first frame when the editor's double-←
			// gesture opened the hub, so the next single ← dismisses it.
			if (options?.armCloseTap) hub.armCloseTap();
			overlayHandle = this.#showFullscreenMenu(hub);
		};

		if (options?.requireContent && hub.isEmpty) {
			void hub.persistedSubagentsReady.then(showReadyHub);
		} else {
			showReadyHub();
		}
	}
}
