import "./styles/app.css";
import { el, clear, linkify } from "./ui/dom.ts";
import { ChatService, type MeshLike } from "./core/service.ts";
import {
  publicChannel,
  privateChannel,
  dmChannel,
  normalizeChannelName,
  isValidChannelName,
  isNodeId,
  type ChannelRef,
} from "./core/topics.ts";
import { HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS, type Member } from "./core/presence.ts";
import { type StoredMessage } from "./core/store.ts";
import { shortId, initials, hueFor, clockTime, relativeTime, utf8Len } from "./core/format.ts";
import { MAX_TEXT_LEN } from "./core/protocol.ts";
import { toFriendly } from "./core/errors.ts";
import {
  makeClient,
  meshAdapter,
  fetchIdentity,
  DEFAULT_NODE_URL,
} from "./core/sdk-adapter.ts";

/** Default channels every member sees on first load. */
const DEFAULT_CHANNELS = ["general", "random", "mesh"];
const NAME_KEY = "ce-chat:name";

interface AppState {
  selfId: string;
  name: string | undefined;
  service: ChatService;
  active: string | null;
  /** ids of messages whose publish failed (rendered as failed). */
  failed: Set<string>;
  connectionError: string | null;
}

const root = document.getElementById("app")!;
let app: AppState | null = null;
let heartbeatTimer: number | undefined;
let presenceTimer: number | undefined;

boot();

async function boot(): Promise<void> {
  renderLoading();
  const client = makeClient();
  try {
    const id = await fetchIdentity(client);
    const name = localStorage.getItem(NAME_KEY) ?? undefined;
    const mesh: MeshLike = meshAdapter(client);
    const service = new ChatService(mesh, id.nodeId, name, {
      onMessages: (cid) => {
        if (app?.active === cid) renderStream();
        renderSidebar();
      },
      onPresence: (cid) => {
        if (app?.active === cid) renderRoster();
        renderSidebar();
      },
      onStreamError: (err) => {
        const f = toFriendly(err);
        if (app) app.connectionError = `${f.message}${f.hint ? " " + f.hint : ""}`;
        renderAll();
      },
    });
    app = { selfId: id.nodeId, name, service, active: null, failed: new Set(), connectionError: null };

    // Join default channels and select the first.
    for (const c of DEFAULT_CHANNELS) {
      try {
        await service.join(publicChannel(c));
      } catch (e) {
        // A default channel failing to subscribe shouldn't block boot.
        console.warn("join failed", c, e);
      }
    }
    app.active = service.joined()[0]?.id ?? null;
    service.startStream();
    startTimers();
    renderAll();
  } catch (err) {
    renderConnectError(err, () => boot());
  }
}

function startTimers(): void {
  stopTimers();
  // Heartbeat into the active channel so peers see us.
  heartbeatTimer = window.setInterval(() => {
    if (app?.active) void app.service.heartbeat(app.active);
  }, HEARTBEAT_INTERVAL_MS);
  // Send one immediately so we appear without waiting a full interval.
  if (app?.active) void app.service.heartbeat(app.active);
  // Repaint presence to age members out as the TTL passes.
  presenceTimer = window.setInterval(() => {
    if (app?.active) renderRoster();
    renderSidebar();
  }, 5000);
}

function stopTimers(): void {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  if (presenceTimer) window.clearInterval(presenceTimer);
}

/* ------------------------------------------------------------------ render */

function renderLoading(): void {
  clear(root);
  root.append(
    el("div", { class: "shell" }, [
      el("aside", { class: "sidebar" }, [brandNode()]),
      el("section", { class: "main" }, [
        el("div", { class: "skeleton" }, skeletonRows(6)),
      ]),
    ]),
  );
}

function skeletonRows(n: number): Node[] {
  const rows: Node[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      el("div", { class: "skel-row" }, [
        el("div", { class: "skel-av" }),
        el("div", {}, [
          el("div", { class: "skel-line", style: `width:${30 + ((i * 17) % 40)}%; margin-bottom:8px` }),
          el("div", { class: "skel-line", style: `width:${50 + ((i * 23) % 40)}%` }),
        ]),
      ]),
    );
  }
  return rows;
}

function renderConnectError(err: unknown, retry: () => void): void {
  const f = toFriendly(err);
  clear(root);
  root.append(
    el("div", { class: "shell" }, [
      el("aside", { class: "sidebar" }, [brandNode()]),
      el("section", { class: "main" }, [
        el("div", { class: "placeholder" }, [
          el("div", { class: "card" }, [
            el("div", { class: "glyph" }, ["⚓"]),
            el("h3", {}, ["Can't reach your CE node"]),
            el("p", {}, [
              "ce-chat talks to a local node over its HTTP+SSE API at ",
              el("code", {}, [DEFAULT_NODE_URL]),
              ".",
            ]),
            el("p", {}, [f.hint ?? "Start your node, then retry."]),
            el("p", { style: "margin-top:14px" }, [
              el("code", {}, ["ce start"]),
            ]),
            el("div", { class: "modal-actions", style: "justify-content:center;margin-top:20px" }, [
              el("button", { class: "btn primary", onclick: retry }, ["Retry connection"]),
            ]),
          ]),
        ]),
      ]),
    ]),
  );
}

function renderAll(): void {
  if (!app) return;
  clear(root);
  root.append(
    el("div", { class: "shell" }, [
      buildSidebar(),
      buildMain(),
      buildRoster(),
    ]),
  );
  scrollStreamToBottom();
}

// Targeted re-renders to avoid rebuilding the whole shell on every frame.
function renderSidebar(): void {
  const existing = document.querySelector(".sidebar");
  if (existing) existing.replaceWith(buildSidebar());
}
function renderStream(): void {
  const main = document.querySelector(".main");
  if (main) {
    main.replaceWith(buildMain());
    scrollStreamToBottom();
  }
}
function renderRoster(): void {
  const existing = document.querySelector(".roster");
  if (existing) existing.replaceWith(buildRoster());
}

function brandNode(): Node {
  return el("div", { class: "brand" }, [
    el("div", {
      class: "mark",
      html: `<svg viewBox="0 0 32 32" width="30" height="30"><rect width="32" height="32" rx="8" fill="#0b1f24"/><path d="M4 20c3-4 6 0 9-2s6-6 9-2 6 0 9-2" stroke="#34d0c4" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M4 25c3-4 6 0 9-2s6-6 9-2 6 0 9-2" stroke="#1fa99e" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.7"/></svg>`,
    }),
    el("div", {}, [
      el("h1", {}, ["ce-chat"]),
      el("p", { class: "tag" }, ["team chat on the Sea"]),
    ]),
  ]);
}

function buildSidebar(): Node {
  const a = app!;
  const channels = a.service.joined();
  const now = Date.now();

  const list = el("ul", { class: "channel-list", role: "list" });
  for (const ref of channels) {
    const st = a.service.state(ref.id);
    const online = st ? st.presence.onlineCount(now) : 0;
    const isActive = ref.id === a.active;
    list.append(
      el(
        "li",
        {},
        [
          el(
            "button",
            {
              class: "chan",
              "aria-current": isActive ? "true" : "false",
              onclick: () => selectChannel(ref.id),
            },
            [
              el("span", { class: "sigil", "aria-hidden": "true" }, [sigilFor(ref)]),
              el("span", { class: "label" }, [ref.label]),
              ...(ref.kind === "private" ? [el("span", { class: "lock", title: "capability-gated" }, ["lock"])] : []),
              ...(online > 0 ? [el("span", { class: "count", title: `${online} online` }, [String(online)])] : []),
            ],
          ),
        ],
      ),
    );
  }

  const offline = !!a.connectionError;
  return el("aside", { class: "sidebar" }, [
    brandNode(),
    identityCard(),
    el("div", { class: "nav-section" }, [
      el("h2", {}, ["Channels"]),
      el("button", { class: "add", title: "New channel or DM", "aria-label": "New channel or DM", onclick: openComposeModal }, ["+"]),
    ]),
    list,
    el("div", { class: "sidebar-foot" }, [
      el("span", { class: `dot ${offline ? "warn" : "on"}` }),
      offline ? "node unreachable" : `mesh live · ${channels.length} channels`,
    ]),
  ]);
}

function sigilFor(ref: ChannelRef): string {
  if (ref.kind === "dm") return "@";
  if (ref.kind === "private") return "*";
  return "#";
}

function identityCard(): Node {
  const a = app!;
  const display = a.name || shortId(a.selfId);
  return el("div", { class: "identity" }, [
    avatarNode(a.name || a.selfId, a.selfId, 36),
    el("div", { class: "who" }, [
      el("div", { class: "name" }, [display]),
      el("div", { class: "nid" }, [
        shortId(a.selfId, 6, 6),
        el("button", { title: "Copy your node id", onclick: () => copy(a.selfId) }, ["copy"]),
        el("button", { title: "Set display name", onclick: openNameModal }, ["rename"]),
      ]),
    ]),
  ]);
}

function buildMain(): Node {
  const a = app!;
  if (!a.active) {
    return el("section", { class: "main" }, [emptyPane()]);
  }
  const ref = a.service.joined().find((r) => r.id === a.active)!;
  const st = a.service.state(a.active)!;
  const now = Date.now();
  const online = st.presence.onlineCount(now);

  const stream = el("div", { class: "stream", id: "stream", role: "log", "aria-live": "polite", "aria-label": `${ref.label} messages` });
  const msgs = st.store.list();
  if (msgs.length === 0) {
    stream.append(emptyChannel(ref));
  } else {
    renderMessages(stream, msgs);
  }

  const main = el("section", { class: "main" }, [
    el("header", { class: "topbar" }, [
      el("div", { class: "title" }, [
        el("span", { class: "sigil", "aria-hidden": "true" }, [sigilFor(ref)]),
        el("h2", {}, [ref.label]),
      ]),
      el("span", { class: "topic", title: ref.topic }, [ref.topic]),
      el("div", { class: "spacer" }),
      el("div", { class: "presence-chip", title: `${online} online` }, [
        el("span", { class: "dot on" }),
        `${online} online`,
      ]),
    ]),
  ]);

  if (a.connectionError) {
    main.append(
      el("div", { class: "banner error", role: "alert" }, [
        el("span", {}, ["⚠"]),
        el("span", {}, [a.connectionError]),
        el("button", { onclick: () => boot() }, ["Reconnect"]),
      ]),
    );
  }

  main.append(stream, buildComposer(ref));
  return main;
}

function renderMessages(stream: HTMLElement, msgs: StoredMessage[]): void {
  let lastDay = "";
  let prevFrom = "";
  let prevTs = 0;
  for (const m of msgs) {
    const day = new Date(m.ts || m.receivedAt).toDateString();
    if (day !== lastDay) {
      stream.append(el("div", { class: "daydiv" }, [friendlyDay(m.ts || m.receivedAt)]));
      lastDay = day;
      prevFrom = "";
    }
    const grouped = m.from === prevFrom && m.ts - prevTs < 5 * 60 * 1000 && prevFrom !== "";
    stream.append(messageNode(m, grouped));
    prevFrom = m.from;
    prevTs = m.ts || m.receivedAt;
  }
}

function messageNode(m: StoredMessage, grouped: boolean): Node {
  const a = app!;
  const failed = a.failed.has(m.id);
  const author = m.name || shortId(m.from);
  const cls = ["msg", grouped ? "grouped" : "", m.pending ? "pending" : "", failed ? "failed" : ""].filter(Boolean).join(" ");

  const head = grouped
    ? null
    : el("div", { class: "head" }, [
        el("span", { class: `author ${m.isSelf ? "self" : ""}` }, [author]),
        ...(m.name ? [el("span", { class: "nid" }, [shortId(m.from, 4, 4)])] : []),
        el("span", { class: "stamp" }, [clockTime(m.ts || m.receivedAt)]),
      ]);

  const body = el("div", { class: "body" }, linkify(m.text));
  if (m.pending) body.append(el("span", { class: "pending-tag" }, ["sending"]));
  if (failed) body.append(el("span", { class: "failed-tag" }, ["failed"]));

  return el("div", { class: cls }, [
    el("div", { class: "avatar-cell" }, [grouped ? document.createTextNode("") : avatarNode(author, m.from, 34)]),
    el("div", {}, [...(head ? [head] : []), body]),
  ]);
}

function avatarNode(label: string, idForHue: string, size: number): HTMLElement {
  const hue = hueFor(idForHue);
  return el(
    "div",
    {
      class: "avatar",
      style: `width:${size}px;height:${size}px;background:linear-gradient(135deg, hsl(${hue} 62% 58%), hsl(${(hue + 36) % 360} 64% 46%))`,
      "aria-hidden": "true",
    },
    [initials(label)],
  );
}

let composerValue = "";
function buildComposer(ref: ChannelRef): Node {
  const a = app!;
  const ta = el("textarea", {
    placeholder: `Message ${ref.kind === "dm" ? ref.label : "#" + ref.label}…`,
    rows: 1,
    "aria-label": `Message ${ref.label}`,
    oninput: (e) => {
      const t = e.target as HTMLTextAreaElement;
      composerValue = t.value;
      autoGrow(t);
      updateComposerMeta();
    },
    onkeydown: (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey) {
        ke.preventDefault();
        void doSend();
      }
    },
  }) as HTMLTextAreaElement;
  ta.value = composerValue;

  const send = el("button", { class: "send", title: "Send (Enter)", "aria-label": "Send message", onclick: () => void doSend() }, [
    el("span", { html: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 12l16-8-6 8 6 8-16-8z" fill="currentColor"/></svg>` }),
  ]);

  const meta = el("div", { class: "meta", id: "composer-meta" }, [
    el("span", {}, [ref.kind === "dm" ? "Direct message · end-to-mesh" : "Enter to send · Shift+Enter for newline"]),
    el("span", { id: "char-count" }, [""]),
  ]);

  queueMicrotask(() => {
    ta.focus();
    autoGrow(ta);
    updateComposerMeta();
  });

  return el("div", { class: "composer" }, [
    el("div", { class: "box" }, [ta, send]),
    meta,
  ]);

  function autoGrow(t: HTMLTextAreaElement): void {
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 160) + "px";
  }
  function updateComposerMeta(): void {
    const count = document.getElementById("char-count");
    const sendBtn = document.querySelector(".send") as HTMLButtonElement | null;
    const len = utf8Len(composerValue.trim());
    if (count) {
      count.textContent = len > MAX_TEXT_LEN - 200 ? `${len}/${MAX_TEXT_LEN}` : "";
      count.className = len > MAX_TEXT_LEN ? "over" : "";
    }
    if (sendBtn) sendBtn.disabled = len === 0 || len > MAX_TEXT_LEN || !!a.connectionError;
  }
}

async function doSend(): Promise<void> {
  const a = app!;
  if (!a.active) return;
  const text = composerValue.trim();
  if (text.length === 0 || utf8Len(text) > MAX_TEXT_LEN) return;
  composerValue = "";
  let optimisticId: string | undefined;
  try {
    const m = await a.service.send(a.active, text);
    optimisticId = m.id;
    a.failed.delete(m.id);
    renderStream();
  } catch (err) {
    if (optimisticId) a.failed.add(optimisticId);
    const f = toFriendly(err);
    a.connectionError = f.kind === "offline" || f.kind === "auth" ? `${f.message}${f.hint ? " " + f.hint : ""}` : null;
    renderStream();
    // surface transient send errors without blowing away the channel
    flash(`Couldn't send: ${f.message}`);
  }
}

function buildRoster(): Node {
  const a = app!;
  if (!a.active) return el("aside", { class: "roster" });
  const st = a.service.state(a.active);
  const now = Date.now();
  const members: Member[] = st ? st.presence.list(now) : [];
  const ul = el("ul", { role: "list" });
  for (const m of members) {
    const online = now - m.lastSeen <= PRESENCE_TTL_MS;
    const label = m.isSelf ? (a.name || "you") + " (you)" : m.name || shortId(m.nodeId);
    ul.append(
      el("li", { class: `member ${online ? "" : "offline"}` }, [
        avatarNode(m.name || m.nodeId, m.nodeId, 28),
        el("div", { class: "info" }, [
          el("div", { class: "mname" }, [label]),
          el("div", { class: "mid" }, [shortId(m.nodeId, 4, 4) + (online ? "" : " · " + relativeTime(m.lastSeen, now))]),
        ]),
        el("span", { class: `pdot ${online ? "on" : "off"}`, title: online ? "online" : "away" }),
      ]),
    );
  }
  return el("aside", { class: "roster", "aria-label": "Members" }, [
    el("h3", {}, [`Members · ${members.length}`]),
    ul,
  ]);
}

function emptyPane(): Node {
  return el("div", { class: "placeholder" }, [
    el("div", { class: "card" }, [
      el("div", { class: "glyph" }, ["~"]),
      el("h3", {}, ["No channel selected"]),
      el("p", {}, ["Pick a channel on the left, or create one to start talking over the mesh."]),
    ]),
  ]);
}

function emptyChannel(ref: ChannelRef): Node {
  return el("div", { class: "placeholder", style: "flex:1" }, [
    el("div", { class: "card" }, [
      el("div", { class: "glyph" }, [sigilFor(ref)]),
      el("h3", {}, [ref.kind === "dm" ? `Say hi to ${ref.label}` : `Welcome to #${ref.label}`]),
      el("p", {}, [
        ref.kind === "dm"
          ? "This is the beginning of your direct conversation over the CE mesh."
          : "This channel is a mesh pubsub topic. Anything you send is gossiped to every subscribed peer in real time.",
      ]),
      el("p", { style: "margin-top:8px" }, [
        "Topic: ",
        el("code", {}, [ref.topic]),
      ]),
    ]),
  ]);
}

function friendlyDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ actions */

async function selectChannel(id: string): Promise<void> {
  if (!app) return;
  app.active = id;
  composerValue = "";
  renderAll();
  // Heartbeat into the newly active channel right away.
  void app.service.heartbeat(id);
}

function scrollStreamToBottom(): void {
  const s = document.getElementById("stream");
  if (s) s.scrollTop = s.scrollHeight;
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => flash("Copied node id"),
    () => flash("Copy failed"),
  );
}

let flashTimer: number | undefined;
function flash(msg: string): void {
  let bar = document.getElementById("flash");
  if (!bar) {
    bar = el("div", {
      id: "flash",
      style:
        "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#0b1f24;border:1px solid #1d4a51;color:#eaf6f4;padding:9px 16px;border-radius:10px;font-size:13px;z-index:80;box-shadow:0 8px 28px rgba(0,0,0,.4)",
      role: "status",
    });
    document.body.append(bar);
  }
  bar.textContent = msg;
  if (flashTimer) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => bar?.remove(), 2400);
}

/* ------------------------------------------------------------------ modals */

function openNameModal(): void {
  const a = app!;
  let value = a.name ?? "";
  const input = el("input", {
    value,
    placeholder: "e.g. Leif",
    maxlength: 40,
    "aria-label": "Display name",
    oninput: (e) => (value = (e.target as HTMLInputElement).value),
    onkeydown: (e) => {
      if ((e as KeyboardEvent).key === "Enter") save();
    },
  }) as HTMLInputElement;

  const close = openModal("Display name", "Shown next to your messages. Stored locally; broadcast with your presence.", [
    el("div", { class: "field" }, [
      el("label", { for: "name-input" }, ["Name"]),
      input,
      el("div", { class: "help" }, ["Leave blank to use your short node id."]),
    ]),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "btn ghost", onclick: () => close() }, ["Cancel"]),
      el("button", { class: "btn primary", onclick: save }, ["Save"]),
    ]),
  ]);
  input.id = "name-input";
  queueMicrotask(() => input.focus());

  function save(): void {
    const name = value.trim() || undefined;
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
    // Rebuild the service with the new name (service captures name at construction).
    rebuildServiceWithName(name);
    close();
  }
}

function rebuildServiceWithName(name: string | undefined): void {
  // Simplest correct path: persist + reload so every channel re-announces presence
  // with the new name and the service captures it cleanly. Reload is instant against
  // a live local node and keeps the data path honest.
  if (!app) return;
  app.name = name;
  flash(name ? `Name set to ${name}` : "Name cleared");
  // Reannounce presence immediately under the new name without a full reload:
  // we cannot mutate the captured name, so reload to keep one source of truth.
  location.reload();
}

function openComposeModal(): void {
  let tab: "channel" | "private" | "dm" = "channel";
  let channelInput = "";
  let privateInput = "";
  let dmInput = "";
  let errMsg = "";

  const render = () => {
    clear(body);
    const tabs = el("div", { class: "tabs", role: "tablist" }, [
      tabBtn("Channel", tab === "channel", () => setTab("channel")),
      tabBtn("Private", tab === "private", () => setTab("private")),
      tabBtn("Direct", tab === "dm", () => setTab("dm")),
    ]);
    body.append(tabs);

    if (tab === "channel") {
      body.append(
        field("Channel name", "general", channelInput, "channel", (v) => (channelInput = v), submit),
        help("A public mesh topic anyone can join: ", el("code", {}, ["ce-chat/channel/<name>"])),
      );
    } else if (tab === "private") {
      body.append(
        field("Private channel", "eng-secret", privateInput, "channel", (v) => (privateInput = v), submit),
        help(
          "Capability-gated. The node enforces access on ",
          el("code", {}, ["ce-chat/private/<name>"]),
          ". If you lack a grant, subscribe returns 403 and we explain how to get one.",
        ),
      );
    } else {
      body.append(
        field("Peer node id (64 hex)", "a1b2…", dmInput, "node", (v) => (dmInput = v), submit),
        help("Opens a 1:1 topic derived from both node ids — order-independent, so either side can start it."),
      );
    }
    if (errMsg) body.append(el("div", { class: "field" }, [el("div", { class: "err" }, [errMsg])]));
    body.append(
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn ghost", onclick: () => close() }, ["Cancel"]),
        el("button", { class: "btn primary", onclick: submit }, [tab === "dm" ? "Open DM" : "Create / Join"]),
      ]),
    );
  };

  const body = el("div", {});
  const close = openModalRaw("New channel or direct message", body);
  render();

  function setTab(t: typeof tab): void {
    tab = t;
    errMsg = "";
    render();
  }

  async function submit(): Promise<void> {
    const a = app!;
    errMsg = "";
    try {
      let ref: ChannelRef;
      if (tab === "dm") {
        const peer = dmInput.trim().toLowerCase();
        if (!isNodeId(peer)) {
          errMsg = "Enter a valid 64-hex node id.";
          return render();
        }
        if (peer === a.selfId.toLowerCase()) {
          errMsg = "You can't DM yourself.";
          return render();
        }
        ref = dmChannel(a.selfId, peer, shortId(peer, 5, 5));
      } else {
        const raw = tab === "channel" ? channelInput : privateInput;
        const name = normalizeChannelName(raw);
        if (!isValidChannelName(name)) {
          errMsg = "Use 1–64 lowercase letters, digits, - or _.";
          return render();
        }
        ref = tab === "channel" ? publicChannel(name) : privateChannel(name);
      }
      await a.service.join(ref);
      a.active = ref.id;
      a.connectionError = null;
      close();
      renderAll();
      void a.service.heartbeat(ref.id);
    } catch (err) {
      const f = toFriendly(err);
      errMsg = `${f.message}${f.hint ? " — " + f.hint : ""}`;
      render();
    }
  }
}

function tabBtn(label: string, selected: boolean, onclick: () => void): Node {
  return el("button", { role: "tab", "aria-selected": selected ? "true" : "false", onclick }, [label]);
}

function field(
  label: string,
  placeholder: string,
  value: string,
  kind: "channel" | "node",
  onchange: (v: string) => void,
  onsubmit: () => void,
): Node {
  const input = el("input", {
    placeholder,
    value,
    class: kind === "node" ? "mono" : "",
    spellcheck: false,
    autocapitalize: "off",
    autocomplete: "off",
    oninput: (e) => onchange((e.target as HTMLInputElement).value),
    onkeydown: (e) => {
      if ((e as KeyboardEvent).key === "Enter") onsubmit();
    },
  }) as HTMLInputElement;
  queueMicrotask(() => input.focus());
  return el("div", { class: "field" }, [el("label", {}, [label]), input]);
}

function help(...children: (Node | string)[]): Node {
  return el("div", { class: "field" }, [el("div", { class: "help" }, children)]);
}

function openModal(title: string, sub: string, children: (Node | string)[]): () => void {
  const body = el("div", {}, [el("p", { class: "sub" }, [sub]), ...children]);
  return openModalRaw(title, body);
}

function openModalRaw(title: string, body: Node): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [
    el("h3", {}, [title]),
    body,
  ]);
  const scrim = el("div", {
    class: "scrim",
    onclick: (e) => {
      if (e.target === scrim) close();
    },
  }, [modal]);
  document.body.append(scrim);
  document.addEventListener("keydown", onKey);
  function close(): void {
    document.removeEventListener("keydown", onKey);
    scrim.remove();
  }
  return close;
}

// Clean up timers if the page is torn down.
window.addEventListener("beforeunload", () => {
  app?.service.stop();
  stopTimers();
});
