import { v2 as cloudinary } from "cloudinary";
import { requireEnv } from "./config.js";

type UploadParams = {
  key: string;
  body: Buffer;
  contentType: string;
};

function configureCloudinary() {
  requireEnv("CLOUDINARY_URL");
  cloudinary.config({ secure: true });
}

export async function uploadCloudinaryObject(params: UploadParams) {
  configureCloudinary();

  await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: normalizePublicId(params.key),
        resource_type: "raw",
        overwrite: true,
        type: "upload",
        context: {
          content_type: params.contentType,
        },
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      },
    );

    stream.end(params.body);
  });
}

export async function downloadCloudinaryObject(key: string) {
  configureCloudinary();
  const publicId = normalizePublicId(key);
  const url = cloudinary.url(publicId, {
    resource_type: "raw",
    secure: true,
    type: "upload",
  });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Cloudinary download failed with ${response.status}: ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function deleteCloudinaryObject(key: string) {
  configureCloudinary();
  await cloudinary.uploader.destroy(normalizePublicId(key), {
    resource_type: "raw",
    type: "upload",
    invalidate: true,
  });
}

function normalizePublicId(key: string) {
  return key.replace(/^\/+/, "").replace(/\\/g, "/");
}
