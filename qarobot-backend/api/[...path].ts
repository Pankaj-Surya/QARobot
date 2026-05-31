import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

let appPromise: Promise<FastifyInstance> | null = null;

async function getApp() {
  appPromise ||= buildApp().then(async (app) => {
    await app.ready();
    return app;
  });
  return appPromise;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const app = await getApp();
  app.server.emit("request", request, response);
}
