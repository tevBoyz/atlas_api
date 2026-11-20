import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { io, type Socket } from 'socket.io-client';

import { REALTIME_NAMESPACE, REALTIME_PATH } from '../../src/realtime/realtime.constants';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  errorLogLines,
  every,
  failures,
  request,
  type StartedApp,
  stats,
  table,
  withLoadStack,
} from './load-harness';

/**
 * `npm run build && npm run load:realtime [-- --incidents <n>] [--members <n>] [--duration <s>]
 *  [--out <file.json>]` (API-100-43 AC3).
 *
 * Realtime load check against the BUILT app, two instances on one database and one Redis (the
 * Socket.IO Redis adapter), through the shared harness (`load-harness.ts`: throwaway containers,
 * random ports and JWT secret, default settings and rate limits, nothing from `.env`).
 *
 * 1. Seeds `--incidents` (default 40) residents, each with a circle of `--members` (default 4) active
 *    members: 200 users by default, one socket each.
 * 2. Starts two app instances. Every resident submits an SOS (alternating instances); every socket
 *    connects to `/v1/realtime` on alternating instances (so each incident's room spans both) and
 *    joins its incident.
 * 3. Steady state for `--duration` seconds (default 180): each resident posts a location every 12 s
 *    (staggered start), alternating the instance it posts to.
 * 4. Every resident marks safe; every socket must receive `incident.resolved`.
 * 5. Checks: every socket received exactly one `incident.location` and one `incident.updated` per
 *    accepted ping of its own incident (none lost, none duplicated, by `location_captured_at`), and
 *    no event of any other incident; no request failed; neither instance logged an error. Prints the
 *    event delivery latency (ping request start to arrival) and the REST p50/p95/p99.
 *
 * Exit code 1 on any lost, duplicated or foreign event, any failed request, or any app error log line.
 */

interface Options {
  incidents: number;
  members: number;
  durationSeconds: number;
  pingSeconds: number;
  out?: string;
}

function parseOptions(argv: string[]): Options {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const int = (flag: string, fallback: number, min: number) => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}`);
    return n;
  };
  return {
    incidents: int('--incidents', 40, 1),
    members: int('--members', 4, 1),
    durationSeconds: int('--duration', 180, 12),
    pingSeconds: 12,
    out: value('--out'),
  };
}

interface Listener {
  user: UserFixture;
  socket: Socket;
  /** `incident.location` / `incident.updated` received: [event, incident_id, captured_at, at ms]. */
  events: { event: string; incidentId: string; capturedAt: unknown; at: number }[];
  resolved: string[];
  other: string[];
}

interface Party {
  resident: UserFixture;
  members: UserFixture[];
  incidentId?: string;
  /** location_captured_at of every accepted ping → request start (ms). */
  pings: Map<string, number>;
}

const percentile = (sorted: number[], q: number) =>
  sorted.length === 0
    ? NaN
    : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

async function connect(url: string, token: string, user: UserFixture): Promise<Listener> {
  const socket = io(`${url}${REALTIME_NAMESPACE}`, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { token },
  });
  const listener: Listener = { user, socket, events: [], resolved: [], other: [] };
  socket.onAny(
    (event: string, payload: { incident_id?: string; location_captured_at?: unknown }) => {
      const at = performance.now();
      if (event === 'incident.location') {
        listener.events.push({
          event,
          incidentId: String(payload.incident_id),
          capturedAt: payload.location_captured_at,
          at,
        });
      } else if (event === 'incident.updated') {
        const incident = (payload as { incident?: { location_captured_at?: unknown } }).incident;
        listener.events.push({
          event,
          incidentId: String(payload.incident_id),
          capturedAt: incident?.location_captured_at,
          at,
        });
      } else if (event === 'incident.resolved') {
        listener.resolved.push(String(payload.incident_id));
      } else if (event !== 'incident.delivery_counts' && event !== 'incident.event') {
        listener.other.push(event);
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
  return listener;
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2));
  return withLoadStack(async ({ client, token, startApp }) => {
    process.stderr.write(
      `Seeding ${o.incidents} residents with ${o.members} members each (${o.incidents * (o.members + 1)} sockets)...\n`,
    );
    const parties: Party[] = [];
    for (let i = 0; i < o.incidents; i++) {
      const resident = await createUser(client, { fullName: `Load Resident ${i}` });
      const circle = await createCircle(client, resident);
      const members: UserFixture[] = [];
      for (let m = 0; m < o.members; m++) {
        const member = await createUser(client, { fullName: `Load Member ${i}-${m}` });
        await addActiveMember(client, circle, member);
        members.push(member);
      }
      parties.push({ resident, members, pings: new Map() });
    }

    const apps: StartedApp[] = [await startApp({}), await startApp({})];
    const urlOf = (n: number) => apps[n % 2].url;

    // Submit (alternating instances).
    await Promise.all(
      parties.map(async (party, i) => {
        const body = await request(
          'POST /v1/incidents',
          'POST',
          '/v1/incidents',
          await token(party.resident.id),
          201,
          { body: { emergency_type: 'medical' }, idempotent: true, baseUrl: urlOf(i) },
        );
        if (body) party.incidentId = String(body.id);
      }),
    );

    // Connect and join (alternating instances, so every room spans both).
    const listeners: { party: Party; listener: Listener }[] = [];
    let n = 0;
    const joinStarted = performance.now();
    for (const party of parties) {
      for (const user of [party.resident, ...party.members]) {
        const listener = await connect(urlOf(n++), await token(user.id), user);
        listeners.push({ party, listener });
      }
    }
    const joins = await Promise.all(
      listeners.map(({ party, listener }) =>
        listener.socket
          .timeout(10_000)
          .emitWithAck('incident.join', { incident_id: party.incidentId })
          .then((ack: { ok: boolean }) => ack.ok)
          .catch(() => false),
      ),
    );
    const joinMs = performance.now() - joinStarted;
    const refusedJoins = joins.filter((ok) => !ok).length;
    // Let the submit broadcasts drain before counting.
    await sleep(1_000);
    for (const { listener } of listeners) listener.events.length = 0;

    // Steady state: one ping per incident every 12 s, staggered, alternating instances.
    process.stderr.write(`Steady state for ${o.durationSeconds} s...\n`);
    const stopAt = performance.now() + o.durationSeconds * 1000;
    await Promise.all(
      parties.map(async (party, i) => {
        await sleep(((o.pingSeconds * 1000) / parties.length) * i);
        const rt = await token(party.resident.id);
        let k = 0;
        await every(o.pingSeconds, stopAt, async () => {
          const capturedAt = new Date().toISOString();
          const started = performance.now();
          const body = await request(
            'POST /v1/incidents/:id/locations',
            'POST',
            `/v1/incidents/${party.incidentId}/locations`,
            rt,
            200,
            {
              baseUrl: urlOf(i + k++),
              body: {
                location_source: 'current',
                location_lat: 13.45 + Math.random() / 100,
                location_lng: -16.58 + Math.random() / 100,
                location_accuracy_m: 5 + Math.random() * 20,
                location_captured_at: capturedAt,
              },
            },
          );
          if (body) party.pings.set(String(body.location_captured_at), started);
        });
      }),
    );
    // Allow in-flight broadcasts to arrive.
    await sleep(2_000);

    // Steady-state events end here: the close below sends one more incident.updated per socket.
    const steady = new Map(listeners.map(({ listener }) => [listener, [...listener.events]]));

    // Close every incident.
    await Promise.all(
      parties.map(async (party, i) =>
        request(
          'POST /v1/incidents/:id/mark-safe',
          'POST',
          `/v1/incidents/${party.incidentId}/mark-safe`,
          await token(party.resident.id),
          200,
          { idempotent: true, baseUrl: urlOf(i) },
        ),
      ),
    );
    await sleep(2_000);

    // Checks.
    let lost = 0;
    let duplicated = 0;
    let foreign = 0;
    let unresolved = 0;
    const latencies: number[] = [];
    for (const { party, listener } of listeners) {
      for (const event of ['incident.location', 'incident.updated']) {
        const own = (steady.get(listener) ?? []).filter((e) => e.event === event);
        foreign += own.filter((e) => e.incidentId !== party.incidentId).length;
        const seen = new Map<string, number>();
        for (const e of own.filter((x) => x.incidentId === party.incidentId)) {
          const key = String(e.capturedAt);
          seen.set(key, (seen.get(key) ?? 0) + 1);
          const started = party.pings.get(key);
          if (event === 'incident.location' && started !== undefined) {
            latencies.push(e.at - started);
          }
        }
        for (const capturedAt of party.pings.keys()) {
          const count = seen.get(capturedAt) ?? 0;
          if (count === 0) lost++;
          if (count > 1) duplicated += count - 1;
        }
        // An event for a ping that was not accepted would be foreign too.
        for (const key of seen.keys()) if (!party.pings.has(key)) foreign++;
      }
      if (!listener.resolved.includes(String(party.incidentId))) unresolved++;
      foreign += listener.resolved.filter((id) => id !== party.incidentId).length;
      foreign += listener.other.length;
    }
    for (const { listener } of listeners) listener.socket.close();
    for (const app of apps) await app.stop();
    const appErrors = apps.flatMap((app) => errorLogLines(app.logFile));

    const pings = parties.reduce((sum, party) => sum + party.pings.size, 0);
    latencies.sort((a, b) => a - b);
    const result = {
      sockets: listeners.length,
      instances: apps.length,
      incidents: parties.length,
      duration_seconds: o.durationSeconds,
      join_ms_total: Math.round(joinMs),
      refused_joins: refusedJoins,
      accepted_pings: pings,
      expected_location_events: pings * (o.members + 1),
      received_location_events: latencies.length,
      lost_events: lost,
      duplicated_events: duplicated,
      foreign_events: foreign,
      sockets_without_resolved: unresolved,
      delivery_ms: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: latencies[latencies.length - 1],
      },
      failed_requests: failures,
      app_error_log_lines: appErrors,
      routes: stats(),
    };
    process.stdout.write(`${table(stats())}\n\n`);
    const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
    process.stdout.write(
      [
        `sockets ${result.sockets} on ${result.instances} instances, ${result.incidents} incidents, ${result.duration_seconds} s`,
        `joins: ${listeners.length - refusedJoins} ok, ${refusedJoins} refused (${result.join_ms_total} ms for all)`,
        `pings accepted: ${pings}; incident.location expected ${result.expected_location_events}, received ${result.received_location_events}`,
        `lost ${lost}, duplicated ${duplicated}, foreign ${foreign}, sockets without incident.resolved ${unresolved}`,
        `delivery ms (ping request start to event): p50 ${f(result.delivery_ms.p50)}, p95 ${f(result.delivery_ms.p95)}, p99 ${f(result.delivery_ms.p99)}, max ${f(result.delivery_ms.max)}`,
        `failed requests ${failures.length}, app error log lines ${appErrors.length}`,
      ].join('\n') + '\n',
    );
    if (o.out) writeFileSync(o.out, JSON.stringify(result, null, 2));
    const ok =
      refusedJoins === 0 &&
      lost === 0 &&
      duplicated === 0 &&
      foreign === 0 &&
      unresolved === 0 &&
      failures.length === 0 &&
      appErrors.length === 0 &&
      result.received_location_events === result.expected_location_events;
    process.stdout.write(ok ? 'REALTIME LOAD CHECK PASSED\n' : 'REALTIME LOAD CHECK FAILED\n');
    return ok ? 0 : 1;
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
