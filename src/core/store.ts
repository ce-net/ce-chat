/**
 * Per-channel message log.
 *
 * Mesh pubsub is at-least-once and unordered: the same message can arrive twice
 * (e.g. on resubscribe, or echoed back to the sender), and messages from different
 * authors arrive interleaved. The store therefore:
 *
 *   - dedupes by envelope id (an author-unique key),
 *   - keeps a stable arrival order for messages we have already accepted,
 *   - sorts only by (author timestamp, id) as a tiebreak for *display*, never
 *     re-sorting accepted history out from under the reader,
 *   - bounds memory with a ring cap (recent history only — this is chat, not an
 *     archive; durable history is a separate concern).
 */

/** A message as held in the store and rendered by the UI. */
export interface StoredMessage {
  id: string;
  from: string;
  text: string;
  name?: string;
  /** Author-side timestamp (ms). Advisory. */
  ts: number;
  /** Local arrival time (ms). Monotone within this session. */
  receivedAt: number;
  /** True if authored by our own node. */
  isSelf: boolean;
  /** True until the mesh confirms our own message came back (optimistic send). */
  pending?: boolean;
}

/** Default cap on retained messages per channel. */
export const DEFAULT_HISTORY_CAP = 500;

export class MessageStore {
  private readonly byId = new Map<string, StoredMessage>();
  /** Insertion order of accepted ids. */
  private order: string[] = [];

  constructor(private readonly cap: number = DEFAULT_HISTORY_CAP) {}

  /**
   * Add or reconcile a message. Returns:
   *   "added"      first time we have seen this id
   *   "confirmed"  this id existed as a pending self-message and is now confirmed
   *   "duplicate"  already present and not a pending->confirmed transition
   */
  add(m: StoredMessage): "added" | "confirmed" | "duplicate" {
    const existing = this.byId.get(m.id);
    if (existing) {
      if (existing.pending && !m.pending) {
        // Our optimistic message echoed back from the mesh: clear pending,
        // keep its original slot/order so it doesn't jump.
        this.byId.set(m.id, { ...existing, pending: false, receivedAt: m.receivedAt });
        return "confirmed";
      }
      return "duplicate";
    }
    this.byId.set(m.id, m);
    this.order.push(m.id);
    this.evict();
    return "added";
  }

  /** Mark a previously-added optimistic message as failed-to-send (kept, flagged). */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Messages in display order: by author ts, then id. Stable. */
  list(): StoredMessage[] {
    const out = this.order.map((id) => this.byId.get(id)).filter((m): m is StoredMessage => !!m);
    out.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return out;
  }

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.order = [];
  }

  private evict(): void {
    while (this.order.length > this.cap) {
      const id = this.order.shift();
      if (id !== undefined) this.byId.delete(id);
    }
  }
}
