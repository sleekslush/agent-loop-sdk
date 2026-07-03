import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileCheckpointStore } from "./checkpoint.js";
import { createInitialState } from "./state.js";
import type { Trigger, Workflow } from "./types.js";

function makeWorkflow(): Workflow {
  return {
    id: "wf-1",
    goal: "test",
    sessions: [],
    transitions: [],
    constraints: { maxIterations: 10 },
    exitConditions: {},
  };
}

function makeTrigger(): Trigger {
  return {
    id: "trigger-1",
    source: "test",
    type: "test.start",
    payload: {},
    receivedAt: new Date(),
  };
}

describe("createFileCheckpointStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "agent-loop-test-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("writes and reads workflow state", async () => {
    const store = createFileCheckpointStore({ baseDir });
    const state = createInitialState(makeWorkflow(), makeTrigger());

    const path = await store.write(state);
    assert.ok(path.includes(state.id));
    assert.ok(path.includes(state.workflowId));

    const read = await store.read(path);
    assert.ok(read);
    assert.equal(read!.id, state.id);
    assert.equal(read!.workflowId, state.workflowId);
    assert.equal(read!.status, "running");
  });

  it("returns undefined for missing state", async () => {
    const store = createFileCheckpointStore({ baseDir });
    const read = await store.read("does-not-exist");
    assert.equal(read, undefined);
  });
});
