# @agent-loop/pi-extension

Pi coding agent extension for the Agent Loop Orchestrator SDK.

Provides:

- Slash command `/agentloop <goal>` to design and run a multi-step workflow.
- Slash command `/agentloop design <goal>` to design a workflow and run it.
- Slash command `/agentloop run <workflow-id> [args]` when predefined workflows are configured.
- LLM tool `run_agent_loop` so pi can decide to run a workflow itself.

## Install

In the project where you want to use the extension:

```bash
pnpm add -D @agent-loop/pi-extension
pnpm exec agent-loop-pi-extension setup
```

This creates a local `.pi/` folder with the extension, skill, and prompt files. The `.pi/` folder is user-specific and should not be committed to git.

To install globally instead:

```bash
pnpm exec agent-loop-pi-extension setup --global
```

## Custom predefined workflows

By default the extension supports auto-designed workflows. To add predefined workflows (for `/agentloop run <id>`), replace `.pi/extensions/agent-loop.ts` with a small wrapper:

```ts
import { createAgentLoopExtension } from "@agent-loop/pi-extension";
import { myWorkflow } from "../workflows/my-workflow.js";

export default createAgentLoopExtension({
  predefinedWorkflows: {
    "my-workflow": (args) => ({
      workflow: myWorkflow,
      trigger: {
        id: `my-workflow-${Date.now()}`,
        source: "pi-extension",
        type: "agentloop.run",
        payload: { args },
        receivedAt: new Date(),
      },
    }),
  },
});
```

## Development

```bash
pnpm typecheck
pnpm build
```
