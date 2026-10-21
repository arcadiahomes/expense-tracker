import "server-only";
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageDriver } from "./index";

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO). The bucket must be
 * private: nothing is uploaded with a public ACL, objects are encrypted at rest, and
 * reads go through presigned GETs that expire in minutes. Credentials come from the
 * standard AWS environment variables or the runtime's role, never from the client.
 */
export function s3StorageDriver({ bucket, region, endpoint }: { bucket: string; region: string; endpoint?: string }): StorageDriver {
  const client = new S3Client({ region, endpoint, forcePathStyle: !!endpoint });
  return {
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          // R2 and MinIO encrypt by default and may reject this header; AWS needs it to be explicit.
          ...(endpoint ? {} : { ServerSideEncryption: "AES256" as const }),
          CacheControl: "private, no-store",
        }),
      );
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return res.Body ? new Uint8Array(await res.Body.transformToByteArray()) : null;
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async signedUrl(key, opts) {
      const name = opts.fileName.replace(/[^\w.\- ]/g, "_");
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentType: opts.contentType,
          ResponseContentDisposition: `${opts.disposition}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`,
          ResponseCacheControl: "private, no-store",
        }),
        { expiresIn: opts.expiresIn },
      );
    },
  };
}
