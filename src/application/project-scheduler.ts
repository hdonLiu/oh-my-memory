import type { MemoryService } from "./memory-service.js";
import type { Memory, Scope } from "../domain/types.js";

export interface ProjectBuildSchedulerConfig {
  enabled: boolean;
  intervalMs: number;
}

export interface ProjectBuildScheduler {
  runOnce(): Promise<ProjectBuildRunResult>;
  stop(): void;
}

export interface ProjectBuildRunResult {
  scopesRun: number;
  createdOrUpdated: number;
  errors: Array<{ scope: Scope; error: string }>;
}

const defaultConfig: ProjectBuildSchedulerConfig = {
  enabled: false,
  intervalMs: 5 * 60 * 1000
};

export function loadProjectBuildSchedulerConfig(
  env: Record<string, string | undefined> = process.env
): ProjectBuildSchedulerConfig {
  return {
    enabled: parseBoolean(env.PROJECT_BUILD_ENABLED, defaultConfig.enabled, "PROJECT_BUILD_ENABLED"),
    intervalMs: parsePositiveInteger(env.PROJECT_BUILD_INTERVAL_MS, defaultConfig.intervalMs, "PROJECT_BUILD_INTERVAL_MS")
  };
}

export async function runScheduledProjectBuild(service: MemoryService): Promise<ProjectBuildRunResult> {
  const startedAt = new Date().toISOString();
  const scopes = collectProjectBuildScopes(service.listMemories({}).memories);
  const errors: ProjectBuildRunResult["errors"] = [];
  let createdOrUpdated = 0;
  for (const scope of scopes) {
    try {
      const result = await service.runProjectBuild(scope);
      createdOrUpdated += result.createdOrUpdated.length;
    } catch (error) {
      errors.push({ scope, error: error instanceof Error ? error.message : "unknown error" });
    }
  }
  const run = {
    scopesRun: scopes.length,
    createdOrUpdated,
    errors
  };
  service.recordProjectBuildRun({
    ...run,
    startedAt,
    endedAt: new Date().toISOString(),
    status: errors.length === 0 ? "success" : errors.length === scopes.length ? "failed" : "partial_failure"
  });
  return run;
}

export function startProjectBuildScheduler(
  service: MemoryService,
  config: ProjectBuildSchedulerConfig = loadProjectBuildSchedulerConfig(),
  logger: Pick<Console, "error" | "info"> = console
): ProjectBuildScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  const runOnce = async (): Promise<ProjectBuildRunResult> => {
    const result = await runScheduledProjectBuild(service);
    if (result.errors.length > 0) {
      logger.error("Project build scheduler completed with errors", result.errors);
    }
    return result;
  };

  if (config.enabled) {
    timer = setInterval(() => {
      void runOnce().catch((error) => {
        logger.error("Project build scheduler failed", error);
      });
    }, config.intervalMs);
    logger.info(`Project build scheduler enabled with interval ${config.intervalMs}ms`);
  }

  return {
    runOnce,
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

export function collectProjectBuildScopes(memories: Memory[]): Scope[] {
  const byKey = new Map<string, Scope>();
  for (const memory of memories) {
    if (memory.level !== "topic" || memory.type !== "topic" || memory.status !== "active") {
      continue;
    }
    const scope = {
      uid: memory.uid,
      source: memory.source,
      agent: memory.agent,
      channel: memory.channel,
      metadata: memory.metadata
    };
    byKey.set(scopeKey(scope), scope);
  }
  return Array.from(byKey.values());
}

function scopeKey(scope: Scope): string {
  return [scope.uid, scope.source, scope.agent, scope.channel, JSON.stringify(scope.metadata)].join("\0");
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
