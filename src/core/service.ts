/**
 * ChatService — the bridge between @ce-net/sdk and the ce-chat UI.
 *
 * It owns the *data path*: subscribing to channel topics, publishing chat lines
 * and presence heartbeats, and fanning the single mesh message stream out to
 * per-channel reducers (store + presence). It depends only on a narrow
 * {@link MeshLike} port — the real adapter wraps `CeClient.mesh`, the test adapter
 * is an in-memory fake — so all of this is exercised under vitest with no node.
 *
 * The CE mesh delivers every message for every topic this node is subscribed to on
 * one stream; the service routes each frame to the channel whose topic matches and
 * drops anything that is not a ce-chat envelope.
 */

import { encodeEnvelope, makeChatMsg, makePresence, parseEnvelope } from "./protocol.ts";
import type { ChannelRef } from "./topics.ts";
import { MessageStore, type StoredMessage } from "./store.ts";
import { PresenceTracker } from "./presence.ts";

/** A delivered mesh frame, normalized from the SDK's `AppMessage`. */
export interface MeshFrame {
  from: string;
  topic: string;
  /** Decoded UTF-8 payload text. */
  text: string;
  receivedAt: number | null;
}

/** The slice of the SDK the service needs. Lets tests inject an in-memory mesh. */
export interface MeshLike {
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: Uint8Array): Promise<void>;
  /** Async iterable of inbound frames across all subscribed topics. */
  streamMessages(opts?: { signal?: AbortSignal }): AsyncIterable<MeshFrame>;
}

/** Live view of one channel: its log + its presence roster. */
export interface ChannelState {
  store: MessageStore;
  presence: PresenceTracker;
}

export interface ChatServiceEvents {
  /** A channel's message log changed (added/confirmed). */
  onMessages?: (channelId: string) => void;
  /** A channel's presence roster changed. */
  onPresence?: (channelId: string) => void;
  /** The mesh stream errored (e.g. node went away). */
  onStreamError?: (err: unknown) => void;
}

let nonceCounter = 0;
/** Author-unique message id: node id + monotonic nonce + random salt. */
export function newMessageId(selfId: string, now = Date.now()): string {
  nonceCounter = (nonceCounter + 1) % 1_000_000;
  const salt = Math.floor(Math.random() * 0xffffff).toString(16);
  return `${selfId.slice(0, 8)}-${now.toString(36)}-${nonceCounter.toString(36)}-${salt}`;
}

export class ChatService {
  private readonly channels = new Map<string, ChannelState>();
  /** topic -> channelId, so stream frames route in O(1). */
  private readonly topicIndex = new Map<string, string>();
  private readonly refs = new Map<string, ChannelRef>();
  private abort?: AbortController;
  private streaming = false;

  constructor(
    private readonly mesh: MeshLike,
    private readonly selfId: string,
    private readonly displayName: string | undefined,
    private readonly events: ChatServiceEvents = {},
  ) {}

  /** Channels currently joined. */
  joined(): ChannelRef[] {
    return [...this.refs.values()];
  }

  state(channelId: string): ChannelState | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Join a channel: subscribe to its mesh topic and wire up its reducers. Throws
   * (e.g. CeAuthError on a gated private topic) so the caller can surface it; the
   * channel is only registered locally once the subscribe succeeds.
   */
  async join(ref: ChannelRef): Promise<ChannelState> {
    const existing = this.channels.get(ref.id);
    if (existing) return existing;
    await this.mesh.subscribe(ref.topic);
    const state: ChannelState = {
      store: new MessageStore(),
      presence: new PresenceTracker(this.selfId),
    };
    this.channels.set(ref.id, state);
    this.topicIndex.set(ref.topic, ref.id);
    this.refs.set(ref.id, ref);
    // Count ourselves present immediately.
    state.presence.seen(this.selfId, this.displayName, Date.now());
    return state;
  }

  /** Leave a channel locally (we keep the node subscription; cheap to re-enter). */
  leave(channelId: string): void {
    const ref = this.refs.get(channelId);
    if (ref) this.topicIndex.delete(ref.topic);
    this.channels.delete(channelId);
    this.refs.delete(channelId);
  }

  /**
   * Send a chat line to a channel. Returns the optimistic StoredMessage (added to
   * the log immediately, flagged `pending`). On publish failure we rethrow; the
   * caller flips the message to a failed state.
   */
  async send(channelId: string, text: string): Promise<StoredMessage> {
    const ch = this.channels.get(channelId);
    const ref = this.refs.get(channelId);
    if (!ch || !ref) throw new Error(`send: not joined to ${channelId}`);
    const body = text.trim();
    if (body.length === 0) throw new Error("send: empty message");
    const now = Date.now();
    const id = newMessageId(this.selfId, now);
    const env = makeChatMsg(id, body, this.displayName, now);

    const optimistic: StoredMessage = {
      id,
      from: this.selfId,
      text: body,
      ...(this.displayName ? { name: this.displayName } : {}),
      ts: now,
      receivedAt: now,
      isSelf: true,
      pending: true,
    };
    ch.store.add(optimistic);
    ch.presence.seen(this.selfId, this.displayName, now);
    this.events.onMessages?.(channelId);

    await this.mesh.publish(ref.topic, encode(encodeEnvelope(env)));
    return optimistic;
  }

  /** Publish a presence heartbeat to a channel. Best-effort; errors are swallowed. */
  async heartbeat(channelId: string): Promise<void> {
    const ref = this.refs.get(channelId);
    if (!ref) return;
    const env = makePresence(this.displayName, Date.now());
    try {
      await this.mesh.publish(ref.topic, encode(encodeEnvelope(env)));
    } catch {
      /* heartbeats are advisory; a dropped beat just ages the member out */
    }
  }

  /** Start consuming the mesh stream and routing frames into channel reducers. */
  startStream(): void {
    if (this.streaming) return;
    this.streaming = true;
    this.abort = new AbortController();
    void this.consume(this.abort.signal);
  }

  /** Stop the stream and abort any reconnect loop. */
  stop(): void {
    this.streaming = false;
    this.abort?.abort();
    this.abort = undefined;
  }

  private async consume(signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.mesh.streamMessages({ signal })) {
        if (signal.aborted) break;
        this.route(frame);
      }
    } catch (err) {
      if (!signal.aborted) this.events.onStreamError?.(err);
    } finally {
      this.streaming = false;
    }
  }

  /** Route one inbound frame to its channel. Public for unit testing. */
  route(frame: MeshFrame): void {
    const channelId = this.topicIndex.get(frame.topic);
    if (!channelId) return; // not a channel we track
    const ch = this.channels.get(channelId);
    if (!ch) return;
    const env = parseEnvelope(frame.text);
    if (!env) return;

    const now = frame.receivedAt ?? Date.now();
    const isSelf = frame.from.toLowerCase() === this.selfId.toLowerCase();

    if (env.t === "presence") {
      ch.presence.seen(frame.from, env.name, now);
      this.events.onPresence?.(channelId);
      return;
    }

    // chat message
    ch.presence.seen(frame.from, env.name, now);
    const stored: StoredMessage = {
      id: env.id,
      from: frame.from,
      text: env.text,
      ...(env.name ? { name: env.name } : {}),
      ts: env.ts || now,
      receivedAt: now,
      isSelf,
      pending: false,
    };
    const res = ch.store.add(stored);
    if (res !== "duplicate") {
      this.events.onMessages?.(channelId);
      this.events.onPresence?.(channelId);
    }
  }
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
