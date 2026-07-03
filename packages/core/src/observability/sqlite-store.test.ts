import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteObservationStore } from "./sqlite-store.js";

let sqliteAvailable = false;
try {
  await import("better-sqlite3");
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

const itWhenMissing = sqliteAvailable ? it.skip : it;

describe("SqliteObservationStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "agent-loop-sqlite-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  itWhenMissing("throws a helpful error when better-sqlite3 is not installed", async () => {
    const store = new SqliteObservationStore({ filePath: join(baseDir, "obs.sqlite") });
    await assert.rejects(
      () => store.getRun("r1"),
      /better-sqlite3/,
    );
  });
});
