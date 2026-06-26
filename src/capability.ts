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
