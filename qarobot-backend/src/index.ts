import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { documentsRoutes } from "./routes/documents.js";
import { modelsRoutes } from "./routes/models.js";
import { testPlansRoutes } from "./routes/test-plans.js";
import { testCasesRoutes } from "./routes/test-cases.js";
import { scriptsRoutes } from "./routes/scripts.js";
import { runsRoutes } from "./routes/runner.js";
import { healerRoutes } from "./routes/healer.js";

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: [
    process.env.FRONTEND_ORIGIN || "http://localhost:3000",
    "http://localhost:3000",
  ],
  credentials: true,
});

await app.register(multipart, {
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

app.get("/health", async () => ({
  ok: true,
  service: "qarobot-backend",
}));

await app.register(documentsRoutes, { prefix: "/api/documents" });
await app.register(modelsRoutes, { prefix: "/api/models" });
await app.register(testPlansRoutes, { prefix: "/api/test-plans" });
await app.register(testCasesRoutes, { prefix: "/api/test-cases" });
await app.register(scriptsRoutes, { prefix: "/api/scripts" });
await app.register(runsRoutes, { prefix: "/api/runs" });
await app.register(healerRoutes, { prefix: "/api/healer" });

const port = Number(process.env.PORT || 3001);
await app.listen({ port, host: "0.0.0.0" });
