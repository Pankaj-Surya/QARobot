import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { documents, ragProjects } from "../db/schema.js";
import { listRagProjects, sourceTypes, suggestRagProjects } from "../services/rag-projects.js";

const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  domains: z.array(z.string()).optional().default([]),
  aliases: z.array(z.string()).optional().default([]),
});

const mappingSchema = z.object({
  ragProjectId: z.string().uuid(),
  sourceType: z.enum(sourceTypes).optional().default("general"),
});

export async function ragRoutes(app: FastifyInstance) {
  app.get("/projects", async () => {
    return { projects: await listRagProjects() };
  });

  app.post("/projects", async (request, reply) => {
    const parsed = projectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid RAG Project request", details: parsed.error.flatten() });
    }

    const existing = (await listRagProjects()).find(
      (project) => project.name.trim().toLowerCase() === parsed.data.name.trim().toLowerCase(),
    );
    if (existing) {
      return reply.code(200).send({ project: existing });
    }

    const [project] = await db.insert(ragProjects).values({
      ...parsed.data,
      description: parsed.data.description || null,
      updatedAt: new Date(),
    }).returning();

    return reply.code(201).send({ project });
  });

  app.put("/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = projectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid RAG Project request", details: parsed.error.flatten() });
    }

    const [project] = await db
      .update(ragProjects)
      .set({ ...parsed.data, description: parsed.data.description || null, updatedAt: new Date() })
      .where(eq(ragProjects.id, id))
      .returning();

    if (!project) return reply.code(404).send({ error: "RAG Project not found" });
    return { project };
  });

  app.delete("/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const assigned = await db.select({ id: documents.id }).from(documents).where(eq(documents.ragProjectId, id)).limit(1);
    if (assigned.length > 0) {
      return reply.code(409).send({ error: "RAG Project has assigned documents. Reassign or delete those documents before deleting the project." });
    }
    const deleted = await db.delete(ragProjects).where(eq(ragProjects.id, id)).returning();
    if (deleted.length === 0) return reply.code(404).send({ error: "RAG Project not found" });
    return { ok: true, deletedProject: deleted[0] };
  });

  app.post("/projects/suggest", async (request, reply) => {
    const parsed = z.object({ text: z.string().min(1), limit: z.number().int().min(1).max(10).optional().default(5) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid RAG Project suggestion request", details: parsed.error.flatten() });
    }
    return { suggestions: await suggestRagProjects(parsed.data.text, parsed.data.limit) };
  });

  app.put("/documents/:id/rag-mapping", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = mappingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid document RAG mapping", details: parsed.error.flatten() });
    }

    const [project] = await db.select().from(ragProjects).where(eq(ragProjects.id, parsed.data.ragProjectId)).limit(1);
    if (!project) return reply.code(404).send({ error: "RAG Project not found" });

    const [document] = await db
      .update(documents)
      .set({ ragProjectId: parsed.data.ragProjectId, sourceType: parsed.data.sourceType })
      .where(eq(documents.id, id))
      .returning();

    if (!document) return reply.code(404).send({ error: "Document not found" });
    return { document };
  });
}
