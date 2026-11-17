import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type CryptoKey, exportJWK, generateKeyPair, type JWK } from 'jose';

/** A locally generated signing key with its public JWK (test-only). */
export interface LocalSigningKey {
  kid: string;
  alg: 'ES256' | 'RS256';
  privateKey: CryptoKey;
  jwk: JWK;
}

export async function generateSigningKey(
  kid: string,
  alg: 'ES256' | 'RS256' = 'ES256',
): Promise<LocalSigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey, jwk };
}

/**
 * A JWKS endpoint on 127.0.0.1 (random port) for verifier tests (API-100-08 AC6). Serves the
 * public keys currently in {@link keys}; counts fetches. Never a real Supabase project.
 */
export class LocalJwksServer {
  keys: JWK[] = [];
  fetches = 0;
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer((_req, res) => {
      this.fetches += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: this.keys }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/auth/v1/.well-known/jwks.json`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
