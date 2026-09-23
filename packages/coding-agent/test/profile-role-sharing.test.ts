import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	parseModelRoles,
	projectModelRoleImport,
	projectModelSelectorImport,
	readModelRolesFile,
	serializeModelRoles,
	writeModelRolesFile,
} from "../src/profiles/role-sharing";
import type { ModelRoleAssignments, ModelRoleImportRow } from "../src/profiles/types";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("portable model-role sharing", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-profile-role-sharing-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("round-trips only the strict portable schema while preserving selector semantics", () => {
		const expectedRoles: ModelRoleAssignments = {
			default: "@slow:high,openai/gpt-5.4:auto",
			smol: null,
			literal: "nanogpt/coding-router:max",
		};
		const content = serializeModelRoles(expectedRoles);
		const parsedRoot = YAML.parse(content) as Record<string, unknown>;
		expect(parsedRoot).toEqual({
			format: "omp-model-roles",
			version: 1,
			modelRoles: expectedRoles,
		});
		expect(parseModelRoles(content)).toEqual(expectedRoles);
	});

	it("rejects malformed, unsupported, extra-field, prototype, and oversized artifacts safely", async () => {
		const invalidArtifacts = [
			'format: omp-model-roles\nversion: 1\nmodelRoles:\n  default: "unterminated secret',
			"format: omp-model-roles\nversion: 2\nmodelRoles: {}\n",
			"format: omp-model-roles\nversion: 1\nmodelRoles: {}\ntask: {}\n",
			"format: omp-model-roles\nversion: 1\nmodelRoles:\n  __proto__: openai/gpt-5.4\n",
		];
		for (const artifact of invalidArtifacts) {
			try {
				parseModelRoles(artifact);
				expect.unreachable("expected strict artifact rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("Model roles file is invalid");
				expect((error as Error).message).not.toContain("secret");
			}
		}

		const oversizedPath = tempDir.join("oversized.yml");
		await Bun.write(oversizedPath, "x".repeat(1024 * 1024 + 1));
		await expect(readModelRolesFile(oversizedPath)).rejects.toThrow("Model roles file is too large");
	});

	it("creates exports without clobbering an existing path", async () => {
		const artifactPath = tempDir.join("roles.yml");
		await writeModelRolesFile(artifactPath, { default: "openai/gpt-5.4:auto", smol: null });
		expect(await readModelRolesFile(artifactPath)).toEqual({
			default: "openai/gpt-5.4:auto",
			smol: null,
		});

		const firstBytes = await Bun.file(artifactPath).text();
		await expect(writeModelRolesFile(artifactPath, { default: "must/not-replace" })).rejects.toThrow(
			"A file already exists at the selected path",
		);
		expect(await Bun.file(artifactPath).text()).toBe(firstBytes);
		expect((await fs.readdir(tempDir.path())).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("projects compatibility from local facts without mutating recipient roles", () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			authStorage.setRuntimeApiKey("openai-codex", "fixture-key");
			const settings = Settings.isolated({ modelRoles: { recipient: "anthropic/claude-sonnet-4-5" } });
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const before = { ...settings.getModelRoles() };
			const projected = projectModelRoleImport(
				{
					default: "anthropic/claude-sonnet-4-5",
					alias: "@default:high",
					automatic: null,
					credentials: "openai/gpt-4o-mini",
					provider: "not-installed/example-model",
					model: "openai-codex/definitely-not-a-real-model",
					pendingModel: "anthropic/definitely-not-a-real-model",
					unsupportedThinking: "openai/gpt-4o-mini:high",
					cycleA: "@cycleB",
					cycleB: "@cycleA",
					invalidReference: "@absent-role",
					badAliasThinking: "@default:turbo",
				},
				settings,
				registry,
			);
			const byRole = Object.fromEntries(projected.map(row => [row.role, row])) as Record<string, ModelRoleImportRow>;

			expect(byRole.default).toMatchObject({
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(byRole.alias).toMatchObject({
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(byRole.automatic).toEqual({ role: "automatic", selector: null, status: "automatic" });
			expect(byRole.credentials.status).toBe("credentials-missing");
			expect(byRole.provider.status).toBe("provider-missing");
			expect(byRole.model.status).toBe("model-missing");
			expect(byRole.pendingModel).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("discovery"),
			});
			expect(byRole.unsupportedThinking.status).toBe("needs-review");
			expect(byRole.cycleA).toMatchObject({ status: "needs-review", message: expect.stringContaining("cycle") });
			expect(byRole.cycleB).toMatchObject({ status: "needs-review", message: expect.stringContaining("cycle") });
			expect(byRole.invalidReference).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("unknown model role"),
			});
			expect(byRole.badAliasThinking).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("unsupported thinking"),
			});
			expect(settings.getModelRoles()).toEqual(before);
		} finally {
			authStorage.close();
		}
	});

	it("projects agent selectors against proposed roles without recipient-only alias fallback", () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			const settings = Settings.isolated({ modelRoles: { recipientOnly: "anthropic/claude-sonnet-4-5" } });
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const proposed = {
				default: "anthropic/claude-sonnet-4-5",
				cycleA: "@cycleB",
				cycleB: "@cycleA",
			};

			expect(projectModelSelectorImport("@default:high", proposed, settings, registry)).toMatchObject({
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(projectModelSelectorImport("@recipientOnly", proposed, settings, registry)).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("unknown model role"),
			});
			expect(projectModelSelectorImport("@cycleA", proposed, settings, registry)).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("cycle"),
			});
			expect(projectModelSelectorImport(null, proposed, settings, registry)).toEqual({
				selector: null,
				status: "automatic",
			});
		} finally {
			authStorage.close();
		}
	});

	it("projects canonical non-chat role kinds, including keyless local runners", () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("openai", "fixture-key");
			const settings = Settings.isolated();
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const projected = projectModelRoleImport(
				{
					image: "openai/chatgpt-image-latest",
					speech: "local/kokoro",
					dictation: "local/whisper-base",
					tiny: "local/falcon-h1-90m",
				},
				settings,
				registry,
			);
			const byRole = Object.fromEntries(projected.map(row => [row.role, row])) as Record<string, ModelRoleImportRow>;

			expect(byRole.image).toMatchObject({
				status: "ready",
				provider: "openai",
				modelId: "chatgpt-image-latest",
			});
			expect(byRole.speech).toMatchObject({ status: "ready", provider: "local", modelId: "kokoro" });
			expect(byRole.dictation).toMatchObject({ status: "ready", provider: "local", modelId: "whisper-base" });
			expect(byRole.tiny).toMatchObject({ status: "ready", provider: "local", modelId: "falcon-h1-90m" });

			const [wrongKind] = projectModelRoleImport({ image: "anthropic/claude-sonnet-4-5" }, settings, registry);
			expect(wrongKind).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("does not support this model role"),
			});
		} finally {
			authStorage.close();
		}
	});

	it("round-trips explicit-null builtin aliases for role and agent import while rejecting custom null aliases", () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			const settings = Settings.isolated();
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const imported = parseModelRoles(
				serializeModelRoles({
					default: "anthropic/claude-sonnet-4-5",
					smol: null,
					inherited: "@smol",
				}),
			);
			const inherited = projectModelRoleImport(imported, settings, registry).find(row => row.role === "inherited");

			expect(inherited).toMatchObject({
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(projectModelSelectorImport("@smol", imported, settings, registry)).toMatchObject({
				status: "ready",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(
				projectModelSelectorImport("@customAutomatic", { ...imported, customAutomatic: null }, settings, registry),
			).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("unknown model role"),
			});
			expect(projectModelSelectorImport("@smol,@missing", imported, settings, registry)).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("unknown model role"),
			});
		} finally {
			authStorage.close();
		}
	});

	it("bounds duplicate alias expansion before model resolution", () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "fixture-key");
			const settings = Settings.isolated();
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
			const roles: ModelRoleAssignments = { r0: "anthropic/claude-sonnet-4-5" };
			for (let depth = 1; depth <= 16; depth++) {
				roles[`r${depth}`] = `@r${depth - 1},@r${depth - 1}`;
			}

			expect(projectModelSelectorImport("@r16", roles, settings, registry)).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("supported model-role limit"),
			});
			const automaticFallback = { ...roles, default: "@r16", smol: null, inherited: "@smol" };
			expect(projectModelSelectorImport("@smol", automaticFallback, settings, registry)).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("supported model-role limit"),
			});
			expect(
				projectModelRoleImport(automaticFallback, settings, registry).find(row => row.role === "inherited"),
			).toMatchObject({
				status: "needs-review",
				message: expect.stringContaining("supported model-role limit"),
			});
		} finally {
			authStorage.close();
		}
	});
});
