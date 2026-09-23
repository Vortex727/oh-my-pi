import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";
import { installLegacyPiSpecifierShim } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { ModelHubComponent } from "../../../tui/src/overlays/model-hub";

// Host modules lazily `require()` canonical overlays, e.g. the model hub behind
// `/model` and the model-role picker. Once the legacy shim was installed, those
// requires went through its resolver; on Windows that re-entered Bun's runtime
// hook and failed with an unreadable `file:file:…` module key.
describe("legacy pi shim with host-internal imports", () => {
	it("resolves a host module's canonical require to the host module instance", () => {
		installLegacyPiSpecifierShim();
		const hostModule = path.join(import.meta.dir, "../../src/modes/controllers/selector-controller.ts");
		const required = createRequire(hostModule)("@oh-my-pi/pi-tui/overlays/model-hub.js");
		expect(required.ModelHubComponent).toBe(ModelHubComponent);
	});
});
