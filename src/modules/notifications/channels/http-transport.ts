import { connect, type ClientHttp2Session, constants } from 'node:http2';

/**
 * The HTTP seam of the real channel adapters (API-100-46). Adapters only build requests and read
 * answers; the transport moves bytes. Unit tests give the adapters a fake transport, so no test can
 * ever reach a provider (as `SupabaseAvatarStorage` with its fake fetch).
 */
export interface HttpRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpTransport {
  /** Rejects on a network failure or timeout (the adapter turns that into a `failed` result). */
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** HTTPS through `fetch` (FCM, Google OAuth, Twilio). */
export class FetchTransport implements HttpTransport {
  constructor(private readonly timeoutMs: number) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  }
}

/**
 * HTTP/2 (APNs only speaks HTTP/2). One session per origin, opened on first use and reopened after
 * it closes.
 */
export class Http2Transport implements HttpTransport {
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(private readonly timeoutMs: number) {}

  request(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    const session = this.session(url.origin);
    return new Promise((resolve, reject) => {
      const stream = session.request({
        [constants.HTTP2_HEADER_METHOD]: request.method,
        [constants.HTTP2_HEADER_PATH]: `${url.pathname}${url.search}`,
        ...request.headers,
      });
      stream.setTimeout(this.timeoutMs, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        reject(new Error('http2 request timed out'));
      });
      const headers: Record<string, string> = {};
      let status = 0;
      stream.on('response', (incoming) => {
        status = Number(incoming[constants.HTTP2_HEADER_STATUS]);
        for (const [key, value] of Object.entries(incoming)) {
          if (typeof value === 'string') headers[key] = value;
        }
      });
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks).toString() }));
      stream.on('error', reject);
      stream.end(request.body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private session(origin: string): ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(origin);
    session.on('error', () => this.sessions.delete(origin));
    session.on('close', () => this.sessions.delete(origin));
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }
}
