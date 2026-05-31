import { Redis } from "@upstash/redis";
import { Index } from "@upstash/vector";
import { requireEnv } from "./config.js";

export function createRedisClient() {
  return new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });
}

export function createVectorIndex() {
  return new Index({
    url: requireEnv("UPSTASH_VECTOR_REST_URL"),
    token: requireEnv("UPSTASH_VECTOR_REST_TOKEN"),
  });
}
