import {
	type Component,
	padding,
	parseSgrMouse,
	replaceTabs,
	routeSelectListMouse,
	SelectList,
	type SelectItem,
	type SettingItem,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { bottomBorder, divider, row, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import {
	SettingsSelectorComponent,
	type SettingsRuntimeContext,
	type SettingsSelectorSection,
} from "@oh-my-pi/pi-tui/overlays/settings-selector";
import type { ModelRegistry } from "../../config/model-registry";
import { type RawSettings, type Settings } from "../../config/settings";
import { createSettingsHost } from "../../config/settings-ui";
import type { SettingPath } from "../../config/settings-schema";
import { getProfileGroupPaths, setProfileDraftGroup } from "../../profiles/setups";
import {
	PROFILE_EMOJIS,
	PROFILE_SETTINGS_GROUPS,
	type ProfileDraft,
	type ProfileEmoji,
	type ProfileSettingsGroup,
} from "../../profiles/types";

const EMOJI_SLOT_WIDTH = 2;
const PORTABLE_SETTINGS_NOTICE =
	"Portable settings only; credentials, endpoints and machine paths stay local. Service availability unverified.";

type ProfileEditorSectionItem = SettingsSelectorSection["items"][number];

function cleanImportedLine(value: unknown): string {
	return replaceTabs(sanitizeText(String(value ?? "")))
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
export type ProfileEditorRuntimeContext = Partial<Omit<SettingsRuntimeContext, "settings" | "plugins">>;

export interface ProfileEmojiPickerOptions {
	value?: ProfileEmoji;
	name?: string;
	terminalHeight?: number;
	saveImmediately?: boolean;
	onSelect(value: ProfileEmoji | undefined): void;
	onCancel(): void;
	requestRender(): void;
}

/** Curated emoji picker. It never accepts arbitrary Unicode input. */
export class ProfileEmojiPicker implements Component {
	readonly #list: SelectList;
	readonly #options: ProfileEmojiPickerOptions;
	#selectedValue: string;
	#error: string | undefined;
	#contentStart = 2;

	constructor(options: ProfileEmojiPickerOptions) {
		this.#options = options;
		const items: SelectItem[] = [
			{ value: "", label: "None", description: "Remove the profile emoji" },
			...PROFILE_EMOJIS.map(item => ({
				value: item.emoji,
				icon: item.emoji,
				label: item.label,
			})),
		];
		this.#list = new SelectList(items, Math.min(items.length, 14), getSelectListTheme(), {
			search: "never",
			// Labels lead because terminals with older emoji-width tables can
			// disagree with Bun about a glyph's cell count (notably newer and
			// VS16 emoji). Their width can then affect only the trailing icon,
			// never the label column.
			iconPosition: "after",
			iconGap: 2,
			maxPrimaryColumnWidth: 14, // 12-cell "Architecture" plus SelectList's primary-column gap
		});
		this.#selectedValue = options.value ?? "";
		this.#list.setSelectedValue(this.#selectedValue);
		this.#list.onSelectionChange = item => {
			this.#selectedValue = item.value;
			this.#error = undefined;
			this.#options.requestRender();
		};
		this.#list.onSelect = item => this.#options.onSelect(item.value ? (item.value as ProfileEmoji) : undefined);
		this.#list.onCancel = this.#options.onCancel;
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	setError(error: string): void {
		this.#error = error;
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, this.#options.terminalHeight ?? process.stdout.rows ?? 24);
		const innerWidth = Math.max(1, width - 4);
		const contentRows = Math.max(1, height - 6 - (this.#error ? 1 : 0));
		this.#list.setMaxVisible(contentRows);
		const listLines = this.#list.render(innerWidth);
		const selected = PROFILE_EMOJIS.find(item => item.emoji === this.#selectedValue);
		const previewEmoji = selected?.emoji ?? padding(EMOJI_SLOT_WIDTH);
		const previewName = cleanImportedLine(this.#options.name ?? "Profile");
		const preview = `${previewEmoji}${padding(Math.max(0, EMOJI_SLOT_WIDTH - visibleWidth(previewEmoji)))}  ${
			previewName || "Profile"
		} · ${selected?.label ?? "No emoji"}`;
		const notice = this.#options.saveImmediately
			? "Choosing saves this profile emoji immediately"
			: "Curated labels only";
		const lines = [topBorder(width, "Profile emoji"), row(theme.fg("dim", notice), width)];
		if (this.#error) lines.push(row(theme.fg("error", `${theme.status.error} ${this.#error}`), width));
		this.#contentStart = lines.length;
		for (let index = 0; index < contentRows; index++) lines.push(row(listLines[index] ?? "", width));
		lines.push(divider(width));
		const action = this.#options.saveImmediately
			? "Enter to save · Esc to cancel"
			: "Enter to choose · Esc to cancel";
		lines.push(row(`Preview  ${preview}  ${theme.fg("dim", action)}`, width));
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) routeSelectListMouse(this.#list, event, event.row - this.#contentStart);
			return;
		}
		this.#list.handleInput(data);
	}
}

export interface ProfileEditorCallbacks {
	requestRender(): void;
	onEditRole(role: string, draft: ProfileDraft): Promise<ProfileDraft | undefined>;
	onSave(draft: ProfileDraft, saveAsNew: boolean): void | Promise<void>;
	/** Resolve true after committing; false when the editor lifetime ended before it could update its draft. */
	onSaveEmoji?(value: ProfileEmoji | undefined): Promise<boolean>;
	onEditAgent(agent: string, draft: ProfileDraft): Promise<ProfileDraft | undefined>;
	onCancel(): void;
}

export interface ProfileEditorOptions {
	draft: ProfileDraft;
	effectiveSettings: Settings;
	/** Base/workspace/CLI settings without the selected profile overlay. */
	inheritedSettings?: Settings;
	registry?: ModelRegistry;
	name?: string;
	title?: string;
	saveLabel?: string;
	agentNames?: readonly string[];
	allowSaveAsNew?: boolean;
	initialGroup?: ProfileSettingsGroup;
	settingsContext?: ProfileEditorRuntimeContext;
	terminalHeight?: number;
	callbacks: ProfileEditorCallbacks;
}

function readConfiguredPath(config: RawSettings, path: SettingPath): { found: boolean; value: unknown } {
	let current: unknown = config;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) {
			return { found: false, value: undefined };
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return { found: true, value: current };
}

function writeConfiguredPath(config: RawSettings, path: SettingPath, value: unknown): void {
	const segments = path.split(".");
	let current = config;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index]!;
		const existing = current[segment];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[segment] = {};
		current = current[segment] as RawSettings;
	}
	current[segments.at(-1)!] = structuredClone(value);
}

function draftRoles(draft: ProfileDraft): Array<{ role: string; selector: string | null }> {
	const raw = draft.config.modelRoles;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	const roles: Array<{ role: string; selector: string | null }> = [];
	for (const [role, value] of Object.entries(raw)) {
		if (typeof value === "string" || value === null) roles.push({ role, selector: value });
	}
	return roles;
}

function draftAgents(
	draft: ProfileDraft,
	availableNames: readonly string[],
): Array<{ name: string; disabled: boolean; selector: string | string[] | null | undefined }> {
	const task = draft.config.task;
	const value = task && typeof task === "object" && !Array.isArray(task) ? (task as Record<string, unknown>) : {};
	const disabled = Array.isArray(value.disabledAgents)
		? value.disabledAgents.filter((name): name is string => typeof name === "string")
		: [];
	const overrides =
		value.agentModelOverrides &&
		typeof value.agentModelOverrides === "object" &&
		!Array.isArray(value.agentModelOverrides)
			? (value.agentModelOverrides as Record<string, unknown>)
			: {};
	const names = new Set([...availableNames, ...disabled, ...Object.keys(overrides)]);
	return [...names]
		.sort((a, b) => a.localeCompare(b))
		.map(name => {
			const selector = overrides[name];
			return {
				name,
				disabled: disabled.includes(name),
				selector:
					selector === null || typeof selector === "string" || Array.isArray(selector)
						? (selector as string | string[] | null)
						: undefined,
			};
		});
}

/**
 * Isolated editor for profile settings. Saved-profile emoji choices may be committed through its callbacks.
 */
export class ProfileEditorComponent implements Component {
	#draft: ProfileDraft;
	readonly #inheritedSettings: Settings;
	readonly #terminalHeight: number | undefined;
	readonly #name: string | undefined;
	readonly #saveLabel: string;
	readonly #allowSaveAsNew: boolean;
	readonly #agentNames: readonly string[];
	readonly #callbacks: ProfileEditorCallbacks;
	readonly #settingsHost: SettingsHost;
	readonly #selector: SettingsSelectorComponent;

	#nested: Component | undefined;
	#selectedId: string | undefined = "emoji";
	#pendingDisable: ProfileSettingsGroup | undefined;
	#busy = false;
	#error: string | undefined;

	constructor(options: ProfileEditorOptions) {
		this.#draft = structuredClone(options.draft);
		this.#inheritedSettings = options.inheritedSettings ?? options.effectiveSettings;
		this.#name = options.name;
		this.#saveLabel = options.saveLabel ?? "Save";
		this.#allowSaveAsNew = options.allowSaveAsNew ?? true;
		this.#agentNames = [...(options.agentNames ?? [])];
		this.#terminalHeight = options.terminalHeight;
		this.#callbacks = options.callbacks;

		const eligible = new Set<string>();
		for (const group of PROFILE_SETTINGS_GROUPS) {
			for (const path of getProfileGroupPaths(group.id)) eligible.add(path);
		}
		const fullHost = createSettingsHost({
			source: {
				get: path => {
					const configured = readConfiguredPath(this.#draft.config, path);
					return configured.found ? configured.value : this.#inheritedSettings.get(path);
				},
				set: (path, value) => writeConfiguredPath(this.#draft.config, path, value),
			},
		});
		this.#settingsHost = {
			...fullHost,
			entries: fullHost.entries.filter(entry => eligible.has(entry.path)),
		};
		const runtime: SettingsRuntimeContext = {
			settings: this.#settingsHost,
			availableThinkingLevels: options.settingsContext?.availableThinkingLevels ?? [],
			thinkingLevel: options.settingsContext?.thinkingLevel,
			availableThemes: options.settingsContext?.availableThemes ?? [],
			providers: options.settingsContext?.providers ?? [],
			model: options.settingsContext?.model,
			imageBudget: options.settingsContext?.imageBudget,
			composerPreviewStatus: options.settingsContext?.composerPreviewStatus,
			requestRender: this.#callbacks.requestRender,
		};
		const immediateEmojiNotice = this.#callbacks.onSaveEmoji
			? "Emoji choices save immediately; other changes remain draft-only."
			: "Draft only; changes do not affect the active session.";
		this.#selector = new SettingsSelectorComponent(
			runtime,
			{
				onChange: () => {
					this.#error = undefined;
					this.#callbacks.requestRender();
				},
				onSave: () => {
					void this.#save(false);
				},
				onSelectionChange: id => {
					if (id !== this.#selectedId) this.#pendingDisable = undefined;
					this.#selectedId = id;
					this.#callbacks.requestRender();
				},
				onCancel: this.#callbacks.onCancel,
			},
			{
				includePlugins: false,
				title: options.title ?? "Edit profile",
				terminalHeight: this.#terminalHeight,
				notice: `${immediateEmojiNotice} ${PORTABLE_SETTINGS_NOTICE}`,
				sections: () => this.#buildSections(),
			},
		);
		if (options.initialGroup) this.#selector.selectItem(`group:${options.initialGroup}`);
	}

	get draft(): ProfileDraft {
		return structuredClone(this.#draft);
	}

	invalidate(): void {
		this.#selector.invalidate();
		this.#nested?.invalidate?.();
	}

	render(width: number): readonly string[] {
		return (this.#nested ?? this.#selector).render(width);
	}

	handleInput(data: string): void {
		if (this.#busy) return;
		if (this.#nested) {
			this.#nested.handleInput?.(data);
			return;
		}
		const selectedId = this.#selectedId;
		if (
			data === " " &&
			!this.#selector.hasOpenSubmenu() &&
			selectedId?.startsWith("agent:") &&
			this.#draft.metadata.enabledGroups.includes("tasks")
		) {
			this.#toggleAgent(selectedId.slice("agent:".length));
			return;
		}
		this.#selector.handleInput(data);
	}

	#buildSections(): SettingsSelectorSection[] {
		const emoji = this.#draft.metadata.emoji;
		const emojiLabel = PROFILE_EMOJIS.find(item => item.emoji === emoji)?.label ?? "None";
		const sections: SettingsSelectorSection[] = [
			{
				id: "profile",
				label: "Profile",
				items: [
					{
						id: "emoji",
						label: "Emoji",
						currentValue: emoji ? `${emoji} ${emojiLabel}` : emojiLabel,
						description: this.#callbacks.onSaveEmoji
							? "Choose a curated emoji. This profile metadata change saves immediately."
							: "Choose a curated emoji for this profile draft.",
						onActivate: () => this.#openEmojiPicker(),
					},
				],
			},
		];
		const availablePaths = new Set(this.#settingsHost.entries.map(entry => entry.path));

		for (const group of PROFILE_SETTINGS_GROUPS) {
			const enabled = this.#draft.metadata.enabledGroups.includes(group.id);
			const paths = getProfileGroupPaths(group.id);
			const configuredCount = paths.reduce(
				(total, path) => total + (readConfiguredPath(this.#draft.config, path).found ? 1 : 0),
				0,
			);
			const items: ProfileEditorSectionItem[] = [];
			if (group.id === "model") {
				for (const { role, selector } of draftRoles(this.#draft)) {
					items.push({
						id: `role:${role}`,
						label: `Model role · ${cleanImportedLine(role)}`,
						currentValue: selector === null ? "Automatic" : cleanImportedLine(selector),
						description: "Edit this model role in the isolated profile draft.",
						onActivate: () => {
							void this.#editRole(role);
						},
					});
				}
			}
			items.push({
				id: `group:${group.id}`,
				label: `${group.label} inclusion`,
				currentValue: enabled ? "ON" : "OFF",
				description: enabled
					? `${group.description}. ${configuredCount} saved value${configuredCount === 1 ? "" : "s"}.`
					: `${group.description}. Uses inherited local configuration until included.`,
				warning:
					this.#pendingDisable === group.id
						? "Disabling removes saved values. Press Enter again to confirm."
						: undefined,
				onActivate: () => this.#toggleSelectedGroup(group.id),
			});
			for (const path of paths) {
				if (!availablePaths.has(path)) continue;
				items.push({
					setting: path,
					disabled: !enabled,
					descriptionSuffix: enabled
						? undefined
						: "Inherited from local configuration. Include this group to edit.",
				});
			}
			if (group.id === "tasks") {
				for (const agent of this.#draftAgentsForDisplay(enabled)) {
					const selector = Array.isArray(agent.selector)
						? agent.selector.map(cleanImportedLine).join(" → ")
						: agent.selector === null
							? "Automatic"
							: agent.selector === undefined
								? "No model override"
								: cleanImportedLine(agent.selector);
					items.push({
						id: `agent:${agent.name}`,
						label: `Agent · ${cleanImportedLine(agent.name)}`,
						currentValue: `${agent.disabled ? "Disabled" : "Enabled"} · ${selector}`,
						description: enabled
							? "Enter edits the model assignment; Space toggles availability in this draft."
							: "Inherited from local configuration. Include Agents & tasks to edit.",
						disabled: !enabled,
						onActivate: () => {
							void this.#editAgent(agent.name);
						},
					});
				}
			}
			sections.push({ id: group.id, label: group.label, items });
		}

		const actionItems: SettingItem[] = [];
		if (this.#error) {
			actionItems.push({
				id: "editor:error",
				label: "Last action failed",
				currentValue: "",
				description: this.#error,
				warning: this.#error,
				disabled: true,
			});
		}
		actionItems.push({
			id: "save",
			label: this.#saveLabel,
			currentValue: this.#busy ? "Working…" : "",
			description:
				this.#saveLabel === "Save" ? "Update this profile without activating it." : "Continue with this draft.",
			onActivate: () => {
				void this.#save(false);
			},
		});
		if (this.#allowSaveAsNew) {
			actionItems.push({
				id: "save-as-new",
				label: "Save as new",
				currentValue: "",
				description: "Create another profile without activating it.",
				onActivate: () => {
					void this.#save(true);
				},
			});
		}
		actionItems.push({
			id: "cancel",
			label: "Cancel",
			currentValue: "",
			description: "Discard this draft.",
			onActivate: this.#callbacks.onCancel,
		});
		sections.push({ id: "actions", label: "Actions", items: actionItems });
		return sections;
	}

	#draftAgentsForDisplay(enabled: boolean): Array<{
		name: string;
		disabled: boolean;
		selector: string | string[] | null | undefined;
	}> {
		if (enabled) return draftAgents(this.#draft, this.#agentNames);
		const inherited: ProfileDraft = {
			metadata: { version: 1, enabledGroups: [] },
			config: {
				task: {
					disabledAgents: structuredClone(this.#inheritedSettings.get("task.disabledAgents")),
					agentModelOverrides: structuredClone(this.#inheritedSettings.get("task.agentModelOverrides")),
				},
			},
		};
		return draftAgents(inherited, this.#agentNames);
	}

	#refresh(): void {
		this.#selector.refreshItems();
		this.#callbacks.requestRender();
	}

	#toggleSelectedGroup(group: ProfileSettingsGroup): void {
		const enabled = this.#draft.metadata.enabledGroups.includes(group);
		if (enabled && this.#pendingDisable !== group) {
			this.#pendingDisable = group;
			this.#refresh();
			return;
		}
		try {
			this.#draft = setProfileDraftGroup(this.#draft, group, !enabled, this.#inheritedSettings);
			this.#pendingDisable = undefined;
			this.#error = undefined;
		} catch (error) {
			this.#setError(error, "Unable to change profile group");
		}
		if (this.#error) this.#selector.clearSearch();
		this.#refresh();
		if (this.#error) this.#selector.selectItem("editor:error");
	}

	#toggleAgent(agent: string): void {
		const task =
			this.#draft.config.task &&
			typeof this.#draft.config.task === "object" &&
			!Array.isArray(this.#draft.config.task)
				? (this.#draft.config.task as RawSettings)
				: {};
		const disabled = Array.isArray(task.disabledAgents)
			? task.disabledAgents.filter((name): name is string => typeof name === "string")
			: [];
		task.disabledAgents = disabled.includes(agent) ? disabled.filter(name => name !== agent) : [...disabled, agent];
		this.#draft.config.task = task;
		this.#error = undefined;
		this.#refresh();
	}

	#openEmojiPicker(): void {
		const picker = new ProfileEmojiPicker({
			name: this.#name,
			value: this.#draft.metadata.emoji,
			terminalHeight: this.#terminalHeight,
			saveImmediately: this.#callbacks.onSaveEmoji !== undefined,
			requestRender: this.#callbacks.requestRender,
			onSelect: value => {
				if (this.#callbacks.onSaveEmoji) {
					void this.#saveEmoji(value, picker);
					return;
				}
				this.#setEmoji(value);
				this.#showMain();
			},
			onCancel: this.#callbacks.onCancel,
		});
		this.#nested = picker;
		this.#callbacks.requestRender();
	}

	#setEmoji(value: ProfileEmoji | undefined): void {
		this.#draft = {
			...this.#draft,
			metadata: { ...this.#draft.metadata, emoji: value },
		};
		this.#error = undefined;
	}

	async #saveEmoji(value: ProfileEmoji | undefined, picker: ProfileEmojiPicker): Promise<void> {
		const saveEmoji = this.#callbacks.onSaveEmoji;
		if (!saveEmoji || this.#busy) return;
		this.#busy = true;
		try {
			if (!(await saveEmoji(value))) return;
			this.#setEmoji(value);
			this.#showMain();
		} catch (error) {
			const message = cleanImportedLine(error instanceof Error ? error.message : error);
			picker.setError(message || "Failed to save profile emoji");
			this.#callbacks.requestRender();
		} finally {
			this.#busy = false;
			if (!this.#nested) this.#refresh();
		}
	}

	async #editRole(role: string): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			const next = await this.#callbacks.onEditRole(role, structuredClone(this.#draft));
			if (!next) {
				this.#callbacks.onCancel();
				return;
			}
			this.#draft = structuredClone(next);
			this.#error = undefined;
		} catch (error) {
			this.#setError(error, "Unable to edit model role");
		} finally {
			this.#busy = false;
			if (this.#error) this.#selector.clearSearch();
			this.#refresh();
			if (this.#error) this.#selector.selectItem("editor:error");
		}
	}

	async #editAgent(agent: string): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			const next = await this.#callbacks.onEditAgent(agent, structuredClone(this.#draft));
			if (!next) {
				this.#callbacks.onCancel();
				return;
			}
			this.#draft = structuredClone(next);
			this.#error = undefined;
		} catch (error) {
			this.#setError(error, "Unable to edit agent");
		} finally {
			this.#busy = false;
			if (this.#error) this.#selector.clearSearch();
			this.#refresh();
			if (this.#error) this.#selector.selectItem("editor:error");
		}
	}

	async #save(saveAsNew: boolean): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		this.#error = undefined;
		this.#refresh();
		try {
			await this.#callbacks.onSave(structuredClone(this.#draft), saveAsNew);
		} catch (error) {
			this.#setError(error, "Unable to save profile");
		} finally {
			this.#busy = false;
			if (this.#error) this.#selector.clearSearch();
			this.#refresh();
			if (this.#error) this.#selector.selectItem("editor:error");
		}
	}

	#setError(error: unknown, fallback: string): void {
		const message = cleanImportedLine(error instanceof Error ? error.message : error);
		this.#error = message || fallback;
	}

	#showMain(): void {
		this.#nested = undefined;
		this.#refresh();
	}
}
