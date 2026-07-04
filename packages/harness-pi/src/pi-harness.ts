import { readFile } from "node:fs/promises";
import type {
  AgentHarness,
  HarnessSession,
  HarnessSessionRef,
  SessionConfig,
  SessionExportFormat,
} from "@agent-loop/core";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getModel, type Model, type Api } from "@earendil-works/pi-ai/compat";
import { PiHarnessSession } from "./pi-session.js";

export interface PiHarnessOptions {
  cwd?: string;
  agentDir?: string;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  settingsManager?: SettingsManager;
  resourceLoader?: DefaultResourceLoader;
}

export class PiHarness implements AgentHarness {
  readonly name = "pi";

  private cwd: string;
  private agentDir: string;
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private settingsManager: SettingsManager;
  private resourceLoader?: DefaultResourceLoader;

  constructor(options: PiHarnessOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? getAgentDir();
    this.authStorage = options.authStorage ?? AuthStorage.create(this.agentDir);
    this.modelRegistry = options.modelRegistry ?? ModelRegistry.create(this.authStorage, this.agentDir);
    this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
    this.resourceLoader = options.resourceLoader;
  }

  async createSession(config: SessionConfig): Promise<HarnessSession> {
    const sessionManager = SessionManager.inMemory(this.cwd);
    return this.createPiSession(config, sessionManager);
  }

  async resumeSession(ref: HarnessSessionRef, config?: SessionConfig): Promise<HarnessSession> {
    if (!ref.sessionFile) {
      throw new Error("Cannot resume pi session without sessionFile");
    }
    const sessionManager = SessionManager.open(ref.sessionFile, undefined, this.cwd);
    return this.createPiSession(config ?? {}, sessionManager);
  }

  async exportSession(ref: HarnessSessionRef, format: SessionExportFormat): Promise<string> {
    if (format !== "jsonl") {
      throw new Error(`Pi harness does not yet support exporting sessions as ${format}`);
    }
    if (!ref.sessionFile) {
      throw new Error("Cannot export pi session without sessionFile");
    }
    return readFile(ref.sessionFile, "utf-8");
  }

  private async createPiSession(
    config: SessionConfig,
    sessionManager: SessionManager,
  ): Promise<HarnessSession> {
    const model = config.model ? await this.resolveModel(config.model) : undefined;

    const loader = this.resourceLoader ?? new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
      systemPromptOverride: config.systemPrompt ? () => config.systemPrompt! : undefined,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      model,
      thinkingLevel: config.thinkingLevel as never,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      resourceLoader: loader,
      sessionManager,
    });

    return new PiHarnessSession(config.model ?? session.sessionId, session);
  }

  private async resolveModel(modelRef: string): Promise<Model<Api> | undefined> {
    if (modelRef.includes("/")) {
      const [provider, id] = modelRef.split("/");
      const builtin = getModel(provider as never, id as never);
      if (builtin) return builtin as Model<Api>;
      return this.modelRegistry.find(provider, id) ?? undefined;
    }

    const available = await this.modelRegistry.getAvailable();
    return available.find((m: Model<Api>) => m.id === modelRef || m.name === modelRef);
  }
}
