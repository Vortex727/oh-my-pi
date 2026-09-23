import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("Settings saved-setup layer", () => {
	it("outranks persisted layers, yields to runtime overrides, and clears back to them", () => {
		const settings = Settings.isolated({});
		settings.set("compaction.enabled", false);
		settings.setModelRole("smol", "base/smol");
		settings.setModelRole("slow", "base/slow");

		settings.applySetupLayer({ compaction: { enabled: true }, modelRoles: { smol: "setup/smol", slow: null } });
		expect(settings.get("compaction.enabled")).toBe(true);
		expect(settings.getModelRole("smol")).toBe("setup/smol");
		// A null setup role masks the persisted role, like an overlay tombstone.
		expect(settings.getModelRole("slow")).toBeUndefined();
		expect(settings.getModelRoleProvenance("smol")).toBe("overlay");

		settings.overrideModelRoles({ smol: "runtime/smol" });
		expect(settings.getModelRole("smol")).toBe("runtime/smol");
		settings.clearOverride("modelRoles");

		settings.applySetupLayer(undefined);
		expect(settings.get("compaction.enabled")).toBe(false);
		expect(settings.getModelRole("smol")).toBe("base/smol");
		expect(settings.getModelRole("slow")).toBe("base/slow");
	});

	it("lets an explicit edit of a setup-owned setting take effect while the rest of the setup stays applied", () => {
		const settings = Settings.isolated({});
		settings.applySetupLayer({
			compaction: { enabled: false },
			tui: { vimMode: true },
			modelRoles: { smol: "setup/smol", slow: "setup/slow" },
		});

		settings.set("compaction.enabled", true);
		settings.setModelRole("smol", "user/smol");

		expect(settings.get("compaction.enabled")).toBe(true);
		expect(settings.getModelRole("smol")).toBe("user/smol");
		expect(settings.getModelRoleProvenance("smol")).toBe("global");
		expect(settings.get("tui.vimMode")).toBe(true);
		expect(settings.getModelRole("slow")).toBe("setup/slow");
	});

	it("signals effective changes only for settings whose value the setup changes", () => {
		const settings = Settings.isolated({});
		const browserEnabled = settings.get("browser.enabled");
		const changed: string[] = [];
		const unsubscribe = settings.onEffectiveChange(path => changed.push(path));
		try {
			const setup = {
				browser: { enabled: !browserEnabled },
				compaction: { enabled: settings.get("compaction.enabled") },
			};
			settings.applySetupLayer(setup);
			expect(changed).toEqual(["browser.enabled"]);

			changed.length = 0;
			settings.applySetupLayer(setup);
			expect(changed).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	it("carries the applied setup into settings cloned for another working directory", async () => {
		const settings = Settings.isolated({});
		settings.applySetupLayer({ modelRoles: { smol: "setup/smol" } });

		const cloned = await settings.cloneForCwd(os.tmpdir());
		expect(cloned.getModelRole("smol")).toBe("setup/smol");
	});
});
