import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage, ulid } from '@gathernet/shared'
import WebSocket from 'ws'

/** Minimal protocol-aware WS client for integration tests. */
export class TestWsClient {
  readonly received: ServerMessage[] = []
  private cursor = 0

  private constructor(readonly socket: WebSocket) {}

  static async connect(port: number, token: string): Promise<TestWsClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    const client = new TestWsClient(socket)
    socket.on('message', (data) => {
      const parsed = parseServerMessage(data.toString())
      if (parsed.ok) client.received.push(parsed.message)
    })
    socket.send(
      JSON.stringify({
        type: 'hello',
        id: ulid(),
        payload: { token, protocolVersion: PROTOCOL_VERSION },
      }),
    )
    const hello = await client.waitFor((m) => m.type === 'hello.ok' || m.type === 'hello.error')
    if (hello.type !== 'hello.ok') throw new Error(`hello failed: ${JSON.stringify(hello)}`)
    return client
  }

  send(type: string, payload: unknown): string {
    const id = ulid()
    this.socket.send(JSON.stringify({ type, id, payload }))
    return id
  }

  /** Waits for the next not-yet-consumed message matching the predicate. */
  async waitFor(
    predicate: (m: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      while (this.cursor < this.received.length) {
        // biome-ignore lint/style/noNonNullAssertion: cursor bounds-checked
        const message = this.received[this.cursor++]!
        if (predicate(message)) return message
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(
      `timeout waiting for message; received: ${this.received.map((m) => m.type).join(', ')}`,
    )
  }

  /** Asserts no matching message arrives within the window. */
  async expectSilence(predicate: (m: ServerMessage) => boolean, windowMs = 300): Promise<void> {
    const start = this.cursor
    await new Promise((resolve) => setTimeout(resolve, windowMs))
    for (let i = start; i < this.received.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index bounds-checked
      const message = this.received[i]!
      if (predicate(message)) {
        throw new Error(`expected silence but got: ${JSON.stringify(message)}`)
      }
    }
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      const closed = new Promise<void>((resolve) => this.socket.once('close', () => resolve()))
      this.socket.close()
      await closed
    }
  }
}
