# ce-chat

**What it is.** ce-chat is a tiny Slack for the CE mesh: a Vite + TypeScript single-page
app where every channel is a CE pubsub topic and every message is a signed mesh
message. You join a channel (`/mesh/subscribe`), type a line (`/mesh/publish`), and a
single live SSE stream (`/mesh/messages/stream`) fans every subscribed-topic frame back
into per-channel message logs and a live member roster — presence is just periodic
heartbeats published to the same topic, with members aging out on a TTL. It supports
public channels, capability-gated **private** channels (the node enforces access; a
`403` becomes a friendly "you need a grant" prompt), and 1:1 **DMs** over an
order-independent topic derived from both node ids. Your CE node id *is* your identity.
It talks to a real local node through the published `@ce-net/sdk` (`CeClient.mesh`), so
the data path is genuine — the only mock is an in-memory mesh used by the unit tests.

## Run it against a node

```bash
# 1. Start your CE node (HTTP+SSE API on 127.0.0.1:8844)
ce start

# 2. In this folder
npm install
npm run dev          # opens http://localhost:5174
```

The Vite dev server proxies `/ce-api/*` to `http://127.0.0.1:8844`, so the browser can
POST and stream SSE against your local node without CORS friction. Open the app in two
browsers / two machines (each running their own `ce start`) on the same mesh, join the
same channel, and you will see each other's messages and presence in real time.

If the node isn't running you get a clear "Can't reach your CE node — `ce start`" screen
with a retry, not a blank page.

> Building for production? `npm run build` emits a static `dist/`. Served from a real
> origin it talks to `http://127.0.0.1:8844` directly; you may need the node's CORS
> allowance (or keep using the dev proxy / a reverse proxy that exposes the node under
> `/ce-api`).

## How channels map to the mesh

| ce-chat thing            | mesh topic                          |
| ------------------------ | ----------------------------------- |
| public channel `general` | `ce-chat/channel/general`           |
| private channel `eng`    | `ce-chat/private/eng` (gated)       |
| DM between A and B        | `ce-chat/dm/<min(A,B)>+<max(A,B)>`  |

Everything is namespaced under `ce-chat/` so chat never collides with other mesh apps,
and the reducer quietly drops any payload on a topic that isn't a valid ce-chat
envelope.

## Develop & test

```bash
npm run dev        # dev server with node proxy
npm run build      # tsc -b + vite build (type-checked production build)
npm test           # vitest: protocol, topics, store, presence, format, errors, service
```

The unit tests exercise the core logic — the wire protocol, channel/DM topic mapping,
the dedupe + optimistic-send + presence op model (via an in-memory mesh fake), money/size
formatting, and SDK error mapping — with the SDK and network fully mocked. No node is
required to run the tests.

## Layout

```
src/
  core/
    protocol.ts     wire envelopes (chat / presence) + safe parsing
    topics.ts       channel <-> mesh-topic mapping, name/id validation
    store.ts        per-channel log: dedupe, optimistic confirm, ring cap
    presence.ts     heartbeat-driven membership with a TTL
    format.ts       node-id / time / byte formatting (pure)
    errors.ts       SDK error -> friendly UI message + category
    service.ts      ChatService: the SDK-agnostic data path (port: MeshLike)
    sdk-adapter.ts  the ONLY @ce-net/sdk import for the data path
  ui/dom.ts         tiny typed DOM helpers (no framework)
  main.ts           the app: sidebar, message pane, composer, roster, modals
  styles/app.css    the "Sea" visual system
test/               vitest specs + in-memory mesh fake
```

## License

MIT © Leif Rydenfalk
