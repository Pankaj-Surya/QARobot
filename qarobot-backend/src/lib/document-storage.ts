import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { deleteR2Object, downloadR2Object, uploadR2Object } from "./r2-client.js";

export type DocumentStorageDriver = "local" | "r2";

export function getDocumentStorageDriver(): DocumentStorageDriver {
  return process.env.DOCUMENT_STORAGE_DRIVER === "r2" ? "r2" : "local";
}

export async function uploadDocumentObject(params: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
  if (getDocumentStorageDriver() === "r2") {
    await uploadR2Object(params);
    return;
  }

  const targetPath = getLocalDocumentPath(params.key);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, params.body);
}

export async function downloadDocumentObject(key: string) {
  if (getDocumentStorageDriver() === "r2") {
    return downloadR2Object(key);
  }

  return readFile(getLocalDocumentPath(key));
}

export async function deleteDocumentObject(key: string) {
  if (getDocumentStorageDriver() === "r2") {
    await deleteR2Object(key);
    return;
  }

  await rm(getLocalDocumentPath(key), { force: true });
}

function getLocalDocumentPath(key: string) {
  const storageRoot = process.env.LOCAL_DOCUMENT_STORAGE_DIR || "documents";
  const normalizedKey = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  const basePath = join(process.cwd(), storageRoot);
  const targetPath = join(basePath, normalizedKey.replace(/^documents(\/|\\)/, ""));

  if (!targetPath.startsWith(basePath)) {
    throw new Error("Invalid local document storage key");
  }

  return targetPath;
}
