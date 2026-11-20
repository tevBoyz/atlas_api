/** How long a revocation is remembered; a join check older than this is refused as stale. */
export const REVOCATION_MEMORY_MS = 10 * 60_000;

/** A point in the log, taken before a join's access check. */
export interface RevocationMark {
  seq: number;
  at: number;
}

/**
 * Closes the race between a join's access check and a membership end (API-100-40 AC3), on one
 * instance. A join takes a {@link mark} before it reads the database; a membership end is recorded
 * here when this instance learns of it, which is always after that end committed. If the end of the
 * same user's membership of the same circle was recorded after the mark, the check may have read the
 * row before the end committed, so the join is refused; a later join reads the committed state. An end
 * recorded before the mark had committed before the check began, so the check already saw it. An end
 * learned after the join completed takes the socket out of the room like any other joined socket.
 */
export class RevocationLog {
  private seq = 0;
  private readonly entries = new Map<string, RevocationMark>();

  constructor(private readonly now: () => number = Date.now) {}

  mark(): RevocationMark {
    return { seq: this.seq, at: this.now() };
  }

  record(userId: string, circleId: string): void {
    this.seq += 1;
    const at = this.now();
    const entryKey = key(userId, circleId);
    // Re-inserted at the end, so the map stays in time order for prune().
    this.entries.delete(entryKey);
    this.entries.set(entryKey, { seq: this.seq, at });
    this.prune(at);
  }

  /** True when the join that took `mark` must be refused for this user and circle. */
  revokedSince(userId: string, circleId: string, mark: RevocationMark): boolean {
    // A check this slow can no longer be compared with forgotten entries: refuse it.
    if (this.now() - mark.at > REVOCATION_MEMORY_MS) return true;
    const entry = this.entries.get(key(userId, circleId));
    return entry !== undefined && entry.seq > mark.seq;
  }

  /** Entries kept (tests). */
  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [entryKey, entry] of this.entries) {
      if (now - entry.at <= REVOCATION_MEMORY_MS) break; // insertion order = time order
      this.entries.delete(entryKey);
    }
  }
}

function key(userId: string, circleId: string): string {
  return `${userId}|${circleId}`;
}
