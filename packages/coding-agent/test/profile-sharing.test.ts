import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	MAX_PROFILE_ARTIFACT_BYTES,
	parseProfile,
	parseProfileArtifact,
	readProfileArtifactFile,
	readProfileFile,
	serializeProfile,
	writeProfileFile,
} from "../src/profiles/profile-sharing";
import type { ProfileDraft } from "../src/profiles/types";

function portableDraft(): ProfileDraft {
	return {
		metadata: { version: 1, emoji: "🪙", enabledGroups: ["model", "context", "tasks"] },
		config: {
			modelRoles: {
				default: "@slow:medium,openai/gpt-5.4:low",
				smol: null,
				slow: "anthropic/claude-opus-4-5:high",
			},
			retry: { fallbackChains: { default: ["@slow:low", "openai/gpt-5.4-mini"] } },
			compaction: { enabled: false },
			task: {
				disabledAgents: ["sonic"],
				agentModelOverrides: { reviewer: ["@default:low", "openai/gpt-5.4"], scout: null },
			},
		},
	};
}

describe("portable full-profile sharing", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-profile-sharing-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("round-trips exact enabled ownership, structured selectors, emoji, and suggested name", () => {
		const content = serializeProfile(portableDraft(), "Budget development");
		const root = YAML.parse(content) as Record<string, unknown>;
		expect(root).toEqual({
			format: "omp-profile",
			version: 1,
			name: "Budget development",
			emoji: "🪙",
			includedGroups: ["model", "context", "tasks"],
			modelRoles: {
				default: "@slow:medium,openai/gpt-5.4:low",
				smol: null,
				slow: "anthropic/claude-opus-4-5:high",
			},
			settings: {
				retry: { fallbackChains: { default: ["@slow:low", "openai/gpt-5.4-mini"] } },
				compaction: { enabled: false },
				task: {
					disabledAgents: ["sonic"],
					agentModelOverrides: { reviewer: ["@default:low", "openai/gpt-5.4"], scout: null },
				},
			},
		});
		const parsed = parseProfile(content);
		expect(parsed.name).toBe("Budget development");
		expect(parsed.draft).toEqual(portableDraft());
	});

	it("imports legacy boolean Find modes, exports canonical modes, and rejects invalid modes", () => {
		const legacyArtifact = {
			format: "omp-profile",
			version: 1,
			includedGroups: ["tools"],
			modelRoles: {},
			settings: { find: { enabled: true } },
		};
		const imported = parseProfile(JSON.stringify(legacyArtifact));
		const exported = YAML.parse(serializeProfile(imported.draft)) as {
			settings: { find: { enabled: string } };
		};
		expect(exported.settings.find.enabled).toBe("on");

		const callerOwned: ProfileDraft = {
			metadata: { version: 1, enabledGroups: ["tools"] },
			config: { modelRoles: {}, find: { enabled: false } },
		};
		const callerExport = YAML.parse(serializeProfile(callerOwned)) as {
			settings: { find: { enabled: string } };
		};
		expect(callerExport.settings.find.enabled).toBe("off");
		expect(callerOwned.config).toEqual({ modelRoles: {}, find: { enabled: false } });

		const canonicalArtifact = {
			...legacyArtifact,
			settings: { find: { enabled: "auto" } },
		};
		expect(parseProfile(JSON.stringify(canonicalArtifact)).draft.config).toEqual({
			modelRoles: {},
			find: { enabled: "auto" },
		});

		const invalidArtifact = {
			...legacyArtifact,
			settings: { find: { enabled: "automatic" } },
		};
		expect(() => parseProfile(JSON.stringify(invalidArtifact))).toThrow("Profile file is invalid");
	});

	it("keeps models-only imports models-only and dispatches omp-model-roles v1 unchanged", () => {
		const full = parseProfile(
			"format: omp-profile\nversion: 1\nincludedGroups: []\nmodelRoles:\n  default: openai/gpt-5.4\nsettings: {}\n",
		);
		expect(full.draft.metadata.enabledGroups).toEqual([]);
		expect(full.draft.config).toEqual({ modelRoles: { default: "openai/gpt-5.4" } });

		const roles = parseProfileArtifact(
			"format: omp-model-roles\nversion: 1\nmodelRoles:\n  default: '@slow:high,openai/gpt-5.4:low'\n  smol: null\n",
		);
		expect(roles.format).toBe("omp-model-roles");
		expect(roles.draft.metadata.enabledGroups).toEqual([]);
		expect(roles.draft.config).toEqual({
			modelRoles: { default: "@slow:high,openai/gpt-5.4:low", smol: null },
		});
	});

	it("rejects contradictory groups, unknown fields, unsafe keys, and unsupported emoji without leaking input", () => {
		const invalidArtifacts = [
			"format: omp-profile\nversion: 1\nincludedGroups: []\nmodelRoles: {default: openai/gpt}\nsettings:\n  compaction:\n    enabled: true\n",
			"format: omp-profile\nversion: 1\nincludedGroups: [context]\nmodelRoles: {default: openai/gpt}\nsettings: {}\nsecret: do-not-echo\n",
			"format: omp-profile\nversion: 1\nemoji: '🔥'\nincludedGroups: []\nmodelRoles: {default: openai/gpt}\nsettings: {}\n",
			"format: omp-profile\nversion: 1\nincludedGroups: [tasks]\nmodelRoles: {default: openai/gpt}\nsettings:\n  task:\n    agentModelOverrides:\n      __proto__: do-not-echo\n",
			"format: omp-profile\nversion: 1\nincludedGroups: [unknown]\nmodelRoles: {default: openai/gpt}\nsettings: {}\n",
			"format: omp-profile\nversion: 1\nincludedGroups: [model]\nmodelRoles: {default: openai/gpt}\nsettings:\n  retry:\n    fallbackChains: &chains\n      default: *chains\n",
			"format: omp-profile\nversion: 1\nemoji: constructor\nincludedGroups: [toString]\nmodelRoles: {}\nsettings: {}\n",
			"format: omp-profile\nversion: 1\nincludedGroups: []\nmodelRoles: {}\nsettings: {}\nconstructor:\n  secret: do-not-echo\n",
			"format: omp-profile\nversion: 1\nincludedGroups: [providers]\nmodelRoles: {}\nsettings:\n  providers:\n    fireworksTier: priority\n    antigravityEndpoint: sandbox\n",
			"format: omp-profile\nversion: 1\nincludedGroups: [providers]\nmodelRoles: {}\nsettings:\n  codexResets:\n    autoRedeem: 'yes'\n",
			"format: omp-profile\nversion: 1\nincludedGroups: [providers]\nmodelRoles: {}\nsettings:\n  claudeResets:\n    autoRedeem: 'yes'\n",
			"format: omp-profile\nversion: 1\nincludedGroups: []\nmodelRoles: {}\nsettings:\n  compaction.enabled: false\n",
			"format: omp-profile\nversion: 1\nincludedGroups: [context]\nmodelRoles: {}\nsettings:\n  compaction.enabled: false\n",
		];
		for (const artifact of invalidArtifacts) {
			try {
				parseProfile(artifact);
				expect.unreachable("expected strict profile rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("Profile file is invalid");
				expect((error as Error).message).not.toContain("do-not-echo");
			}
		}
	});

	it("rejects repeated YAML aliases before special fallback-chain copying can expand them", () => {
		const chain = Array.from({ length: 1_000 }, (_, index) => `model/fallback-${index}`).join(", ");
		const aliases = Array.from({ length: 999 }, (_, index) => `      r${index + 1}: *chain`).join("\n");
		const artifact = [
			"format: omp-profile",
			"version: 1",
			"includedGroups: [model]",
			"modelRoles: {}",
			"settings:",
			"  retry:",
			"    fallbackChains:",
			`      r0: &chain [${chain}]`,
			aliases,
			"",
		].join("\n");
		expect(() => parseProfile(artifact)).toThrow("Profile file is invalid");
	});

	it("names the exact local-only account-spending path on export without removing legacy values", () => {
		const codexResets = {
			autoRedeem: "yes",
			minBlockedMinutes: 240,
			keepCredits: 2,
			salvageHorizonHours: 8,
		};
		const legacy: ProfileDraft = {
			metadata: { version: 1, enabledGroups: ["providers"] },
			config: {
				modelRoles: { default: "openai/gpt-5.4" },
				codexResets,
			},
		};
		expect(() => serializeProfile(legacy)).toThrow(
			'Profile cannot be exported because "codexResets.autoRedeem" is local-only',
		);
		expect(legacy.config).toEqual({
			modelRoles: { default: "openai/gpt-5.4" },
			codexResets,
		});
	});

	it("rejects legacy Claude saved-reset policy exports without mutating the setup", () => {
		const claudeResets = {
			autoRedeem: "yes",
			minBlockedMinutes: 240,
			keepCredits: 2,
			salvageHorizonHours: 8,
		};
		const legacy: ProfileDraft = {
			metadata: { version: 1, enabledGroups: ["providers"] },
			config: {
				modelRoles: { default: "anthropic/claude-sonnet-4-6" },
				claudeResets,
			},
		};
		expect(() => serializeProfile(legacy)).toThrow(
			'Profile cannot be exported because "claudeResets.autoRedeem" is local-only',
		);
		expect(legacy.config).toEqual({
			modelRoles: { default: "anthropic/claude-sonnet-4-6" },
			claudeResets,
		});
	});

	it("bounds file input before parsing and creates exports without clobbering", async () => {
		const profilePath = tempDir.join("profile.yml");
		await writeProfileFile(profilePath, portableDraft(), "Budget development");
		expect(await readProfileFile(profilePath)).toEqual({
			name: "Budget development",
			draft: portableDraft(),
		});
		expect((await readProfileArtifactFile(profilePath)).format).toBe("omp-profile");
		const original = await Bun.file(profilePath).text();
		await expect(writeProfileFile(profilePath, portableDraft())).rejects.toThrow(
			"A file already exists at the selected path",
		);
		expect(await Bun.file(profilePath).text()).toBe(original);

		const oversizedPath = tempDir.join("oversized.yml");
		await Bun.write(oversizedPath, "x".repeat(MAX_PROFILE_ARTIFACT_BYTES + 1));
		await expect(readProfileArtifactFile(oversizedPath)).rejects.toThrow("Profile file is too large");
		expect(() => parseProfile("x".repeat(MAX_PROFILE_ARTIFACT_BYTES + 1))).toThrow("Profile file is too large");
		expect((await fs.readdir(tempDir.path())).filter(name => name.endsWith(".tmp"))).toEqual([]);
		const invalidUtf8Path = tempDir.join("invalid-utf8.yml");
		await Bun.write(invalidUtf8Path, new Uint8Array([0xff]));
		await expect(readProfileFile(invalidUtf8Path)).rejects.toThrow("Profile file is invalid");
		const directoryPath = tempDir.join("directory.yml");
		await fs.mkdir(directoryPath);
		await expect(readProfileFile(directoryPath)).rejects.toThrow("Profile file is invalid");
	});
});
