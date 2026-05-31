import type { FastifyInstance } from "fastify";

export async function healerRoutes(app: FastifyInstance) {
  app.get("/logs", async () => ({
    healLogs: [],
  }));

  app.post("/analyze", async (_request, reply) => {
    return reply.code(501).send({
      error: "Healer analysis requires runner failure data and Playwright MCP integration.",
    });
  });
}
