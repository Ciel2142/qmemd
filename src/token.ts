import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./paths.js";

/**
 * Shared secret for the HTTP daemon (qp-http-daemon-no-auth-mio).
 *
 * The pre-existing guard chain (loopback Host, Origin, JSON content-type) defends the
 * browser threat model and nothing else: a non-browser client sends no Origin (allowed by
 * design), GETs carry no content-type, and the Host really is loopback — so ANY process on
 * the machine could read the whole corpus through `/list`, `/get`, `/recall` or `/mcp`.
 * A shared secret is what separates "this user's qmemd CLI" from "any other local process".
 *
 * The token is minted by the daemon on first start and lives 0600 under cacheDir(), which
 * already honours XDG_CACHE_HOME — so it follows the pid/log files, tests redirect it for
 * free, and the secret never lands in a unit file, an env dump, or a URL.
 */

/** Header the daemon reads the token from. Node lowercases incoming header names. */
export const DAEMON_TOKEN_HEADER = "x-qmemd-token";

export function daemonTokenPath(): string {
  return join(cacheDir(), "daemon-token");
}

/** The token, or null when no daemon has ever minted one (or it is unreadable). */
export function readDaemonToken(): string | null {
  try {
    const raw = readFileSync(daemonTokenPath(), "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Server side: the token, minting one on first start. Written to a private temp file and
 * renamed into place so the secret is never briefly world-readable, and never half-written
 * for a client reading concurrently.
 */
export function readOrCreateDaemonToken(): string {
  const existing = readDaemonToken();
  if (existing) return existing;

  const path = daemonTokenPath();
  mkdirSync(cacheDir(), { recursive: true });
  const token = randomBytes(32).toString("hex");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* the rename failure is what matters */ }
    throw e;
  }
  // A daemon that raced us to the file wins: both sides must agree on one value.
  return readDaemonToken() ?? token;
}

/** Constant-time comparison. False on an absent, differently-sized, or wrong token. */
export function tokenMatches(expected: string, presented: string | string[] | undefined): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(presented, "utf-8");
  // timingSafeEqual throws on a length mismatch; a length difference is not secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
