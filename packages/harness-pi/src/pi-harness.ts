import type { AgentHarness, HarnessSession, SessionConfig } from "@agent-loop/core";
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
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(this.cwd),
    });

    return new PiHarnessSession(config.model ?? "default", session);
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
