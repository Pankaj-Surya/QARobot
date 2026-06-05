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
import { ragRoutes } from "./routes/rag.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      const allowedOrigins = new Set([
        process.env.FRONTEND_ORIGIN || "http://localhost:3000",
        "http://localhost:3000",
        "https://qarobot-frontend.vercel.app",
      ]);

      if (!origin || allowedOrigins.has(origin) || /\.vercel\.app$/i.test(new URL(origin).hostname)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed by CORS"), false);
    },
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
  await app.register(ragRoutes, { prefix: "/api/rag" });

  return app;
}
