/**
 * Real SDK adapter: wraps a live `CeClient` into the narrow ports the app's core
 * logic depends on. This is the ONLY module that imports @ce-net/sdk for the data
 * path, so the rest of the app (and all unit tests) stays SDK-agnostic.
 */

import { CeClient, bytesToUtf8, connectNode } from "@ce-net/sdk";
import type { MeshLike, MeshFrame } from "./service.ts";

/**
 * Sentinel for "use the mesh-native transport". When no explicit override URL is
 * configured, ce-chat talks to its local node over the SAME-ORIGIN rail
 * ({@link connectNode}: the in-tab `window.__ceNode` bridge if present, else the
 * same-origin `/ce` reverse proxy). Both are same-origin, so the strict CSP
 * (`connect-src 'self'`) holds — there is no `ce-net.com/*` or other remote hop.
 */
export const DEFAULT_NODE_URL = "" as const;

/**
 * Resolve the effective node URL. Precedence: an explicit override (e.g. from
 * localStorage) > a `VITE_CE_NODE_URL` build-time env > the mesh-native default
 * (empty string -> {@link connectNode}). An invalid override is ignored so a
 * corrupt setting can never brick boot.
 */
export function resolveNodeUrl(override?: string | null): string {
  const candidates = [override, readEnvNodeUrl()];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0 && isHttpUrl(c)) return c;
  }
  return DEFAULT_NODE_URL;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function readEnvNodeUrl(): string | undefined {
  // import.meta.env is defined by Vite; guard for non-Vite (test) runs.
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    return env?.["VITE_CE_NODE_URL"];
  } catch {
    return undefined;
  }
}

export interface Identity {
  nodeId: string;
}

/**
 * Construct a client against the local node. With no `baseUrl` (the default), this
 * uses the mesh-native, same-origin transport via {@link connectNode}. A non-empty
 * `baseUrl` is an explicit user override (advanced "Node URL" setting) pointing at a
 * specific node's HTTP+SSE API.
 */
export function makeClient(baseUrl: string = DEFAULT_NODE_URL): CeClient {
  if (!baseUrl) return connectNode();
  return new CeClient({ baseUrl });
}

/** Fetch this node's identity (its node id == the user's chat identity). */
export async function fetchIdentity(client: CeClient): Promise<Identity> {
  const status = await client.getStatus();
  return { nodeId: status.nodeId };
}

/** Liveness probe used before connecting. */
export async function nodeHealthy(client: CeClient): Promise<boolean> {
  return client.health();
}

/** Adapt `CeClient.mesh` to the {@link MeshLike} port. */
export function meshAdapter(client: CeClient): MeshLike {
  return {
    subscribe: (topic) => client.mesh.subscribe(topic),
    publish: (topic, payload) => client.mesh.publish(topic, payload),
    async *streamMessages(opts) {
      for await (const m of client.mesh.streamMessages(opts)) {
        const frame: MeshFrame = {
          from: m.from,
          topic: m.topic,
          text: safeUtf8(m.payload()),
          receivedAt: m.receivedAt,
        };
        yield frame;
      }
    },
  };
}

/** Decode mesh bytes to UTF-8, returning "" on invalid bytes (parseEnvelope drops it). */
export function safeUtf8(bytes: Uint8Array): string {
  try {
    return bytesToUtf8(bytes);
  } catch {
    return "";
  }
}
