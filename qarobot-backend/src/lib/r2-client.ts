import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { requireEnv } from "./config.js";

export function createR2Client() {
  const accountId = requireEnv("R2_ACCOUNT_ID");

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

export async function uploadR2Object(params: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
  const client = createR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: requireEnv("R2_BUCKET_NAME"),
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
}

export async function downloadR2Object(key: string) {
  const client = createR2Client();
  const result = await client.send(
    new GetObjectCommand({
      Bucket: requireEnv("R2_BUCKET_NAME"),
      Key: key,
    }),
  );

  if (!result.Body) {
    throw new Error(`R2 object ${key} had no body`);
  }

  const bytes = await result.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteR2Object(key: string) {
  const client = createR2Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: requireEnv("R2_BUCKET_NAME"),
      Key: key,
    }),
  );
}
