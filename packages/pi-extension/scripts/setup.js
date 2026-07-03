#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFile, mkdir, rm } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(__dirname);
const srcDir = join(packageRoot, "src");

const isGlobal = process.argv.includes("--global") || process.argv.includes("-g");

const target = isGlobal
  ? join(process.env.HOME ?? process.env.USERPROFILE ?? "/", ".pi", "agent")
  : join(process.cwd(), ".pi");

async function copy(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log(`  ${dest}`);
}

console.log(`Installing Agent Loop pi extension to ${target}...`);

// Remove stale tsconfig left over from older versions that kept .pi/ in git.
await rm(join(target, "tsconfig.json"), { force: true }).catch(() => {});

await copy(join(srcDir, "extension.ts"), join(target, "extensions", "agent-loop.ts"));
await copy(join(srcDir, "skill", "SKILL.md"), join(target, "skills", "agent-loop", "SKILL.md"));
await copy(join(srcDir, "prompts", "design-workflow.md"), join(target, "prompts", "design-workflow.md"));

console.log("\nDone. Start pi in this directory to use /agentloop and the run_agent_loop tool.");
if (!isGlobal) {
  console.log("The .pi folder is user-specific and has been added to your local project.");
}
