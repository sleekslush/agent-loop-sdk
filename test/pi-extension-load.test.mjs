import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionPath = path.join(repoRoot, ".pi/extensions/agent-loop.ts");

async function hideBuiltPackageDirs(callback) {
  const movedDirs = [];
  const distDirs = ["packages/core/dist", "packages/harness-pi/dist"];

  try {
    for (const distDir of distDirs) {
      const source = path.join(repoRoot, distDir);
      if (!existsSync(source)) continue;

      const target = `${source}.hidden-${process.pid}-${Date.now()}`;
      await rename(source, target);
      movedDirs.push([source, target]);
    }

    await callback();
  } finally {
    for (const [source, target] of movedDirs.reverse()) {
      if (existsSync(target)) {
        await rename(target, source);
      }
    }
  }
}

test("project-local pi extension loads without built workspace dist files", async () => {
  await hideBuiltPackageDirs(async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "agent-loop-pi-agent-"));

    try {
      const result = await discoverAndLoadExtensions([], repoRoot, agentDir);
      assert.deepEqual(result.errors, []);
      assert.equal(
        result.extensions.some((extension) => extension.resolvedPath === extensionPath),
        true,
      );
    } finally {
      await rm(agentDir, { force: true, recursive: true });
    }
  });
});
