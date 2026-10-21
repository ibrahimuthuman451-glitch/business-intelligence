import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { AppError } from "./errors";
import type { StorageDriver } from "./storage-types";

export type S3Config = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /** Optional. Supabase/R2 reject the SSE header; AWS encrypts by default. */
  serverSideEncryption?: string | null;
};

/**
 * Private S3-compatible object storage. Objects are never made public and no
 * permanent URL is generated: downloads always stream through the authorized
 * application route. SSE-AES256 is requested when the provider supports it.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly serverSideEncryption: string | null;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.serverSideEncryption = config.serverSideEncryption?.trim() || null;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? true,
      // Supabase/R2 do not implement all checksum headers; only send when required.
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(key: string, bytes: Buffer, contentType?: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ...(this.serverSideEncryption
            ? { ServerSideEncryption: this.serverSideEncryption as "AES256" }
            : {}),
        }),
      );
    } catch (error) {
      console.error("Object storage put failed", error instanceof Error ? error.message : "unknown");
      throw new AppError("The document could not be stored", 502, "storage_unavailable");
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) throw new AppError("The stored file is unavailable", 404, "document_missing");
      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const name = (error as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") {
        throw new AppError("The stored file is unavailable", 404, "document_missing");
      }
      console.error("Object storage get failed", error instanceof Error ? error.message : "unknown");
      throw new AppError("The stored file is unavailable", 502, "storage_unavailable");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      console.error("Object storage delete failed", error instanceof Error ? error.message : "unknown");
    }
  }

  async list(prefix: string): Promise<{ key: string; sizeBytes: number }[]> {
    const results: { key: string; sizeBytes: number }[] = [];
    let token: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key) results.push({ key: object.Key, sizeBytes: object.Size ?? 0 });
      }
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
    return results;
  }
}
