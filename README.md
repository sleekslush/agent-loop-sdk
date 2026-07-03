# Agent Loop Orchestrator SDK

A TypeScript SDK for running goal‑driven agent workflows on top of existing agent harnesses such as [pi coding agent](https://pi.dev). It is **not** a standalone application — it provides the primitives that consumers use to build workflows like "Jira ticket → implement → review → merge request".

## Philosophy

- **SDK first**: expose composable primitives, not a monolithic app.
- **Harness adapter pattern**: start with pi, design the interface so OpenCode, Claude Code, or other harnesses can be plugged in later.
- **No tool execution in the SDK**: the harness owns models, skills, tools, and auth. The SDK only drives harness sessions and routes their outputs.
- **Isolated sessions**: each role (Jira reader, coder, reviewer, submitter) runs in its own harness session with its own model and system prompt.
- **Constraint-aware**: enforce iteration caps, spend limits, wall-clock timeouts, and model allow-lists at the orchestrator layer.

## Packages

| Package | Description |
|---|---|
| [`@agent-loop/core`](packages/core) | Workflow engine, state machine, constraints, checkpoints, events |
| [`@agent-loop/harness-pi`](packages/harness-pi) | Adapter for `@earendil-works/pi-coding-agent` |
| [`@agent-loop/pi-extension`](packages/pi-extension) | Pi extension, skill, and prompt for `/agentloop` and `run_agent_loop` |

## Quick start

```bash
pnpm install
pnpm -r build
pnpm -r test
```

To use the SDK inside pi, install the pi package:

```bash
pi install npm:@agent-loop/pi-extension
```

Or, while developing locally from this repo:

```bash
pi install ./packages/pi-extension
```

Then start pi in your project directory. `/agentloop` and the `run_agent_loop` tool will be available immediately.

## Usage

```ts
import { defineWorkflow, Orchestrator } from "@agent-loop/core";
import { PiHarness } from "@agent-loop/harness-pi";

const workflow = defineWorkflow({
  id: "review-loop",
  goal: "Review a code change",
  sessions: [
    {
      id: "reviewer",
      role: "reviewer",
      harness: "pi",
      model: "claude-sonnet-4-20250514",
      summarizeOutput: true,
      summaryPrompt:
        "Summarize your review in one paragraph and end with VERDICT: APPROVED or VERDICT: REJECTED.",
    },
  ],
  transitions: [
    { from: "start", to: "reviewer", input: "Review this change." },
  ],
  constraints: { maxIterations: 10, maxSpendUsd: 2.0 },
  exitConditions: {
    goalMet: (state) => /VERDICT: APPROVED/i.test(state.sessions.reviewer.lastSummary ?? ""),
  },
});

const orchestrator = new Orchestrator({
  harnesses: [new PiHarness()],
});

const state = await orchestrator.start(workflow);
console.log(state.outcome);
```

Setting `summarizeOutput: true` asks the session to summarize its own output
after the turn. The summary is stored on `state.sessions.<id>.lastSummary` and
emitted as a `turn.summarized` event, making it easy to pass compact context to
the next phase. See [docs/observability.md](docs/observability.md) for more
details.

## Pi extension

The [`@agent-loop/pi-extension`](packages/pi-extension) package adds:

- `/agentloop <goal>` — design and run a workflow from a goal.
- `/agentloop design <goal>` — design a workflow and run it.
- `run_agent_loop` tool — lets pi decide to run a workflow itself.

Install it as a pi package:

```bash
pi install npm:@agent-loop/pi-extension
```

For local development from this repo:

```bash
pi install ./packages/pi-extension
```

Then start pi in the same directory.

If you prefer project-local `.pi/` files (for example, to customize the
extension), you can also install it via npm/pnpm and run the setup command:

```bash
pnpm add -D @agent-loop/pi-extension
pnpm exec agent-loop-pi-extension setup
```

The generated `.pi/` folder is user-specific and is already ignored by the
repo's `.gitignore`.

To add predefined workflows for `/agentloop run <workflow-id>`, see
[`packages/pi-extension/README.md`](packages/pi-extension/README.md).

## Examples

- [`examples/minimal`](examples/minimal) — smallest possible workflow.
- [`examples/jira-to-mr`](examples/jira-to-mr) — pull a Jira ticket, implement, review, open a GitLab MR.

Run an example:

```bash
pnpm -F @agent-loop-examples/jira-to-mr start
```

## Architecture

```
Consumer App
    │ imports
    ▼
Agent Loop Orchestrator SDK
    ┌──────────────┐
    │ Loop Engine  │
    │ Constraints  │
    │ Checkpoints  │
    └──────┬───────┘
           │ Harness Adapter Interface
    ┌──────▼───────┐
    │  Pi Adapter  │───▶  @earendil-works/pi-coding-agent
    └──────────────┘
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -r build

# Typecheck all packages
pnpm -r typecheck

# Run tests
pnpm -r test
```

## Roadmap

- [x] Scaffold and core engine
- [x] Pi harness adapter
- [x] Tests
- [x] Jira→MR example
- [ ] Resilience (retries, error handling, session recovery)
- [x] Observability (queryable stores, rollups, session recall) — see [docs/observability.md](docs/observability.md)
- [ ] OpenCode / Claude harness adapter validation

## License

MIT
