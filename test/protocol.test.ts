import { describe, it, expect } from "vitest";
import {
  makeChatMsg,
  makePresence,
  parseEnvelope,
  encodeEnvelope,
  MAX_TEXT_LEN,
  PROTOCOL_VERSION,
} from "../src/core/protocol.ts";

describe("protocol envelopes", () => {
  it("round-trips a chat message", () => {
    const e = makeChatMsg("id-1", "hello mesh", "Leif", 1700000000000);
    const back = parseEnvelope(encodeEnvelope(e));
    expect(back).toEqual(e);
    expect(back?.t).toBe("msg");
  });

  it("round-trips a presence heartbeat", () => {
    const e = makePresence("Leif", 1700000000000);
    const back = parseEnvelope(encodeEnvelope(e));
    expect(back).toEqual(e);
  });

  it("omits name when not provided", () => {
    const e = makeChatMsg("x", "hi", undefined, 1);
    expect("name" in e).toBe(false);
    const back = parseEnvelope(encodeEnvelope(e)) as { name?: string };
    expect(back.name).toBeUndefined();
  });

  it("stamps the protocol version", () => {
    expect(makeChatMsg("x", "y", undefined, 0).v).toBe(PROTOCOL_VERSION);
  });

  it("rejects non-JSON without throwing", () => {
    expect(parseEnvelope("not json{")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
    expect(parseEnvelope("42")).toBeNull();
  });

  it("rejects foreign envelopes (other mesh apps on a shared topic)", () => {
    expect(parseEnvelope(JSON.stringify({ t: "ce-pin", cid: "abc" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ hello: "world" }))).toBeNull();
  });

  it("rejects a msg with no id or non-string text", () => {
    expect(parseEnvelope(JSON.stringify({ t: "msg", text: "hi" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ t: "msg", id: "", text: "hi" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: 5 }))).toBeNull();
  });

  it("truncates oversize text to MAX_TEXT_LEN on parse", () => {
    const big = "z".repeat(MAX_TEXT_LEN + 500);
    const parsed = parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: big, ts: 1 }));
    expect(parsed?.t).toBe("msg");
    expect((parsed as { text: string }).text.length).toBe(MAX_TEXT_LEN);
  });

  it("coerces a missing/garbage ts to 0", () => {
    const p = parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: "hi" }));
    expect((p as { ts: number }).ts).toBe(0);
    const p2 = parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: "hi", ts: "nope" }));
    expect((p2 as { ts: number }).ts).toBe(0);
  });
});
