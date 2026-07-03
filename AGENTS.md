# AGENTS.md — Agent Loop Orchestrator SDK

## Project overview

This is a TypeScript SDK for orchestrating goal‑driven agent workflows on top of existing agent harnesses (starting with [pi coding agent](https://pi.dev)). It is **not** an application. Future use cases such as "Jira → implement → review → MR" live in `examples/` as consumers of the SDK.

## Core principles

When working on this codebase, keep these boundaries in mind:

1. **SDK first, app never**: expose composable primitives. Do not build a server, cron runner, webhook receiver, or CLI into the core packages.
2. **Harness adapter pattern**: the core engine is harness‑agnostic. Anything pi‑specific belongs in `packages/harness-pi/`. Design changes should make it easier to add OpenCode / Claude Code adapters later.
3. **No tool execution in the SDK**: the harness owns tools, skills, extensions, and auth. The SDK drives harness sessions via `prompt()` and reads their outputs. Never call external APIs or run shell commands directly from the orchestrator.
4. **No auth management in the SDK**: do not add API key handling, OAuth flows, or credential storage. The harness resolves these.
5. **Isolated sessions**: each workflow `SessionSpec` gets its own harness session. Do not share prompts or tool results between sessions implicitly; routing happens through the orchestrator's shared `WorkflowState`.
6. **Constraints at the orchestrator layer**: iteration caps, spend limits, wall‑clock timeouts, and model allow‑lists are enforced by the engine, not the harness.
7. **Durable checkpoints**: workflow state is written to disk after every turn. Do not rely on harness session files for durability.

## Repository layout

```
agent-loop-sdk/
├── packages/
│   ├── core/              # orchestrator engine
│   │   ├── src/types.ts   # harness interface, workflow, state, events
│   │   ├── src/engine.ts  # Orchestrator + defineWorkflow
│   │   ├── src/constraints.ts
│   │   ├── src/state.ts
│   │   └── src/checkpoint.ts
│   └── harness-pi/        # pi SDK adapter
│       ├── src/pi-harness.ts
│       └── src/pi-session.ts
├── examples/
│   ├── minimal/           # basic usage
│   └── jira-to-mr/        # realistic consumer example
├── plan.md                # architecture plan and decisions
└── README.md
```

## Common commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -r build

# Typecheck all packages
pnpm -r typecheck

# Run tests
pnpm -r test

# Run an example
pnpm -F @agent-loop-examples/jira-to-mr start
```

## Adding features

### New orchestrator capability

- Prefer changing `packages/core/src/types.ts` and `packages/core/src/engine.ts`.
- Keep the harness adapter interface minimal: `createSession()`, `prompt()`, `subscribe()`, `dispose()`.
- Add or update unit tests in `packages/core/src/*.test.ts`.

### New harness adapter (e.g., OpenCode, Claude)

- Create a new package under `packages/`, e.g. `packages/harness-opencode/`.
- Implement `AgentHarness` and `HarnessSession` from `@agent-loop/core`.
- Do not add harness‑specific types to `packages/core`.

### New example consumer

- Create a new package under `examples/`, e.g. `examples/mr-review/`.
- Keep it self‑contained. It should import `@agent-loop/core` and a harness adapter, nothing else.

## Testing guidelines

- Use Node's built‑in test runner (`node:test` / `node:assert/strict`).
- Tests live next to the source files: `src/foo.ts` → `src/foo.test.ts`.
- Mock harnesses are preferred over calling real harnesses in unit tests.
- Clean up temporary files (use `tmpdir()` and `rm()`).

## Things to avoid

- Adding dependencies to `packages/core` that are harness‑specific.
- Calling external services (Jira, GitLab, etc.) directly from the SDK. Those are harness concerns.
- Making the engine aware of specific trigger shapes; triggers are opaque payloads provided by consumers.
- Storing secrets, API keys, or tokens anywhere in this repo.

## Decision log

Major architectural decisions are recorded in `plan.md`. If you change a significant design choice, update `plan.md` and this file.
