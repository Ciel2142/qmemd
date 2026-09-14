import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type BetterSqlite from "better-sqlite3";
import { atomicWriteFile } from "./file-write.js";

const require = createRequire(import.meta.url);
// Match the runtimes supported by qmd, without loading its model/index machinery.
const Database = (process.versions.bun ? require("bun:sqlite").Database : require("better-sqlite3")) as typeof BetterSqlite;

function openLock(root: string): BetterSqlite.Database {
  // Keep the lock beside its corpus so distinct indexes, cache environments, and
  // symlink aliases still contend on the same inode. Internal state stays out of Git.
  const dir = join(root, ".qmemd-write-lock");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) atomicWriteFile(ignore, "*\n");
  const db = new Database(join(dir, "lock.sqlite"));
  try { db.exec("PRAGMA busy_timeout = 0"); }
  catch (e) { db.close(); throw e; }
  return db;
}

function tryAcquire(db: BetterSqlite.Database): boolean {
  try { db.exec("BEGIN IMMEDIATE"); return true; }
  catch (e) {
    if ((e as { code?: string }).code === "SQLITE_BUSY") return false;
    throw e;
  }
}

/** Serialize the complete read/validate/write cycle across CLI, MCP and processes.
 * SQLite releases its OS lock on close or process death; no stale-owner recovery.
 * Poll asynchronously so a waiting writer never blocks the active writer's awaits.
 */
export async function withMemoryWriteLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const db = openLock(root);
  const deadline = performance.now() + 30_000;
  try {
    while (!tryAcquire(db)) {
      if (performance.now() >= deadline) throw new Error("memory store is busy; retry this write");
      await delay(25);
    }
    return await action();
  } finally { db.close(); } // closing rolls back the empty transaction and releases the lock
}

/** Synchronous repair callers fail explicitly on contention instead of blocking the event loop. */
export function withMemoryWriteLockSync<T>(root: string, action: () => T): T {
  const db = openLock(root);
  try {
    if (!tryAcquire(db)) throw new Error("memory store is busy; retry this write");
    return action();
  } finally { db.close(); }
}
