import { z } from 'zod'

const envSchema = z.object({
  SERVER_PORT: z.coerce.number().int().default(4000),
  SERVER_HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().default('postgres://gathernet:gathernet_dev@localhost:55432/gathernet'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // S3-compatible object storage (RustFS in dev). The server is the ONLY client —
  // the browser never talks to it. Standard S3 API only, so the backend is swappable.
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default('gathernet'),
  S3_SECRET_KEY: z.string().default('gathernet_dev_secret'),
  S3_BUCKET: z.string().default('gathernet-media'),
  // Web Push (VAPID). Dev defaults are a throwaway keypair; production MUST override.
  // The server only ever composes a category code — never message content.
  VAPID_PUBLIC_KEY: z
    .string()
    .default(
      'BAM0GzCvAlsOeeAOCs7Irl17MEVHSvtU2YnY23RW__Uiw7CquoIqW-oBSKPnQEf1R1GGMrogxEitELhnPsUHPU4',
    ),
  VAPID_PRIVATE_KEY: z.string().default('FNwORbaQdHtqQHYJY9DJ4HF5oRHt6g_esvM9IlxI1BQ'),
  VAPID_SUBJECT: z.string().default('mailto:dev@gathernet.local'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env)
}
