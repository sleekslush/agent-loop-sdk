# @agent-loop/pi-extension

Pi coding agent extension for the Agent Loop Orchestrator SDK.

Provides:

- Slash command `/agentloop <goal>` to design and run a multi-step workflow.
- Slash command `/agentloop design <goal>` to design a workflow and run it.
- Slash command `/agentloop run <workflow-id> [args]` when predefined workflows are configured.
- LLM tool `run_agent_loop` so pi can decide to run a workflow itself.

## Install

The easiest way is to install it as a pi package:

```bash
pi install npm:@agent-loop/pi-extension
```

Then start pi in your project directory. `/agentloop` and `run_agent_loop` will
be available immediately.

### Local development from this repo

From another project on the same machine:

```bash
pi install /path/to/agent-loop-sdk/packages/pi-extension
```

Or from inside the `agent-loop-sdk` repo:

```bash
pi install ./packages/pi-extension
```

### Project-local `.pi/` files

If you prefer to copy the extension, skill, and prompt into your project's `.pi/`
folder (for example, to customize the extension), install the package with your
Node package manager and run the setup command:

```bash
pnpm add -D @agent-loop/pi-extension
pnpm exec agent-loop-pi-extension setup
```

This creates a local `.pi/` folder with the extension, skill, and prompt files.
The `.pi/` folder is user-specific and should not be committed to git.

To install globally instead:

```bash
pnpm exec agent-loop-pi-extension setup --global
```

## Custom predefined workflows

By default the extension supports auto-designed workflows. To add predefined
workflows (for `/agentloop run <id>`), replace `.pi/extensions/agent-loop.ts`
with a small wrapper:

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

The package follows the [pi package](https://pi.dev/docs/packages.html)
conventions:

- `keywords: ["pi-package"]` for discoverability.
- `package.json` `pi` manifest pointing to the extension, skill, and prompt.
- Peer dependencies on packages pi already provides
  (`@earendil-works/pi-coding-agent`, `typebox`).
