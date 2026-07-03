import type { ObservationStore, ObservationStoreConfig } from "./types.js";
import { MemoryObservationStore } from "./memory-store.js";
import { JsonlObservationStore } from "./jsonl-store.js";
import { SqliteObservationStore } from "./sqlite-store.js";

export * from "./types.js";
export { MemoryObservationStore } from "./memory-store.js";
export { JsonlObservationStore } from "./jsonl-store.js";
export { SqliteObservationStore } from "./sqlite-store.js";
export { ObservationCollector } from "./collector.js";
export { ObservationClient } from "./client.js";

export function createObservationStore(config: ObservationStoreConfig): ObservationStore {
  switch (config.type) {
    case "memory":
      return new MemoryObservationStore();
    case "jsonl":
      return new JsonlObservationStore({ baseDir: config.baseDir });
    case "sqlite":
      return new SqliteObservationStore({ filePath: config.filePath });
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown observation store config: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
