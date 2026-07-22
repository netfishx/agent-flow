// Test-support entry, separate from the production `index.ts`. Consumers that
// want to drive the runtime deterministically (fake adapter, injectable clock,
// the shell-quoting inverse) import from here, keeping the production surface
// limited to the runtime and the real adapter.

export {
  createClock,
  FakeHerdrAdapter,
  scanSingleQuoted,
} from "./herdr/fake-adapter.ts";
export type {
  FakeAdvances,
  FakeHerdrAdapterOptions,
  FakeLaneProgram,
  MutableClock,
} from "./herdr/fake-adapter.ts";
export { classifyWaitOutput } from "./herdr/real-adapter.ts";
export { InMemoryLedger } from "./runtime/ledger.ts";
export { FsLedger } from "./runtime/fs-ledger.ts";
