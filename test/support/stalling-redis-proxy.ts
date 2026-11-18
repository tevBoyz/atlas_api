import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * A TCP proxy in front of this worker's Redis that can stop forwarding replies, to simulate a slow
 * Redis for one app only (`CLIENT PAUSE` would stall every worker sharing the container).
 */
export class StallingRedisProxy {
  stalled = false;
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly held: Array<() => void> = [];

  /** Starts the proxy. Returns a redis:// URL for the same logical database. */
  async start(targetUrl: string): Promise<string> {
    const target = new URL(targetUrl);
    this.server = createServer((client) => {
      const upstream = createConnection(Number(target.port), target.hostname);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => this.sockets.delete(socket));
      }
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.pipe(upstream);
      upstream.on('data', (chunk) => {
        if (this.stalled) this.held.push(() => client.write(chunk));
        else client.write(chunk);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `redis://127.0.0.1:${port}${target.pathname}`;
  }

  /** Delivers the held replies and forwards normally again. */
  resume(): void {
    this.stalled = false;
    for (const deliver of this.held.splice(0)) deliver();
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
