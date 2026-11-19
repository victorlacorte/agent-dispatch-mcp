import type { Harness } from "../types.ts";
import { codexAdapter } from "./codex.ts";
import type { WorkerAdapter } from "./types.ts";

const adapters: Record<Harness, WorkerAdapter> = {
  codex: codexAdapter,
};

export function adapterFor(harness: Harness): WorkerAdapter {
  return adapters[harness];
}
