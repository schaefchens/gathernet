import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { TestProject } from 'vitest/node'

let container: StartedPostgreSqlContainer

declare module 'vitest' {
  export interface ProvidedContext {
    pgUri: string
  }
}

export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:17-alpine').start()
  project.provide('pgUri', container.getConnectionUri())
  return async () => {
    await container.stop()
  }
}
