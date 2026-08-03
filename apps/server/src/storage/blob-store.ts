/**
 * Object storage for encrypted media blobs (ciphertext ONLY — the per-file key lives
 * in the E2EE message body and never reaches the server or the store). The browser
 * NEVER talks to the store; our server is the sole client + proxy, so the store is
 * not an externally reachable attack surface.
 *
 * Only the portable S3 verbs (Put/Get/Delete/Head) are used, so the backend can be
 * swapped for any S3-compatible service in production. Tests inject the in-memory
 * implementation (no container needed).
 */

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

export interface BlobStore {
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>
  /** Returns the bytes, or null if the object doesn't exist. */
  get(key: string): Promise<Buffer | null>
  delete(key: string): Promise<void>
}

export interface S3Config {
  endpoint: string
  region: string
  accessKey: string
  secretKey: string
  bucket: string
}

/** S3-compatible backend (RustFS in dev; any S3 service in prod). Path-style. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      // RustFS (and most self-hosted S3) is path-style unless a domain is configured.
      forcePathStyle: true,
    })
  }

  /** Create the bucket if it doesn't exist yet (idempotent) — call once on boot. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
      } catch {
        // A concurrent creator won the race, or it already exists — fine.
      }
    }
  }

  async put(key: string, bytes: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    )
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      if (!res.Body) return null
      const bytes = await res.Body.transformToByteArray()
      return Buffer.from(bytes)
    } catch (err) {
      if (err instanceof NoSuchKey) return null
      // Some S3 impls surface a NotFound with a different name.
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'NotFound') {
        return null
      }
      throw err
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}

/** In-memory backend for tests — no network, no container. */
export class InMemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Buffer>()

  put(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(bytes))
    return Promise.resolve()
  }

  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.objects.get(key) ?? null)
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key)
    return Promise.resolve()
  }
}
