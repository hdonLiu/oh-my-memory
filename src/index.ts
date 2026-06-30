import { buildServer } from "./server.js";
import { createRuntimeMemoryService } from "./application/memory-service.js";
import { startLayeredSchedulers } from "./application/layered-scheduler.js";
import { createDatabase } from "./storage/database.js";
import { MemoryRepository } from "./storage/repositories.js";

const port = Number(process.env.PORT ?? 3000);
const db = createDatabase();
const store = new MemoryRepository(db);
const service = createRuntimeMemoryService(store, {}, db);
const app = buildServer(service);

const scheduler = startLayeredSchedulers(service);

await app.listen({ port, host: "0.0.0.0" });
console.log(`oh-my-memory listening on http://localhost:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void app.close().finally(() => process.exit(0));
  });
}
