import type { ModelBrowserPerf } from "@oh-my-pi/pi-tui/overlays/model-browser";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ProfileUsageSnapshot } from "../cli/usage-cli";
import type { RawSettings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";
export type { ProfileUsageSnapshot };

export type ModelRoleAssignments = Record<string, string | null>;
export const PROFILE_EMOJIS = [
	{ emoji: "💻", label: "Coding" },
	{ emoji: "⚡", label: "Fast" },
	{ emoji: "🪙", label: "Budget" },
	{ emoji: "💸", label: "Premium" },
	{ emoji: "🖥️", label: "Local" },
	{ emoji: "🧠", label: "Thinking" },
	{ emoji: "🔍", label: "Review" },
	{ emoji: "🐛", label: "Debug" },
	{ emoji: "🧪", label: "Experiment" },
	{ emoji: "📚", label: "Research" },
	{ emoji: "📝", label: "Docs" },
	{ emoji: "🔒", label: "Security" },
	{ emoji: "🚀", label: "Release" },
	{ emoji: "🌐", label: "Web" },
	{ emoji: "🎨", label: "Design" },
	{ emoji: "🗄️", label: "Database" },
	{ emoji: "☁️", label: "Cloud" },
	{ emoji: "📋", label: "Planning" },
	{ emoji: "✅", label: "Testing" },
	{ emoji: "🤖", label: "Automation" },
	{ emoji: "🔧", label: "Refactor" },
	{ emoji: "🏗️", label: "Architecture" },
	{ emoji: "📊", label: "Analytics" },
	{ emoji: "📱", label: "Mobile" },
	{ emoji: "🎮", label: "Games" },
	{ emoji: "💬", label: "Chat" },
	{ emoji: "🧩", label: "Extensions" },
	{ emoji: "🎯", label: "Focus" },
	{ emoji: "⭐", label: "Favorite" },
] as const;

export type ProfileEmoji = (typeof PROFILE_EMOJIS)[number]["emoji"];

export type ProfileSettingsGroup =
	| "model"
	| "appearance"
	| "interaction"
	| "context"
	| "memory"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "providers";

export interface ProfileSettingsGroupMetadata {
	id: ProfileSettingsGroup;
	label: string;
	tab: ProfileSettingsGroup;
	description: string;
}

export const PROFILE_SETTINGS_GROUPS: readonly ProfileSettingsGroupMetadata[] = [
	{ id: "model", label: "Model options", tab: "model", description: "Sampling, thinking, prompts, and retries" },
	{ id: "appearance", label: "Appearance", tab: "appearance", description: "Theme and terminal presentation" },
	{ id: "interaction", label: "Interaction", tab: "interaction", description: "Input and session behavior" },
	{ id: "context", label: "Context", tab: "context", description: "Compaction and context management" },
	{ id: "memory", label: "Memory", tab: "memory", description: "Portable memory behavior, not stored memories" },
	{ id: "files", label: "Files", tab: "files", description: "File handling behavior" },
	{ id: "shell", label: "Shell", tab: "shell", description: "Portable shell behavior, not executable paths" },
	{ id: "tools", label: "Tools", tab: "tools", description: "Tool behavior and output limits" },
	{ id: "tasks", label: "Agents & tasks", tab: "tasks", description: "Task behavior and agent assignments" },
	{ id: "providers", label: "Provider settings", tab: "providers", description: "Portable provider behavior only" },
];

export interface SetupMetadata {
	version: 1;
	emoji?: ProfileEmoji;
	enabledGroups: ProfileSettingsGroup[];
}

export interface ProfileDraft {
	metadata: SetupMetadata;
	/** Native settings overlay. Reserved `$setup` metadata is never included here. */
	config: RawSettings;
}

export interface ModelRoleImportRow {
	role: string;
	selector: string | null;
	status: "ready" | "automatic" | "provider-missing" | "credentials-missing" | "model-missing" | "needs-review";
	provider?: string;
	modelId?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	message?: string;
}

export interface ProfileDescriptor {
	name: string;
	active: boolean;
}

export interface ProfileRoleRow {
	role: string;
	selector?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Catalog intelligence score. */
	int?: number;
	/** Catalog-estimated output speed in tokens per second. */
	tps?: number;
	/** Resolved context window in tokens. */
	contextWindow?: number;
	/** Locally measured throughput and latency for this exact provider/model pair. */
	perf?: ModelBrowserPerf;
	/** Resolved token rates in USD per million tokens; not account or subscription billing. */
	cost?: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	automatic: boolean;
	warning?: string;
}

export interface ProfileAgentRow {
	name: string;
	enabled: boolean;
	source: string;
	selector?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	warning?: string;
}

export interface ProfileSettingRow {
	path: SettingPath;
	label: string;
	value: boolean | number | string | null;
	hidden: boolean;
	configured: boolean;
}

export interface ProfileSnapshot {
	profile: string;
	generatedAt: number;
	agentDir: string;
	credentialSources: Record<string, string>;
	roles: ProfileRoleRow[];
	agents: ProfileAgentRow[];
	memory: { backend: string; scope?: string; storageLabel: string };
	settings: ProfileSettingRow[];
	usage?: ProfileUsageSnapshot;
	warnings: string[];
}

export interface ProfileInspectRequest {
	cwd: string;
	usage: boolean;
	/** Saved setup name within the target profile; never an arbitrary config path. */
	setup?: string;
}

export type ProfileInspectResponse = { ok: true; snapshot: ProfileSnapshot } | { ok: false; message: string };
