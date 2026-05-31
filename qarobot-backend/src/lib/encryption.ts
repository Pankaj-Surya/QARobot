import crypto from "node:crypto";
import { requireEnv } from "./config.js";

const algorithm = "aes-256-gcm";

function key() {
  const raw = requireEnv("ENCRYPTION_KEY");
  const decoded = Buffer.from(raw, "base64");

  if (decoded.byteLength !== 32) {
    throw new Error("ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  return decoded;
}

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  const decipher = crypto.createDecipheriv(algorithm, key(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
