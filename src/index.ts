import { startRebuildScheduler } from "./application/scheduler.js";
import { createRuntimeMemoryService } from "./application/memory-service.js";
import { buildServer } from "./server.js";
import { createDatabase } from "./storage/database.js";
import { MemoryRepository } from "./storage/repositories.js";

const port = Number(process.env.PORT ?? 3000);
const db = createDatabase();
const repository = new MemoryRepository(db);
const service = createRuntimeMemoryService(repository);
const app = buildServer(service);
const scheduler = startRebuildScheduler(service, repository);

await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
console.log(`oh-my-memory listening on http://${process.env.HOST ?? "127.0.0.1"}:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
