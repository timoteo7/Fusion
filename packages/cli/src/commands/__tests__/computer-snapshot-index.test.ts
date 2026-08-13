import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerUseError, type AppRef, type Element, type WindowRef } from "../computer/contract.js";
import { ComputerSnapshotStore } from "../computer/snapshot-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const app: AppRef = { bundleId: "com.example.Editor", name: "Editor", pid: 41 };
const window: WindowRef = { windowId: "w-1", windowIndex: 1, title: "Editor", bounds: null, minimized: false };
const element = (index: number): Element => ({
  index, role: "AXButton", title: `button-${index}`, value: null, label: null, enabled: true, focused: false,
  bounds: null, actions: ["AXPress"], locator: { kind: "ax-path", path: `AXWindow[0]/AXButton[${index}]`, role: "AXButton", subrole: null, identifier: null, title: `button-${index}` },
});

async function fixture(now = new Date("2026-08-11T03:34:00.000Z")) {
  const root = await mkdtemp(join(tmpdir(), "computer-snapshot-"));
  roots.push(root);
  let clock = now;
  return {
    root,
    setNow(value: Date) { clock = value; },
    store: new ComputerSnapshotStore({ projectRoot: root, now: () => clock }),
  };
}

function expectComputerError(error: unknown, code: string, reason?: string) {
  expect(error).toBeInstanceOf(ComputerUseError);
  const computerError = error as ComputerUseError;
  expect(computerError.code).toBe(code);
  if (reason) expect(computerError.details?.reason).toBe(reason);
  expect(computerError.message).toContain("get-app-state");
}

describe("ComputerSnapshotStore", () => {
  it("persists sparse indexes and rejects indexes derived from elementCount", async () => {
    const { store, root } = await fixture();
    const record = await store.persist({ app, window, elementCount: 3, elements: [element(0), element(3), element(7)] });

    expect(store.getElement(record, 7).index).toBe(7);
    try { store.getElement(record, 2); } catch (error) { expectComputerError(error, "ELEMENT_INDEX_NOT_FOUND"); }
    expect(JSON.parse(await readFile(join(root, ".fusion/computer-use/snapshots", `${record.snapshotId}.json`), "utf8")).elements["7"].index).toBe(7);
  });

  it("uses the required C9 freshness order and remediation", async () => {
    const { store, setNow } = await fixture();
    await expect(store.resolve({ app })).rejects.toMatchObject({ code: "SNAPSHOT_REQUIRED" });

    const first = await store.persist({ app, window, elementCount: 1, elements: [element(7)] });
    const second = await store.persist({ app, window, elementCount: 1, elements: [element(7)] });
    await expect(store.resolve({ app, snapshotId: first.snapshotId })).rejects.toMatchObject({ code: "SNAPSHOT_STALE", details: { reason: "superseded", snapshotId: first.snapshotId } });
    await expect(store.resolve({ app, snapshotId: "cs_0000000000missing" })).rejects.toMatchObject({ code: "SNAPSHOT_STALE", details: { reason: "not-found", snapshotId: "cs_0000000000missing" } });

    setNow(new Date(Date.parse(second.expiresAt) + 1));
    await expect(store.resolve({ app, snapshotId: second.snapshotId })).rejects.toMatchObject({ code: "SNAPSHOT_STALE", details: { reason: "expired", snapshotId: second.snapshotId } });
  });

  it("orders superseded before expiry and checks pid and asserted window after freshness", async () => {
    const { store, setNow } = await fixture();
    const first = await store.persist({ app, window, elementCount: 1, elements: [element(0)] });
    const second = await store.persist({ app, window, elementCount: 1, elements: [element(0)] });
    setNow(new Date(Date.parse(second.expiresAt) + 1));
    await expect(store.resolve({ app, snapshotId: first.snapshotId })).rejects.toMatchObject({ details: { reason: "superseded" } });

    const live = await fixture();
    const record = await live.store.persist({ app, window, elementCount: 1, elements: [element(0)] });
    await expect(live.store.resolve({ app: { ...app, pid: 99 }, snapshotId: record.snapshotId })).rejects.toMatchObject({ details: { reason: "pid-changed", snapshotId: record.snapshotId } });
    await expect(live.store.resolve({ app, snapshotId: record.snapshotId, assertedWindowId: "other-window" })).rejects.toMatchObject({ details: { reason: "window-mismatch", snapshotId: record.snapshotId } });
  });

  it("treats absent or unparsable named records as not-found", async () => {
    const { store, root } = await fixture();
    const record = await store.persist({ app, window, elementCount: 1, elements: [element(0)] });
    await writeFile(join(root, ".fusion/computer-use/snapshots", `${record.snapshotId}.json`), "not json");
    await expect(store.resolve({ app, snapshotId: record.snapshotId })).rejects.toMatchObject({ code: "SNAPSHOT_STALE", details: { reason: "not-found", snapshotId: record.snapshotId } });
  });

  it("prunes expired records with a single-level snapshots directory read", async () => {
    const { store, root, setNow } = await fixture();
    const old = await store.persist({ app, window, elementCount: 1, elements: [element(0)], expiresAt: "2026-08-11T03:33:00.000Z" });
    setNow(new Date("2026-08-11T03:35:00.000Z"));
    await store.prune();
    await expect(readFile(join(root, ".fusion/computer-use/snapshots", `${old.snapshotId}.json`), "utf8")).rejects.toThrow();
  });
});
