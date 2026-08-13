import { describe, expect, it, vi } from "vitest";
import { runComputer } from "../computer.js";
import type { ComputerAdapter } from "../computer/adapter.js";

const app = { bundleId: "com.example.App", name: "App", pid: 1 };
const adapter: ComputerAdapter = {
  platform: "darwin", id: "fake", supported: true,
  capabilities: async () => ({ platform: "darwin", adapterId: "fake", supported: true, actions: ["click", "set-value", "type-text", "press-key", "hotkey", "scroll", "drag"], unsupportedActions: [], features: { screenshot: false, restoreWindow: false, stdinSecrets: true, crossInvocationSnapshots: true } }),
  permissions: async () => ({ platform: "darwin", adapterId: "fake", supported: true, allGranted: true, checks: [] }),
  listApps: async () => ({ apps: [app] }), listWindows: async () => ({ app, windows: [{ windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }] }),
  captureState: async () => ({ app, window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, snapshot: { snapshotId: "", targetKey: "", windowKey: "", capturedAt: new Date(0).toISOString(), expiresAt: "", treeText: "tree", elementCount: 1, truncated: false, elements: [{ index: 7, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator: { kind: "ax-path", path: "button[0]", role: "AXButton", subrole: null, identifier: null, title: "Go" } }] }, screenshot: null }),
  resolveWindow: async () => ({ window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, handle: "w" }), resolveLocator: async (_w, locator) => ({ element: { index: 7, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator }, handle: "e" }),
  click: async (x) => ({ action: "click", app: x.app, snapshotId: x.snapshotId, elementIndex: 7, fromElementIndex: null, toElementIndex: null, performed: true }), "set-value": async () => { throw new Error("unused"); }, "type-text": async () => { throw new Error("unused"); }, "press-key": async () => { throw new Error("unused"); }, hotkey: async () => { throw new Error("unused"); }, scroll: async () => { throw new Error("unused"); }, drag: async () => { throw new Error("unused"); },
};
describe("computer commands", () => {
  it("emits one JSON envelope and persists a snapshot", async () => { const output: string[] = []; const root = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/fusion-computer-")); try { expect(await runComputer(["get-app-state", "--app", "App", "--no-screenshot", "--json"], { adapter, projectRoot: root, stdout: (x) => output.push(x) })).toBe(0); const envelope = JSON.parse(output[0]); expect(envelope).toMatchObject({ schemaVersion: 1, ok: true, command: "computer.get-app-state" }); expect(envelope.result.snapshot.snapshotId).toMatch(/^cs_/); } finally { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); } });
  it("uses the snapshot replay path for element-scoped typing", async () => {
    const root = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/fusion-computer-"));
    let resolved = 0;
    let typed = 0;
    const replayAdapter: ComputerAdapter = { ...adapter,
      resolveLocator: async (_window, locator) => { resolved += 1; return { element: { index: 7, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator }, handle: "live" }; },
      "type-text": async (input) => { typed += 1; return { action: "type-text", app: input.app, snapshotId: input.snapshotId ?? null, elementIndex: input.element?.element.index ?? null, fromElementIndex: null, toElementIndex: null, performed: true }; },
    };
    try {
      await runComputer(["get-app-state", "--app", "App", "--no-screenshot", "--json"], { adapter: replayAdapter, projectRoot: root, clock: { now: () => new Date(0) }, stdout: () => undefined });
      expect(await runComputer(["type-text", "--app", "App", "--element-index", "7", "--text", "safe", "--json"], { adapter: replayAdapter, projectRoot: root, clock: { now: () => new Date(0) }, stdout: () => undefined })).toBe(0);
      expect(resolved).toBe(1); expect(typed).toBe(1);
    } finally { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); }
  });
  it("accepts complete coordinate drag without a snapshot", async () => {
    let input: Parameters<ComputerAdapter["drag"]>[0] | undefined;
    const dragAdapter: ComputerAdapter = { ...adapter, drag: async (value) => { input = value; return { action: "drag", app: value.app, snapshotId: null, elementIndex: null, fromElementIndex: null, toElementIndex: null, performed: true }; } };
    expect(await runComputer(["drag", "--app", "App", "--from-x", "1", "--from-y", "2", "--to-x", "3", "--to-y", "4", "--json"], { adapter: dragAdapter, stdout: () => undefined })).toBe(0);
    expect(input).toMatchObject({ snapshotId: null, fromX: 1, fromY: 2, toX: 3, toY: 4 });
  });
  it("resolves both element-drag endpoints from one snapshot fence during a concurrent latest update", async () => {
    const from = { index: 7, role: "AXButton", title: "From", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator: { kind: "ax-path" as const, path: "window[0]/AXButton[0]", role: "AXButton", subrole: null, identifier: null, title: "From" } };
    const to = { ...from, index: 9, title: "To", locator: { ...from.locator, path: "window[0]/AXButton[1]", title: "To" } };
    const record = { snapshotId: "cs_0123456789", window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, app, elements: { "7": from, "9": to } };
    const resolve = vi.fn().mockImplementation(async () => record);
    let input: Parameters<ComputerAdapter["drag"]>[0] | undefined;
    const dragAdapter: ComputerAdapter = { ...adapter,
      resolveLocator: async (_window, locator) => ({ element: locator.path === from.locator.path ? from : to, handle: locator.path }),
      drag: async (value) => { input = value; return { action: "drag", app: value.app, snapshotId: value.snapshotId, elementIndex: null, fromElementIndex: value.from?.element.index ?? null, toElementIndex: value.to?.element.index ?? null, performed: true }; },
    };
    const store = { resolve, getElement: (_record: typeof record, index: number) => _record.elements[String(index)] } as unknown as import("../computer/snapshot-store.js").ComputerSnapshotStore;
    expect(await runComputer(["drag", "--app", "App", "--from-element-index", "7", "--to-element-index", "9", "--json"], { adapter: dragAdapter, store, stdout: () => undefined })).toBe(0);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(input).toMatchObject({ snapshotId: record.snapshotId, from: { element: { index: 7 } }, to: { element: { index: 9 } } });
  });
  it("uses group-level INVALID_ARGUMENTS for unknown commands", async () => { const output: string[] = []; expect(await runComputer(["nope", "--json"], { adapter, stdout: (x) => output.push(x) })).toBe(1); expect(JSON.parse(output[0])).toMatchObject({ command: "computer", error: { code: "INVALID_ARGUMENTS" } }); });
  it("returns the required JSON envelope for a missing subcommand", async () => {
    const output: string[] = [];
    expect(await runComputer(["--json"], { adapter, stdout: (text) => output.push(text) })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, command: "computer", error: { code: "INVALID_ARGUMENTS" } });
  });
  it("validates mutually exclusive text flags before app discovery", async () => {
    const listApps = vi.fn(adapter.listApps);
    const output: string[] = [];
    expect(await runComputer(["type-text", "--app", "Missing", "--text", "a", "--text-stdin", "--json"], { adapter: { ...adapter, listApps }, stdout: (text) => output.push(text) })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    expect(listApps).not.toHaveBeenCalled();
  });
  it("falls back from an unmatched dotted bundle spelling to an exact app name", async () => {
    const dotted = { ...app, bundleId: "com.example.Other", name: "Foo.Bar" };
    const output: string[] = [];
    expect(await runComputer(["hotkey", "--app", "Foo.Bar", "--keys", "cmd+k", "--json"], { adapter: { ...adapter, listApps: async () => ({ apps: [dotted] }), hotkey: async (input) => ({ action: "hotkey", app: input.app, snapshotId: null, elementIndex: null, fromElementIndex: null, toElementIndex: null, performed: true }) }, stdout: (text) => output.push(text) })).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ result: { app: { name: "Foo.Bar" } } });
  });
});
