import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { loadLocalEnv } from "../lib/env.js";
import * as schema from "./schema.js";

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(process.env.DATABASE_URL);

export const db = drizzle(sql, { schema });
