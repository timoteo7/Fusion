import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ComputerUseError,
  isValidSnapshotId,
  targetKeyForApp,
  targetKeySlug,
  windowKeyFor,
  type AppRef,
  type Element,
  type SnapshotRecord,
  type WindowRef,
} from "./contract.js";

const SNAPSHOT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_RECORDS = 50;
let lastSnapshotTimestamp = 0;
let snapshotSequence = 0;

export interface SnapshotStoreOptions {
  /** Project root shared by all CLI invocations; tests inject an isolated root. */
  projectRoot?: string;
  now?: () => Date;
  ttlMs?: number;
  maxRecords?: number;
}

export interface PersistSnapshotInput {
  app: AppRef;
  window: WindowRef;
  elementCount: number;
  elements: readonly Element[];
  capturedAt?: string;
  expiresAt?: string;
}

export interface ResolveSnapshotInput {
  app: AppRef;
  snapshotId?: string;
  assertedWindowId?: string;
}

/**
 * FNXC:ComputerUse 2026-08-11-03:34:
 * Every computer command is a new process, so get-app-state must atomically persist a serializable
 * locator map before returning its snapshot ID. Actions only replay the current app-scoped record;
 * sparse indexes are map keys rather than positions or elementCount-derived values to prevent a
 * stale UI from turning an intended action into a wrong-element action.
 */
export class ComputerSnapshotStore {
  private readonly projectRoot: string;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(options: SnapshotStoreOptions = {}) {
    this.projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  get snapshotsDirectory(): string {
    return join(this.projectRoot, ".fusion", "computer-use", "snapshots");
  }

  get latestDirectory(): string {
    return join(this.projectRoot, ".fusion", "computer-use", "latest");
  }

  async persist(input: PersistSnapshotInput): Promise<SnapshotRecord> {
    const capturedAt = input.capturedAt ?? this.now().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.parse(capturedAt) + this.ttlMs).toISOString();
    const targetKey = targetKeyForApp(input.app);
    const record: SnapshotRecord = {
      snapshotId: this.nextSnapshotId(),
      targetKey,
      windowKey: windowKeyFor(targetKey, input.window.windowId),
      capturedAt,
      expiresAt,
      app: input.app,
      window: input.window,
      elementCount: input.elementCount,
      elements: Object.fromEntries(input.elements.map((element) => [String(element.index), element])),
    };

    await mkdir(this.snapshotsDirectory, { recursive: true });
    await mkdir(this.latestDirectory, { recursive: true });
    await writeJsonAtomically(this.snapshotPath(record.snapshotId), record);
    await writeJsonAtomically(this.latestPath(targetKey), { snapshotId: record.snapshotId });
    await this.prune({ preserveSnapshotId: record.snapshotId });
    return record;
  }

  /** Read the current record for the resolved app and enforce the C9 fence order. */
  async resolve(input: ResolveSnapshotInput): Promise<SnapshotRecord> {
    const targetKey = targetKeyForApp(input.app);
    const latest = await this.readLatest(targetKey);
    if (!latest) {
      throw snapshotRequired();
    }

    const requestedId = input.snapshotId ?? latest.snapshotId;
    // Command parsing validates this too; the store repeats the guard so an injected caller cannot
    // turn an id into a path outside the snapshots directory.
    const record = isValidSnapshotId(requestedId) ? await this.readRecord(requestedId) : undefined;
    if (!record) {
      if (input.snapshotId) throw snapshotStale("not-found", requestedId);
      throw snapshotRequired();
    }

    if (input.snapshotId && latest.snapshotId !== input.snapshotId) {
      throw snapshotStale("superseded", input.snapshotId);
    }
    if (this.now().getTime() >= Date.parse(record.expiresAt)) {
      throw snapshotStale("expired", record.snapshotId);
    }
    if (record.app.pid !== input.app.pid) {
      throw snapshotStale("pid-changed", record.snapshotId);
    }
    if (input.assertedWindowId !== undefined && record.window.windowId !== input.assertedWindowId) {
      throw snapshotStale("window-mismatch", record.snapshotId);
    }
    return record;
  }

  /** Look up the actual sparse index emitted by the captured accessibility traversal. */
  getElement(record: SnapshotRecord, elementIndex: number): Element {
    const element = record.elements[String(elementIndex)];
    if (element) return element;
    throw new ComputerUseError(
      "ELEMENT_INDEX_NOT_FOUND",
      `Element index ${elementIndex} is not in snapshot ${record.snapshotId}; re-run fn computer get-app-state.`,
      "Re-run fn computer get-app-state and use an element index from that snapshot.",
      { snapshotId: record.snapshotId, elementIndex },
    );
  }

  /**
   * Keep the store bounded with single-level reads only. A caller holding a resolved record passes
   * it as preserveSnapshotId so a concurrent capture cannot remove that action's replay source.
   */
  async prune(options: { preserveSnapshotId?: string } = {}): Promise<void> {
    const entries = await readDirectory(this.snapshotsDirectory);
    const records: Array<{ id: string; expiresAt: number; modifiedAt: number }> = [];
    const now = this.now().getTime();
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const record = await this.readRecord(id);
      if (!record) continue;
      const expiresAt = Date.parse(record.expiresAt);
      if (id !== options.preserveSnapshotId && Number.isFinite(expiresAt) && expiresAt <= now) {
        await rm(this.snapshotPath(id), { force: true });
        continue;
      }
      const info = await stat(this.snapshotPath(id)).catch(() => undefined);
      records.push({ id, expiresAt, modifiedAt: info?.mtimeMs ?? 0 });
    }

    const overflow = Math.max(0, records.length - this.maxRecords);
    for (const record of records.sort((a, b) => a.modifiedAt - b.modifiedAt).slice(0, overflow)) {
      if (record.id !== options.preserveSnapshotId) await rm(this.snapshotPath(record.id), { force: true });
    }
  }

  private snapshotPath(snapshotId: string): string {
    return join(this.snapshotsDirectory, `${snapshotId}.json`);
  }

  private latestPath(targetKey: string): string {
    return join(this.latestDirectory, `${targetKeySlug(targetKey)}.json`);
  }

  private async readLatest(targetKey: string): Promise<{ snapshotId: string } | undefined> {
    const value = await readJson(this.latestPath(targetKey));
    return isLatestPointer(value) ? value : undefined;
  }

  private async readRecord(snapshotId: string): Promise<SnapshotRecord | undefined> {
    const value = await readJson(this.snapshotPath(snapshotId));
    return isSnapshotRecord(value) ? value : undefined;
  }

  private nextSnapshotId(): string {
    const timestamp = this.now().getTime();
    if (timestamp > lastSnapshotTimestamp) {
      lastSnapshotTimestamp = timestamp;
      snapshotSequence = 0;
    } else {
      snapshotSequence += 1;
    }
    return `cs_${lastSnapshotTimestamp.toString(36).padStart(10, "0")}${snapshotSequence.toString(36).padStart(3, "0")}${randomBytes(4).toString("hex")}`;
  }
}

export function createComputerSnapshotStore(options: SnapshotStoreOptions = {}): ComputerSnapshotStore {
  return new ComputerSnapshotStore(options);
}

function snapshotRequired(): ComputerUseError {
  return new ComputerUseError(
    "SNAPSHOT_REQUIRED",
    "No current snapshot exists for this app; re-run fn computer get-app-state.",
    "Re-run fn computer get-app-state before using an element index.",
  );
}

function snapshotStale(reason: "not-found" | "superseded" | "expired" | "pid-changed" | "window-mismatch", snapshotId: string): ComputerUseError {
  return new ComputerUseError(
    "SNAPSHOT_STALE",
    `Snapshot ${snapshotId} is ${reason}; re-run fn computer get-app-state.`,
    "Re-run fn computer get-app-state before retrying this action.",
    { reason, snapshotId },
  );
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function isLatestPointer(value: unknown): value is { snapshotId: string } {
  return !!value && typeof value === "object" && typeof (value as { snapshotId?: unknown }).snapshotId === "string";
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  const record = value as Partial<SnapshotRecord> | null;
  return !!record
    && typeof record.snapshotId === "string"
    && typeof record.targetKey === "string"
    && typeof record.windowKey === "string"
    && typeof record.capturedAt === "string"
    && typeof record.expiresAt === "string"
    && !!record.app && typeof record.app.pid === "number"
    && !!record.window && typeof record.window.windowId === "string"
    && typeof record.elementCount === "number"
    && !!record.elements && typeof record.elements === "object";
}
