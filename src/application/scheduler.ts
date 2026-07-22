import type { MemoryService } from "./memory-service.js";
import type { MemoryRepository } from "../storage/repositories.js";

export function startRebuildScheduler(
  service: MemoryService,
  repository: MemoryRepository,
  options: { intervalMs?: number } = {}
) {
  const intervalMs = options.intervalMs ?? Number(process.env.REBUILD_INTERVAL_MS ?? 10_000);
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      for (const job of repository.listDirtyJobs()) {
        if (job.layer === "topic") {
          const session = repository.getSessionForRebuild(job.scopeId);
          if (session) {
            await service.maintainTopics({
              uid: session.uid,
              agentId: session.agentId,
              externalSessionId: session.externalSessionId
            });
          }
          continue;
        }
        const space = repository.getMemorySpace(job.scopeId);
        const agentId = space ? repository.listSpaceMembers(space.id)[0] : undefined;
        if (!space || !agentId) continue;
        if (job.layer === "L2") {
          await service.rebuildL2({ uid: space.uid, agentId, memorySpaceId: space.id });
        } else {
          await service.rebuildL3({ uid: space.uid, agentId, memorySpaceId: space.id });
        }
      }
    } catch {
      // The service records the failing job as dirty with an error; the next tick retries it.
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  return { runOnce, stop: () => clearInterval(timer) };
}
