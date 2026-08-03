// Project-local Pi extension: publishes the runtime's existing `flow` command
// surface as Pi commands. It contains no logic of its own on purpose — the
// mapping and its tests live in `src/pi/adapter.ts`, so what ships here is
// reviewable and covered rather than hidden in an untracked global extension.

import {
  registerFlowCommands,
  type PiExtensionApi,
} from "../../../src/pi/adapter.ts";

export default function activate(pi: PiExtensionApi): void {
  registerFlowCommands(pi);
}
