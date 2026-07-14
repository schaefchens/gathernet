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
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env)
}
