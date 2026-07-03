import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkflowState } from "./types.js";

export interface CheckpointStore {
  write(state: WorkflowState): Promise<string>;
  read(stateId: string): Promise<WorkflowState | undefined>;
  list(workflowId?: string): Promise<string[]>;
}

export interface FileCheckpointStoreOptions {
  baseDir: string;
}

export function createFileCheckpointStore(
  options: FileCheckpointStoreOptions,
): CheckpointStore {
  const { baseDir } = options;

  return {
    async write(state): Promise<string> {
      const path = join(baseDir, state.workflowId, `${state.id}.json`);
      await mkdir(dirname(path), { recursive: true });
      const serialized = JSON.stringify(state, null, 2);
      await writeFile(path, serialized, "utf-8");
      return path;
    },

    async read(stateId): Promise<WorkflowState | undefined> {
      // stateId may be a full path or just a filename.
      const candidates = workflowIdCandidates(baseDir, stateId);
      for (const path of candidates) {
        try {
          const data = await readFile(path, "utf-8");
          return JSON.parse(data) as WorkflowState;
        } catch {
          // continue
        }
      }
      return undefined;
    },

    async list(_workflowId): Promise<string[]> {
      // Simplified listing; consumers can expand with fs.readdir.
      return [];
    },
  };
}

function workflowIdCandidates(baseDir: string, stateId: string): string[] {
  // If stateId is just `uuid`, we don't know the workflowId without scanning.
  // For now, support direct paths.
  if (stateId.includes("/") || stateId.includes("\\")) {
    return [stateId];
  }
  return [join(baseDir, stateId)];
}
