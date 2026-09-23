import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { projectModelSelectorImport } from "./role-sharing";
import type { ModelRoleAssignments, ModelRoleImportRow, ProfileDraft } from "./types";

export type ProfileAssignmentIdentity =
	| { kind: "role"; role: string }
	| { kind: "agent"; agent: string; fallbackIndex: number | null };

/** Stable key for controller selections and replacement maps. */
export function profileAssignmentKey(identity: ProfileAssignmentIdentity): string {
	return identity.kind === "role"
		? `role:${JSON.stringify(identity.role)}`
		: `agent:${JSON.stringify(identity.agent)}:${identity.fallbackIndex}`;
}

export interface ProfileAssignmentCompatibility extends Omit<ModelRoleImportRow, "role"> {
	identity: ProfileAssignmentIdentity;
}

export type ProfileAgentCompatibilityIssue =
	| { kind: "missing"; message: string }
	| { kind: "disabled"; message: string };

export interface ProfileAgentCompatibility {
	status: "available" | "disabled" | "missing";
	agent: string;
	hasModelOverride: boolean;
	listedDisabled: boolean;
	issues: ProfileAgentCompatibilityIssue[];
}

export interface ProfileCompatibilityReview {
	assignments: ProfileAssignmentCompatibility[];
	agents: ProfileAgentCompatibility[];
}

type AgentModelOverride = string | string[] | null;
type ProfileTaskConfig = {
	disabledAgents?: string[];
	agentModelOverrides?: Record<string, AgentModelOverride>;
	[key: string]: unknown;
};
function taskConfig(draft: ProfileDraft): ProfileTaskConfig | undefined {
	const task = draft.config.task;
	return task && typeof task === "object" && !Array.isArray(task) ? (task as ProfileTaskConfig) : undefined;
}

/**
 * Project a complete profile draft against local model and agent facts.
 * This is a pure local review: it performs no discovery, refresh, credential read, or network request.
 */
export function projectProfileCompatibility(
	draft: ProfileDraft,
	recipientSettings: Settings,
	modelRegistry: ModelRegistry,
	knownAgentNames: ReadonlySet<string>,
): ProfileCompatibilityReview {
	const proposedRoles = draft.config.modelRoles as ModelRoleAssignments;
	const assignments: ProfileAssignmentCompatibility[] = Object.entries(proposedRoles).map(([role, selector]) => ({
		identity: { kind: "role" as const, role },
		...projectModelSelectorImport(selector, proposedRoles, recipientSettings, modelRegistry, role),
	}));
	const task = taskConfig(draft);
	const overrides = task?.agentModelOverrides;
	if (overrides) {
		for (const [agent, configured] of Object.entries(overrides)) {
			if (Array.isArray(configured)) {
				for (const [fallbackIndex, selector] of configured.entries()) {
					assignments.push({
						identity: { kind: "agent", agent, fallbackIndex },
						...projectModelSelectorImport(selector, proposedRoles, recipientSettings, modelRegistry),
					});
				}
			} else {
				assignments.push({
					identity: { kind: "agent", agent, fallbackIndex: null },
					...projectModelSelectorImport(configured, proposedRoles, recipientSettings, modelRegistry),
				});
			}
		}
	}
	const disabledAgents = task?.disabledAgents ?? [];
	const agentNames = new Set<string>(overrides ? Object.keys(overrides) : []);
	for (const agent of disabledAgents) agentNames.add(agent);
	const disabled = new Set(disabledAgents);
	const agents: ProfileAgentCompatibility[] = [...agentNames].map(agent => {
		const issues: ProfileAgentCompatibilityIssue[] = [];
		if (!knownAgentNames.has(agent)) {
			issues.push({ kind: "missing", message: "The agent definition is not available in this workspace." });
		}
		if (disabled.has(agent)) {
			issues.push({ kind: "disabled", message: "The profile disables this agent." });
		}
		const status: ProfileAgentCompatibility["status"] = !knownAgentNames.has(agent)
			? "missing"
			: disabled.has(agent)
				? "disabled"
				: "available";
		return {
			status,
			agent,
			hasModelOverride: overrides ? Object.hasOwn(overrides, agent) : false,
			listedDisabled: disabled.has(agent),
			issues,
		};
	});

	return { assignments, agents };
}

/** Replace one reviewed selector; selecting Automatic for an agent makes its whole override explicitly null. */
export function replaceProfileAssignment(
	draft: ProfileDraft,
	identity: ProfileAssignmentIdentity,
	selector: string | null,
): ProfileDraft {
	if (identity.kind === "role") {
		const roles = draft.config.modelRoles as ModelRoleAssignments;
		if (!Object.hasOwn(roles, identity.role)) throw new Error("Profile assignment is no longer available");
		return {
			...draft,
			config: {
				...draft.config,
				modelRoles: { ...roles, [identity.role]: selector },
			},
		};
	}

	const task = taskConfig(draft);
	const overrides = task?.agentModelOverrides;
	if (!task || !overrides || !Object.hasOwn(overrides, identity.agent)) {
		throw new Error("Profile assignment is no longer available");
	}
	const configured = overrides[identity.agent];
	let replacement: AgentModelOverride;
	if (Array.isArray(configured)) {
		if (
			identity.fallbackIndex === null ||
			identity.fallbackIndex < 0 ||
			identity.fallbackIndex >= configured.length
		) {
			throw new Error("Profile assignment is no longer available");
		}
		if (selector === null) {
			replacement = null;
		} else {
			replacement = [...configured];
			replacement[identity.fallbackIndex] = selector;
		}
	} else {
		if (identity.fallbackIndex !== null) throw new Error("Profile assignment is no longer available");
		replacement = selector;
	}

	return {
		...draft,
		config: {
			...draft.config,
			task: {
				...task,
				agentModelOverrides: { ...overrides, [identity.agent]: replacement },
			},
		},
	};
}

/** Explicitly discard all task settings owned by an unavailable agent name. */
export function removeUnavailableProfileAgent(draft: ProfileDraft, agent: string): ProfileDraft {
	const task = taskConfig(draft);
	if (!task) return draft;
	const overrides = task.agentModelOverrides;
	const hasOverride = overrides ? Object.hasOwn(overrides, agent) : false;
	const disabledAgents = task.disabledAgents;
	const listedDisabled = disabledAgents?.includes(agent) ?? false;
	if (!hasOverride && !listedDisabled) return draft;

	let nextOverrides = overrides;
	if (hasOverride && overrides) {
		nextOverrides = Object.fromEntries(Object.entries(overrides).filter(([name]) => name !== agent));
	}
	return {
		...draft,
		config: {
			...draft.config,
			task: {
				...task,
				...(overrides ? { agentModelOverrides: nextOverrides } : {}),
				...(disabledAgents ? { disabledAgents: disabledAgents.filter(name => name !== agent) } : {}),
			},
		},
	};
}
