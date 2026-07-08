import type { MemoryService } from "./memory-service.js";
import type { Scope } from "../domain/types.js";

export interface LayeredSchedulerConfig {
  l1Enabled: boolean;
  l1IntervalMs: number;
  l2Enabled: boolean;
  l2IntervalMs: number;
}

export interface LayeredSchedulers {
  runL1Once(): Promise<{ sessionsRun: number; errors: string[] }>;
  runL2Once(): Promise<{ namespacesRun: number; errors: string[] }>;
  stop(): void;
}

export function loadLayeredSchedulerConfig(
  env: Record<string, string | undefined> = process.env
): LayeredSchedulerConfig {
  return {
    l1Enabled: parseBoolean(env.L1_MAINTENANCE_ENABLED, false, "L1_MAINTENANCE_ENABLED"),
    l1IntervalMs: parsePositiveInteger(env.L1_MAINTENANCE_INTERVAL_MS, 60_000, "L1_MAINTENANCE_INTERVAL_MS"),
    l2Enabled: parseBoolean(env.L2_AGGREGATION_ENABLED, false, "L2_AGGREGATION_ENABLED"),
    l2IntervalMs: parsePositiveInteger(env.L2_AGGREGATION_INTERVAL_MS, 300_000, "L2_AGGREGATION_INTERVAL_MS")
  };
}

export function startLayeredSchedulers(
  service: MemoryService,
  config = loadLayeredSchedulerConfig(),
  logger: Pick<Console, "error" | "info"> = console
): LayeredSchedulers {
  let l1Timer: ReturnType<typeof setInterval> | null = null;
  let l2Timer: ReturnType<typeof setInterval> | null = null;

  const runL1Once = async () => {
    const sessions = collectL1Sessions(service);
    const errors: string[] = [];
    for (const item of sessions) {
      try {
        await service.runL1Maintenance(item.scope, item.sessionId);
      } catch (error) {
        errors.push(`${sessionKey(item.scope, item.sessionId)}: ${errorMessage(error)}`);
      }
    }
    return { sessionsRun: sessions.length, errors };
  };

  const runL2Once = async () => {
    const namespaces = collectL2Namespaces(service);
    const errors: string[] = [];
    for (const namespace of namespaces) {
      try {
        await service.runL2Aggregation(namespace.uid, namespace.agent);
      } catch (error) {
        errors.push(`${namespace.uid}\0${namespace.agent}: ${errorMessage(error)}`);
      }
    }
    return { namespacesRun: namespaces.length, errors };
  };

  if (config.l1Enabled) {
    l1Timer = setInterval(() => void runL1Once().catch((error) => logger.error("L1 scheduler failed", error)), config.l1IntervalMs);
    logger.info(`L1 maintenance scheduler enabled with interval ${config.l1IntervalMs}ms`);
  }
  if (config.l2Enabled) {
    l2Timer = setInterval(() => void runL2Once().catch((error) => logger.error("L2 scheduler failed", error)), config.l2IntervalMs);
    logger.info(`L2 aggregation scheduler enabled with interval ${config.l2IntervalMs}ms`);
  }

  return {
    runL1Once,
    runL2Once,
    stop() {
      if (l1Timer) clearInterval(l1Timer);
      if (l2Timer) clearInterval(l2Timer);
      l1Timer = null;
      l2Timer = null;
    }
  };
}

function collectL1Sessions(service: MemoryService): Array<{ scope: Scope; sessionId: string }> {
  const byKey = new Map<string, { scope: Scope; sessionId: string }>();
  for (const view of service.listL1Topics({ includeInactive: false })) {
    if (view.revision.status !== "provisional") continue;
    const scope = {
      uid: view.topic.uid,
      source: view.topic.source,
      agent: view.topic.agent,
      channel: view.topic.channel,
      metadata: view.topic.metadata
    };
    byKey.set(sessionKey(scope, view.topic.sessionId), { scope, sessionId: view.topic.sessionId });
  }
  for (const item of service.listPendingL1CorrectionSessions()) {
    byKey.set(sessionKey(item.scope, item.sessionId), item);
  }
  return Array.from(byKey.values());
}

function collectL2Namespaces(service: MemoryService): Array<{ uid: string; agent: string }> {
  const byKey = new Map<string, { uid: string; agent: string }>();
  for (const namespace of service.listDueL2Namespaces()) {
    byKey.set(`${namespace.uid}\0${namespace.agent}`, namespace);
  }
  return Array.from(byKey.values());
}

function sessionKey(scope: Scope, sessionId: string): string {
  return [scope.uid, scope.source, scope.agent, scope.channel, sessionId].join("\0");
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
