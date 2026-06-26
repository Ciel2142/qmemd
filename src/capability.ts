import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { createRequire } from "node:module";
import { cacheDir } from "./paths.js";

export type GpuVerdict = "metal" | "cuda" | "vulkan" | false;
export type RecallMode = "lex" | "hybrid";
export type ModePolicy = RecallMode | "auto";
export type ExplicitSource = "lex-flag" | "hybrid-flag" | "env-mode" | "force-cpu" | "llama-gpu" | null;
export interface ExplicitDecision { mode: ModePolicy; source: ExplicitSource; }

// QMD_FORCE_CPU's "off" vocabulary, mirrored from @tobilu/qmd dist/llm.js resolveLlamaGpuMode
// so a value qmd treats as CPU-forced, qmemd does too (and vice-versa).
const CPU_OFF_VALUES = new Set(["false", "off", "none", "disable", "disabled", "0", ""]);

/**
 * Resolve the recall mode from explicit, model-free signals only — no GPU probe.
 * Precedence (highest first): per-call flag, QMEMD_RECALL_MODE, QMD_FORCE_CPU, QMD_LLAMA_GPU.
 * Returns mode "auto" (source null) when nothing decides — the caller then falls through to
 * the warm-daemon attempt and finally the cached GPU probe. The `source` lets the caller
 * tell a user-chosen lex (no note) from a host-driven lex (print a downgrade note).
 */
export function resolveExplicitMode(
  flags: { lex?: boolean; hybrid?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): ExplicitDecision {
  if (flags.lex) return { mode: "lex", source: "lex-flag" };
  if (flags.hybrid) return { mode: "hybrid", source: "hybrid-flag" };
  const m = (env.QMEMD_RECALL_MODE ?? "").trim().toLowerCase();
  if (m === "lex" || m === "hybrid") return { mode: m, source: "env-mode" };
  const forceCpu = (env.QMD_FORCE_CPU ?? "").trim().toLowerCase();
  if (env.QMD_FORCE_CPU !== undefined && !CPU_OFF_VALUES.has(forceCpu)) return { mode: "lex", source: "force-cpu" };
  const gpu = (env.QMD_LLAMA_GPU ?? "").trim().toLowerCase();
  if (gpu === "cuda" || gpu === "metal" || gpu === "vulkan") return { mode: "hybrid", source: "llama-gpu" };
  return { mode: "auto", source: null };
}

/** A host can run hybrid cheaply only when llama.cpp resolved to a real GPU backend. */
export function isCapableBackend(gpu: GpuVerdict): boolean {
  return gpu !== false;
}

/**
 * Probe the ACTUAL resolved node-llama-cpp backend without loading any model.
 * `getLlama({ build: "never" })` resolves the binding (Metal on Mac, CUDA/Vulkan when a
 * working prebuilt loads) and only spawns a binding-test subprocess — no model file is read.
 * `getLlamaGpuTypes` is deliberately NOT used: it reports compile-time support, not runtime
 * reality (it claims cuda/vulkan on hosts where the binary fails to load). Any failure
 * (incl. NoBinaryFoundError when only a source build would work) => false => lex default,
 * which is correct: such a host would otherwise pay a model load or a multi-minute compile.
 */
export async function probeGpuBackend(): Promise<GpuVerdict> {
  try {
    const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
    const llama = await getLlama({ build: "never", gpu: "auto", logLevel: LlamaLogLevel.error });
    const gpu = llama.gpu as GpuVerdict;
    try { await llama.dispose(); } catch { /* best-effort: the binding is lightweight */ }
    return gpu === "metal" || gpu === "cuda" || gpu === "vulkan" ? gpu : false;
  } catch {
    return false;
  }
}

/** Installed node-llama-cpp version (cache-invalidation key). package.json is plain JSON —
 *  safe to require even though the package's index.js uses top-level await. */
export function nodeLlamaCppVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("node-llama-cpp/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface CapabilityCache { gpu: GpuVerdict; nlcVersion: string; probedAt: string; }
export interface CapabilityDeps {
  probe?: () => Promise<GpuVerdict>;
  nlcVersion?: string;
  cacheDir?: string;
  now?: () => string;
}

const VALID_GPU = new Set<unknown>(["metal", "cuda", "vulkan", false]);

/** Read + shape-validate the cache file; any error or invalid shape => null (=> re-probe). */
function readCapabilityCache(file: string): CapabilityCache | null {
  if (!existsSync(file)) return null;
  try {
    const obj = JSON.parse(readFileSync(file, "utf-8")) as Partial<CapabilityCache>;
    if (!VALID_GPU.has(obj.gpu) || typeof obj.nlcVersion !== "string") return null;
    return { gpu: obj.gpu as GpuVerdict, nlcVersion: obj.nlcVersion, probedAt: String(obj.probedAt ?? "") };
  } catch {
    return null;
  }
}

/** Best-effort write; a read-only cache dir must not break recall. */
function writeCapabilityCache(file: string, value: CapabilityCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  } catch { /* best-effort */ }
}

/**
 * The resolved GPU backend for this host, cached at <cacheDir>/gpu-capability.json so the
 * probe is a once-per-host(-per-nlc-version) cost, never per recall. Re-probes only when the
 * cache is missing/corrupt or the node-llama-cpp version changed (a new build could flip the
 * verdict). All deps are injectable for tests so no test ever runs the real probe.
 */
export async function getGpuCapability(deps: CapabilityDeps = {}): Promise<GpuVerdict> {
  const probe = deps.probe ?? probeGpuBackend;
  const nlcVersion = deps.nlcVersion ?? nodeLlamaCppVersion();
  const dir = deps.cacheDir ?? cacheDir();
  const now = deps.now ?? (() => new Date().toISOString());
  const file = pathJoin(dir, "gpu-capability.json");

  const cached = readCapabilityCache(file);
  if (cached && cached.nlcVersion === nlcVersion) return cached.gpu;

  const gpu = await probe();
  writeCapabilityCache(file, { gpu, nlcVersion, probedAt: now() });
  return gpu;
}

/** The default recall mode for this host when nothing explicit decided (uses the cached probe). */
export async function autoRecallMode(deps?: CapabilityDeps): Promise<RecallMode> {
  return isCapableBackend(await getGpuCapability(deps)) ? "hybrid" : "lex";
}

/** Whether a recall handler should consult the auto resolver: only when the caller gave no
 *  explicit lexOnly AND this is not the warm HTTP daemon (which never auto-downgrades). */
export function shouldAutoResolve(lexOnly: boolean | undefined, warmServer: boolean | undefined): boolean {
  return lexOnly === undefined && !warmServer;
}
