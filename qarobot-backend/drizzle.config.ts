import { defineConfig } from "drizzle-kit";
import { loadLocalEnv } from "./src/lib/env.js";

loadLocalEnv();

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});
