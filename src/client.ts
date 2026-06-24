import { createHash } from "node:crypto";
import { memoryFilePath, assertSafeSlug, MEMORY_TYPES, type MemoryType, type Platform, type RecallResult, type RecallHit } from "./engine.js";

/**
 * Warm-daemon recall delegation (qmemd-vuk). Every `qmemd recall` runs in a cold node
 * process, and the hybrid path pays the embedding-model load (~1.6s measured) on every
 * call — while the HTTP daemon (qmemd-mcp.service) already holds a warm store + model.
 * This client lets the CLI probe that daemon and serve a hybrid recall at warm latency,
 * falling back to the local store path whenever the daemon is unavailable, mismatched,
 * or misbehaving. Strictly best-effort: every failure mode returns null, never throws,
 * never logs — the daemon is an optimization, not a dependency.
 */

export const DEFAULT_HTTP_PORT = 8182;

/** Same resolution as `qmemd mcp --http`: QMEMD_HTTP_PORT when it parses, else 8182. */
export function daemonPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.QMEMD_HTTP_PORT) || DEFAULT_HTTP_PORT;
}

/**
 * Identity of the memory root a daemon serves, exposed on /health. The client only
 * delegates when the daemon's hash equals the hash of its own root — this is what stops
 * a CLI pointed at a different QMD_MEMORY_DIR (every tmp-dir test in this repo, or a dev
 * probing an alternate store) from being silently answered out of the wrong corpus. A
 * hash rather than the path itself: /health stays free of absolute fs paths (qmemd-81n
 * discipline), and equality is all the client needs.
 */
export function rootHash(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

/** CLI-side recall params, mirroring RecallOptions minus lexOnly (lex never delegates). */
export interface DaemonRecallParams {
  query: string;
  type?: MemoryType;
  limit?: number;
  minScore?: number;
  fullBody?: boolean;
  skim?: boolean;
  platform?: Platform | "all";
  project?: string;       // caller's current project — turns on the daemon-side default project gate (qmemd-due)
  crossProject?: boolean; // widen past the project gate to the whole corpus (qmemd-due)
}

export interface DaemonClientOptions {
  port?: number;
  /** Health probe deadline. Short: a dead daemon must cost the cold path ~nothing. */
  healthTimeoutMs?: number;
  /** Recall deadline. Generous: the daemon's first hybrid recall after writes runs the
   *  embed catch-up barrier (bounded by embedTimeoutMs) plus search + rerank. */
  recallTimeoutMs?: number;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 250;
const DEFAULT_RECALL_TIMEOUT_MS = 30_000;

/**
 * Try to serve a hybrid recall from the warm HTTP daemon. Returns the same RecallResult
 * shape the local engine produces (hit paths reconstructed via memoryFilePath, so even
 * `--json` output is identical), or null when the caller should take the local path:
 * daemon down/slow, root mismatch, daemon too old to advertise rootHash (the field ships
 * with the same commit as the /recall `platform` param, so it doubles as the capability
 * marker), non-200, or a malformed response.
 */
export async function tryDaemonRecall(
  root: string,
  params: DaemonRecallParams,
  opts: DaemonClientOptions = {},
): Promise<RecallResult | null> {
  const port = opts.port ?? daemonPort();
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS),
    });
    if (!health.ok) return null;
    const h = (await health.json()) as { status?: string; rootHash?: string };
    if (h.status !== "ok" || h.rootHash !== rootHash(root)) return null;

    // Optionals only when meaningful, so an older daemon never sees a key it would
    // misread and the body stays minimal. platform: "all" travels as the pre-existing
    // allPlatforms switch; a specific platform uses the new param (5gx REST half).
    const body: Record<string, unknown> = { query: params.query };
    if (params.type !== undefined) body.type = params.type;
    if (params.limit !== undefined) body.limit = params.limit;
    if (params.minScore !== undefined) body.minScore = params.minScore;
    if (params.fullBody) body.full = true;
    if (params.skim) body.skim = true;
    if (params.platform === "all") body.allPlatforms = true;
    else if (params.platform !== undefined) body.platform = params.platform;
    if (params.project !== undefined) body.project = params.project;
    if (params.crossProject) body.crossProject = true;

    const res = await fetch(`${base}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hits?: Array<{ slug: string; type: string; description: string; score?: number; body?: string; platforms?: string[]; project?: string }>;
      degraded?: boolean; vectorsPending?: number; moreMatches?: number; belowFloor?: number; saturated?: boolean; crossProjectHidden?: number;
    };
    if (!Array.isArray(json.hits)) return null;
    const hits: RecallHit[] = json.hits.map((h) => {
      // Don't path-join strings from the wire unchecked: a process squatting the port
      // (with a guessed rootHash) could feed traversal slugs into rendered/--json output.
      // assertSafeSlug throws and the closed type check throws → outer catch → null.
      assertSafeSlug(h.slug);
      if (!(MEMORY_TYPES as string[]).includes(h.type)) throw new Error(`unknown type '${h.type}'`);
      return {
        slug: h.slug,
        type: h.type,
        description: h.description,
        score: h.score,
        body: h.body,
        platforms: (h.platforms ?? []) as Platform[],
        project: h.project ?? "global",
        // The DTO is path-free by design (qmemd-81n); the engine builds hit paths as
        // memoryFilePath(root, type, slug), so the reconstruction is exact.
        path: memoryFilePath(root, h.type as MemoryType, h.slug),
      };
    });
    return {
      hits,
      degraded: json.degraded ?? false,
      vectorsPending: json.vectorsPending ?? 0,
      moreMatches: json.moreMatches ?? 0,
      belowFloor: json.belowFloor ?? 0,
      saturated: json.saturated ?? false,
      crossProjectHidden: json.crossProjectHidden ?? 0,
    };
  } catch {
    return null; // unreachable/slow/malformed daemon — the caller's local path is the answer
  }
}
