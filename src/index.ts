import { buildServer } from "./server.js";
import { createMemoryService } from "./application/memory-service.js";
import { startProjectBuildScheduler } from "./application/project-scheduler.js";
import { createDatabase } from "./storage/database.js";
import { MemoryRepository } from "./storage/repositories.js";

const port = Number(process.env.PORT ?? 3000);
const store = new MemoryRepository(createDatabase());
const service = createMemoryService(store);
const app = buildServer(service);

const scheduler = startProjectBuildScheduler(service);

await app.listen({ port, host: "0.0.0.0" });
console.log(`oh-my-memory listening on http://localhost:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void app.close().finally(() => process.exit(0));
  });
}
