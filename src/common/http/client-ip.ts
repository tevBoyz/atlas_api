import { isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

import type { TrustProxy } from '../../config';

/** Used when neither the header nor the socket gives an address. */
export const UNKNOWN_CLIENT_IP = 'unknown';

/** TRUST_PROXY is on for `true`, a hop count above 0, or a list of proxies. */
export function isTrustProxyOn(trustProxy: TrustProxy): boolean {
  return trustProxy !== false && trustProxy !== 0;
}

/** `::ffff:192.0.2.1` → `192.0.2.1`, so one client has one spelling. */
function normalize(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return (mapped ? mapped[1] : address).toLowerCase();
}

function firstForwardedFor(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const first = value?.split(',')[0]?.trim();
  return first && isIP(first) !== 0 ? normalize(first) : undefined;
}

/**
 * The client address (API-100-11 AC3): the first `x-forwarded-for` value only when TRUST_PROXY is
 * on, otherwise the socket address. A first value that is not an IP address is ignored.
 *
 * The first value is whatever the client sent unless the proxy in front overwrites the header, so
 * production must run behind a proxy that does (see README, Rate limiting).
 */
export function clientIp(request: FastifyRequest, trustProxy: TrustProxy): string {
  if (isTrustProxyOn(trustProxy)) {
    const forwarded = firstForwardedFor(request.headers['x-forwarded-for']);
    if (forwarded) return forwarded;
  }
  const socketAddress = request.raw.socket?.remoteAddress;
  return socketAddress ? normalize(socketAddress) : UNKNOWN_CLIENT_IP;
}
