import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** Persist a directory entry after rename. Windows does not expose directory fsync. */
export function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Readers see the old complete fact or the new complete fact, never a truncated file. */
export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let mode = 0o666;
  try { mode = statSync(path).mode & 0o777; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  try {
    // Node >=22 flushes the complete staging file before closing it. Exclusive
    // creation prevents a stale temp or symlink from being followed/overwritten.
    writeFileSync(tmp, content, { flag: "wx", mode, flush: true });
    renameSync(tmp, path);
    syncDirectory(dir);
  } finally {
    try { unlinkSync(tmp); } catch { /* consumed by rename, or best-effort cleanup on failure */ }
  }
}
