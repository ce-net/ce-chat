import { describe, it, expect } from "vitest";
import { MessageStore, type StoredMessage } from "../src/core/store.ts";

function msg(p: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    from: "a".repeat(64),
    text: "hi",
    ts: 1000,
    receivedAt: 1000,
    isSelf: false,
    ...p,
  };
}

describe("MessageStore", () => {
  it("adds new messages and dedupes by id", () => {
    const s = new MessageStore();
    expect(s.add(msg({ id: "1" }))).toBe("added");
    expect(s.add(msg({ id: "1" }))).toBe("duplicate");
    expect(s.size).toBe(1);
  });

  it("confirms an optimistic pending message when its echo arrives", () => {
    const s = new MessageStore();
    s.add(msg({ id: "m", isSelf: true, pending: true, receivedAt: 1 }));
    const res = s.add(msg({ id: "m", isSelf: true, pending: false, receivedAt: 99 }));
    expect(res).toBe("confirmed");
    const out = s.list();
    expect(out).toHaveLength(1);
    expect(out[0]!.pending).toBe(false);
    expect(out[0]!.receivedAt).toBe(99);
  });

  it("orders by author ts then receivedAt then id", () => {
    const s = new MessageStore();
    s.add(msg({ id: "b", ts: 200, receivedAt: 5 }));
    s.add(msg({ id: "a", ts: 100, receivedAt: 6 }));
    s.add(msg({ id: "c", ts: 200, receivedAt: 4 }));
    expect(s.list().map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  it("does not re-confirm a duplicate non-pending message", () => {
    const s = new MessageStore();
    s.add(msg({ id: "x", pending: false }));
    expect(s.add(msg({ id: "x", pending: false }))).toBe("duplicate");
  });

  it("evicts oldest beyond the cap (ring buffer)", () => {
    const s = new MessageStore(3);
    for (let i = 0; i < 5; i++) s.add(msg({ id: String(i), ts: i, receivedAt: i }));
    expect(s.size).toBe(3);
    expect(s.list().map((m) => m.id)).toEqual(["2", "3", "4"]);
  });

  it("clears", () => {
    const s = new MessageStore();
    s.add(msg({ id: "1" }));
    s.clear();
    expect(s.size).toBe(0);
    expect(s.list()).toEqual([]);
  });
});
