import { buildServer } from "./server.js";
import { createDatabase } from "./storage/database.js";

const port = Number(process.env.PORT ?? 3000);
const app = buildServer(createDatabase());

await app.listen({ port, host: "0.0.0.0" });
console.log(`oh-my-memory listening on http://localhost:${port}`);
