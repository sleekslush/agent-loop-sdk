import type {
  HarnessSession,
  HarnessEvent,
  PromptOptions,
  SessionTurnResult,
  TokenUsage,
} from "@agent-loop/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export class PiHarnessSession implements HarnessSession {
  readonly id: string;
  readonly harness = "pi";

  private session: AgentSession;
  private listeners: Set<(event: HarnessEvent) => void> = new Set();

  constructor(id: string, session: AgentSession) {
    this.id = id;
    this.session = session;
    this.session.subscribe((event) => this.forwardEvent(event));
  }

  async prompt(text: string, _options?: PromptOptions): Promise<SessionTurnResult> {
    const start = Date.now();
    let isError = false;

    try {
      await this.session.prompt(text);
    } catch (err) {
      isError = true;
    }

    const textResult = this.session.getLastAssistantText() ?? "";
    const stats = this.session.getSessionStats();
    const durationMs = Date.now() - start;

    const usage: TokenUsage = {
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
    };

    return {
      text: textResult,
      usage,
      costUsd: stats.cost,
      durationMs,
      isError,
    };
  }

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.session.dispose();
    this.listeners.clear();
  }

  private forwardEvent(event: unknown): void {
    // Minimal forwarding for common event shapes.
    const typed = event as Record<string, unknown>;
    if (typed.type === "message_update") {
      const assistantEvent = typed.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
        this.emit({ type: "text_delta", delta: assistantEvent.delta });
      }
    } else if (typed.type === "turn_start") {
      this.emit({ type: "turn_start" });
    } else if (typed.type === "turn_end") {
      this.emit({ type: "turn_end" });
    } else if (typed.type === "agent_end" && typed.willRetry === false && typeof typed.errorMessage === "string") {
      this.emit({ type: "error", message: typed.errorMessage });
    }
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }
}
