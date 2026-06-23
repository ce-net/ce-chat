/**
 * ce-chat wire protocol.
 *
 * Every payload that travels over a CE mesh pubsub topic is a UTF-8 JSON envelope.
 * The mesh layer already authenticates the sender (the node signs each published
 * message and reports `from` = the origin node id), so the envelope carries no
 * signature of its own — it is pure application content. We keep it small and
 * forward-compatible: unknown `t` values are ignored by the reducer, and unknown
 * fields are preserved on decode-then-re-encode is never required.
 *
 * Two envelope kinds today:
 *   - `msg`       a chat line in a channel or DM
 *   - `presence`  a periodic heartbeat announcing "I am here, in these channels"
 */

/** Protocol version. Bump only on a breaking envelope change. */
export const PROTOCOL_VERSION = 1 as const;

/** A chat line. */
export interface ChatMsg {
  t: "msg";
  v: number;
  /** Client-generated unique id (origin node id + nonce), used for dedupe. */
  id: string;
  /** UTF-8 body text. Trimmed, length-capped before send. */
  text: string;
  /** Author's display name (optional; falls back to short node id in the UI). */
  name?: string;
  /** Author-side wall-clock millis. Advisory only — never trusted for ordering across nodes. */
  ts: number;
}

/** A presence heartbeat. */
export interface PresenceMsg {
  t: "presence";
  v: number;
  /** Author's chosen display name. */
  name?: string;
  /** Author-side wall-clock millis. */
  ts: number;
}

export type Envelope = ChatMsg | PresenceMsg;

/** Max body length we will send (and the reducer will accept). */
export const MAX_TEXT_LEN = 4000;

/** Build a chat envelope. `id` should be unique per (author, message). */
export function makeChatMsg(id: string, text: string, name: string | undefined, ts: number): ChatMsg {
  return { t: "msg", v: PROTOCOL_VERSION, id, text, ...(name ? { name } : {}), ts };
}

/** Build a presence envelope. */
export function makePresence(name: string | undefined, ts: number): PresenceMsg {
  return { t: "presence", v: PROTOCOL_VERSION, ...(name ? { name } : {}), ts };
}

/**
 * Parse a decoded payload string into an Envelope, or return null if it is not a
 * valid ce-chat envelope. Never throws — malformed bytes on a shared topic are
 * expected (other apps may use the mesh) and must be dropped quietly.
 */
export function parseEnvelope(raw: string): Envelope | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o["t"] !== "string") return null;
  const ts = typeof o["ts"] === "number" && Number.isFinite(o["ts"]) ? o["ts"] : 0;
  const name = typeof o["name"] === "string" ? o["name"] : undefined;

  if (o["t"] === "msg") {
    if (typeof o["id"] !== "string" || o["id"].length === 0) return null;
    if (typeof o["text"] !== "string") return null;
    const text = o["text"].slice(0, MAX_TEXT_LEN);
    return { t: "msg", v: PROTOCOL_VERSION, id: o["id"], text, ...(name ? { name } : {}), ts };
  }
  if (o["t"] === "presence") {
    return { t: "presence", v: PROTOCOL_VERSION, ...(name ? { name } : {}), ts };
  }
  return null;
}

/** Serialize an envelope to a UTF-8 JSON string (ready to be turned into bytes). */
export function encodeEnvelope(e: Envelope): string {
  return JSON.stringify(e);
}
