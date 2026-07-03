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

## Quick start

```bash
pnpm install
pnpm -r build
pnpm -r test
```

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
      parseOutput: (output) => ({ approved: /APPROVED/i.test(output) }),
    },
  ],
  transitions: [
    { from: "start", to: "reviewer", input: "Review this change." },
  ],
  constraints: { maxIterations: 10, maxSpendUsd: 2.0 },
  exitConditions: {
    goalMet: (state) => state.context.approved === true,
  },
});

const orchestrator = new Orchestrator({
  harnesses: [new PiHarness()],
});

const state = await orchestrator.start(workflow);
console.log(state.outcome);
```

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
