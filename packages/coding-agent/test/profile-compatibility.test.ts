import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	profileAssignmentKey,
	projectProfileCompatibility,
	removeUnavailableProfileAgent,
	replaceProfileAssignment,
	type ProfileAssignmentCompatibility,
} from "../src/profiles/profile-compatibility";
import type { ProfileDraft } from "../src/profiles/types";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function draft(config: ProfileDraft["config"]): ProfileDraft {
	return { metadata: { version: 1, enabledGroups: ["tasks"] }, config };
}

function assignmentByKey(
	assignments: ProfileAssignmentCompatibility[],
	key: string,
): ProfileAssignmentCompatibility | undefined {
	return assignments.find(row => profileAssignmentKey(row.identity) === key);
}

describe("full profile compatibility", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-profile-compatibility-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("keeps role and fallback assignment keys disjoint for controller replacement maps", () => {
		const identities = [
			{ kind: "role", role: "same" },
			{ kind: "role", role: 'agent:"same":0' },
			{ kind: "agent", agent: "same", fallbackIndex: null },
			{ kind: "agent", agent: "same", fallbackIndex: 0 },
			{ kind: "agent", agent: "same", fallbackIndex: 1 },
			{ kind: "agent", agent: 'same":0', fallbackIndex: 0 },
		] as const;
		const keys = identities.map(profileAssignmentKey);

		expect(new Set(keys).size).toBe(identities.length);
	});

	it("projects role and ordered agent-fallback assignments through the same local policy", () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			const settings = Settings.isolated({
				modelRoles: { recipientOnly: "anthropic/claude-sonnet-4-5" },
			});
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const profile = draft({
				modelRoles: {
					default: "anthropic/claude-sonnet-4-5",
					automatic: null,
					pending: "anthropic/definitely-not-a-real-model",
					recipientLeak: "@recipientOnly",
				},
				task: {
					disabledAgents: [],
					agentModelOverrides: {
						task: ["@default:high", "openai/gpt-4o-mini", "not-installed/example-model", "@recipientOnly"],
						reviewer: null,
					},
				},
			});
			const before = structuredClone(profile);

			const review = projectProfileCompatibility(profile, settings, registry, new Set(["task", "reviewer"]));

			expect(review.assignments.map(row => row.identity)).toEqual([
				{ kind: "role", role: "default" },
				{ kind: "role", role: "automatic" },
				{ kind: "role", role: "pending" },
				{ kind: "role", role: "recipientLeak" },
				{ kind: "agent", agent: "task", fallbackIndex: 0 },
				{ kind: "agent", agent: "task", fallbackIndex: 1 },
				{ kind: "agent", agent: "task", fallbackIndex: 2 },
				{ kind: "agent", agent: "task", fallbackIndex: 3 },
				{ kind: "agent", agent: "reviewer", fallbackIndex: null },
			]);
			expect(assignmentByKey(review.assignments, 'role:"default"')).toMatchObject({
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(assignmentByKey(review.assignments, 'role:"automatic"')).toMatchObject({
				selector: null,
				status: "automatic",
			});
			expect(assignmentByKey(review.assignments, 'role:"pending"')).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("discovery"),
			});
			expect(assignmentByKey(review.assignments, 'role:"recipientLeak"')).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("unknown model role"),
			});
			expect(assignmentByKey(review.assignments, 'agent:"task":0')).toMatchObject({
				selector: "@default:high",
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(assignmentByKey(review.assignments, 'agent:"task":1')?.status).toBe("credentials-missing");
			expect(assignmentByKey(review.assignments, 'agent:"task":2')?.status).toBe("provider-missing");
			expect(assignmentByKey(review.assignments, 'agent:"task":3')).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("unknown model role"),
			});
			expect(assignmentByKey(review.assignments, 'agent:"reviewer":null')).toMatchObject({
				selector: null,
				status: "automatic",
			});
			expect(profile).toEqual(before);
		} finally {
			authStorage.close();
		}
	});

	it("uses role-kind pools while keeping imported agent selectors chat-only", () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			authStorage.setRuntimeApiKey("openai", "fixture-key");
			const settings = Settings.isolated();
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const profile = draft({
				modelRoles: {
					default: "anthropic/claude-sonnet-4-5",
					smol: null,
					inherited: "@smol",
					image: "openai/chatgpt-image-latest",
				},
				task: {
					agentModelOverrides: {
						task: "@smol",
						"image-agent": "@image",
					},
				},
			});

			const review = projectProfileCompatibility(profile, settings, registry, new Set(["task", "image-agent"]));

			expect(assignmentByKey(review.assignments, 'role:"image"')).toMatchObject({
				status: "ready",
				provider: "openai",
				modelId: "chatgpt-image-latest",
			});
			expect(assignmentByKey(review.assignments, 'role:"inherited"')).toMatchObject({
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(assignmentByKey(review.assignments, 'agent:"task":null')).toMatchObject({
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(assignmentByKey(review.assignments, 'agent:"image-agent":null')?.status).not.toBe("ready");
		} finally {
			authStorage.close();
		}
	});

	it("reports missing and disabled agent names and removes them only on explicit request", () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			const settings = Settings.isolated();
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const profile = draft({
				modelRoles: { default: null },
				task: {
					disabledAgents: ["reviewer", "ghost", "disabled-only"],
					agentModelOverrides: {
						ghost: "anthropic/claude-sonnet-4-5",
						reviewer: null,
					},
					maxConcurrency: 7,
				},
			});

			const review = projectProfileCompatibility(profile, settings, registry, new Set(["task", "reviewer"]));
			expect(
				review.agents.map(row => ({
					agent: row.agent,
					status: row.status,
					hasModelOverride: row.hasModelOverride,
					listedDisabled: row.listedDisabled,
					issues: row.issues.map(issue => issue.kind),
				})),
			).toEqual([
				{
					agent: "ghost",
					status: "missing",
					hasModelOverride: true,
					listedDisabled: true,
					issues: ["missing", "disabled"],
				},
				{
					agent: "reviewer",
					status: "disabled",
					hasModelOverride: true,
					listedDisabled: true,
					issues: ["disabled"],
				},
				{
					agent: "disabled-only",
					status: "missing",
					hasModelOverride: false,
					listedDisabled: true,
					issues: ["missing", "disabled"],
				},
			]);

			const withoutGhost = removeUnavailableProfileAgent(profile, "ghost");
			expect(withoutGhost.config).toEqual({
				modelRoles: { default: null },
				task: {
					disabledAgents: ["reviewer", "disabled-only"],
					agentModelOverrides: { reviewer: null },
					maxConcurrency: 7,
				},
			});
			expect(profile.config).toMatchObject({
				task: {
					disabledAgents: ["reviewer", "ghost", "disabled-only"],
					agentModelOverrides: { ghost: "anthropic/claude-sonnet-4-5", reviewer: null },
				},
			});
		} finally {
			authStorage.close();
		}
	});

	it("replaces one assignment without reordering fallbacks and preserves explicit Automatic nulls", () => {
		const profile = draft({
			modelRoles: { default: null, reviewer: "@default" },
			task: {
				disabledAgents: [],
				agentModelOverrides: {
					task: ["first/model", "second/model", "third/model"],
					reviewer: null,
					scalar: "original/model",
				},
				maxConcurrency: 3,
			},
		});

		const roleReplaced = replaceProfileAssignment(profile, { kind: "role", role: "reviewer" }, "@default:high");
		expect(roleReplaced.config).toMatchObject({
			modelRoles: { default: null, reviewer: "@default:high" },
		});
		const fallbackReplaced = replaceProfileAssignment(
			profile,
			{ kind: "agent", agent: "task", fallbackIndex: 1 },
			"replacement/model",
		);
		expect(fallbackReplaced.config).toMatchObject({
			task: {
				agentModelOverrides: {
					task: ["first/model", "replacement/model", "third/model"],
					reviewer: null,
					scalar: "original/model",
				},
				maxConcurrency: 3,
			},
		});
		const nullReplaced = replaceProfileAssignment(
			profile,
			{ kind: "agent", agent: "reviewer", fallbackIndex: null },
			"replacement/model",
		);
		expect(nullReplaced.config).toMatchObject({
			task: { agentModelOverrides: { reviewer: "replacement/model" } },
		});
		const scalarMadeAutomatic = replaceProfileAssignment(
			profile,
			{ kind: "agent", agent: "scalar", fallbackIndex: null },
			null,
		);
		expect(scalarMadeAutomatic.config).toMatchObject({
			task: { agentModelOverrides: { scalar: null } },
		});
		const fallbackMadeAutomatic = replaceProfileAssignment(
			profile,
			{ kind: "agent", agent: "task", fallbackIndex: 1 },
			null,
		);
		expect(fallbackMadeAutomatic.config).toMatchObject({
			task: { agentModelOverrides: { task: null } },
		});
		expect(profile.config).toMatchObject({
			modelRoles: { default: null, reviewer: "@default" },
			task: { agentModelOverrides: { task: ["first/model", "second/model", "third/model"] } },
		});
	});
});
