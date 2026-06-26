# Capability-gated default recall mode

- **Date:** 2026-06-26
- **Status:** Approved design — ready for implementation plan
- **Component:** `qmemd` recall path (CLI + MCP stdio), new `src/capability.ts`

## Problem

The recall default is **unconditionally hybrid** (lex + vec + Qwen3 reranker). On a
host with no working GPU backend, the first cold hybrid recall pays the full
embedding-model load (~1.6s measured) plus slow CPU inference (~580ms/query warm),
and a host with no prebuilt llama.cpp binary at all would pay a multi-minute
`build:"auto"` compile on first use. That is a poor default for a weak, CPU-only box.

Lex recall is model-free (~0ms) and already strong (P@1 0.867 vs hybrid 0.933 on the
golden set). On a host that cannot run the models cheaply, lex is the better default.

## Goals

- Default to **lex** on hosts with no working GPU backend; keep **hybrid** on capable
  hosts (Mac/Metal, working CUDA/Vulkan) and whenever a warm daemon is reachable.
- Detect capability **accurately** (actual resolved backend), not by a crude
  `platform === darwin` proxy that would wrongly downgrade GPU Linux/Windows boxes.
- Keep the probe cheap (no model load) and cached (once per host, not per recall).
- Preserve every explicit override; never silently strand a user who wants hybrid.

## Non-goals (YAGNI)

- A "lex+vec without reranker" middle tier. qmd fuses vec+rerank in one hybrid call;
  a middle tier is net-new code and would still load the 300M embed model — most of
  the cold-start cost — for marginal recall gain.
- Changing warm-daemon behavior. The HTTP daemon amortizes the load by design and
  must keep serving hybrid.
- Touching `recall --session`. The session snapshot is already filesystem-only (no
  model) and unaffected.

## Key findings (evidence)

1. **qmemd has exactly two modes.** `recallQuery(..., { lexOnly })`: `true` = BM25,
   model-free; `false` = hybrid (lex + vec + reranker, both models). No vec-only path
   is exposed (`src/engine.ts`, `lexOnly?: boolean` ~line 1644).
2. **qmd runs models via node-llama-cpp with `gpu:"auto"`** — Metal on Mac, CUDA/Vulkan
   when a working prebuilt loads, else CPU (`node_modules/@tobilu/qmd/dist/llm.js`
   `resolveLlamaGpuMode` / `ensureLlama`). GPU is **not** Mac-only.
3. **The cheap probe lies.** `getLlamaGpuTypes('supported')` returned
   `["cuda","vulkan",false]` (~220ms) on the dev box, but the real binding load
   (`getLlama({ build:'never' })`) **failed** there — CUDA prebuilt binary test fails →
   Vulkan fails → no GPU → `NoBinaryFoundError`. `getLlamaGpuTypes` reports compile-time
   support, not runtime reality. It must NOT be the signal.
4. **The trustworthy probe is `getLlama({ build:'never', gpu:'auto' }).gpu`** — it
   resolves the actual working backend and loads no model (only a binding-test
   subprocess, sub-second). `'metal'|'cuda'|'vulkan'` ⇒ capable; `false` or a throw
   ⇒ weak.
5. A `platform`-aware recall seam already exists (`qmemd-vuk`): the CLI delegates hybrid
   to a warm daemon via a `/health` probe, and `--lex` never probes. The new logic
   slots into that seam.

## Design

### Capability truth table

| Host resolves to | Today | After |
|---|---|---|
| Metal (Mac) | hybrid | hybrid (unchanged) |
| CUDA / Vulkan prebuilt loads | hybrid | hybrid (unchanged) |
| CPU-only / no working prebuilt | hybrid (slow cold load) | **lex** |
| Warm daemon reachable | hybrid (delegated) | hybrid (unchanged — already cheap) |
| `--lex` explicit | lex | lex (unchanged) |

### 1. Detection — new `src/capability.ts`

- `probeGpuBackend(): Promise<'metal'|'cuda'|'vulkan'|false>` —
  `getLlama({ build:'never', gpu:'auto', logLevel:'error' })`, return `llama.gpu`.
  Catch every error (incl. `NoBinaryFoundError`) → return `false`. Loads no model.
- `isCapableBackend(gpu)` ⇒ `gpu !== false`.
- Conservative-by-design: a host with no prebuilt that *would* compile via
  `build:"auto"` is classified weak → lex, because its first hybrid recall would
  otherwise pay a multi-minute compile. It opts back in explicitly (see overrides).

### 2. Caching

- Verdict cached at `join(cacheDir(), "gpu-capability.json")` (reusing
  `paths.ts:cacheDir()` → `$XDG_CACHE_HOME/qmemd` or `~/.cache/qmemd`):
  `{ gpu: 'metal'|'cuda'|'vulkan'|false, nlcVersion: string, probedAt: string }`.
- Re-probe only when the file is missing or `nlcVersion` differs from the installed
  node-llama-cpp version. Best-effort read/write; a corrupt or unwritable cache
  falls back to a live probe and never throws.
- Net effect: the probe is a once-per-host(-per-nlc-version) cost, never per-recall.

### 3. Mode resolution — `resolveRecallMode()` (engine-level helper)

Precedence, highest first; returns `'lex' | 'hybrid'`:

1. Explicit per-call flag — `--lex` / `--hybrid` (CLI), `lexOnly` (MCP/REST) → wins.
2. `QMEMD_RECALL_MODE` = `lex` | `hybrid` | `auto` (default `auto`). `lex`/`hybrid`
   force; `auto` continues.
3. qmd's own knobs (honored, skip probe): `QMD_FORCE_CPU` set ⇒ `lex`;
   `QMD_LLAMA_GPU` = `cuda|metal|vulkan` ⇒ `hybrid`.
4. Warm daemon reachable (existing `tryDaemonRecall` health probe succeeds) ⇒
   `hybrid` (delegate; already warm).
5. Else `auto` ⇒ cached GPU probe: capable ⇒ `hybrid`, weak ⇒ `lex`.

`lexOnly` passed to `recallQuery` is then computed from this result rather than read
straight off `values.lex`.

### 4. Integration points

- The decision lives at the recall entry shared by the **CLI cold path** and **MCP
  stdio**, so both honor it uniformly.
- The **HTTP daemon keeps hybrid** — it is the warm server; it never self-downgrades.
  (When the CLI reaches a warm daemon, rule 4 already yields hybrid.)
- `recall --session` is untouched (model-free already).

### 5. Surfacing

When `auto` downgrades to lex, emit one stderr note (mirrors the existing
"hybrid recall degraded to lexical" note):

```
note: CPU-only host — using lex recall (fast). Force hybrid with --hybrid or QMEMD_RECALL_MODE=hybrid.
```

`--json` output is unaffected (note goes to stderr, not the JSON payload).

### 6. Failure direction

If the probe throws unexpectedly (not just `NoBinaryFoundError` — e.g. a crash):
treat as **weak ⇒ lex**, logged once. A host that cannot complete a binding probe
should not be handed a cold model load.

## New / changed surfaces

- **New:** `src/capability.ts` — `probeGpuBackend`, `isCapableBackend`, cached
  `getGpuCapability`, `resolveRecallMode`.
- **Changed:** `src/cli/qmemd.ts` recall case — add `--hybrid` flag; compute `lexOnly`
  via `resolveRecallMode` instead of `!!values.lex`; keep `--lex`/`--hybrid` mutually
  exclusive; emit the downgrade note.
- **Changed:** MCP stdio recall tool (`src/mcp/server.ts`) — same `resolveRecallMode`
  for its cold path; HTTP daemon path forces hybrid.
- **Unchanged:** `recallQuery` signature, the warm-daemon delegation, `recall --session`.

## Config / env reference

| Knob | Values | Effect |
|---|---|---|
| `--lex` / `--hybrid` (CLI) | flag | Force mode for one call; mutually exclusive |
| `QMEMD_RECALL_MODE` | `auto` (default) `lex` `hybrid` | Default mode policy |
| `QMD_FORCE_CPU` | set/truthy | Forces lex (host can't run GPU) |
| `QMD_LLAMA_GPU` | `cuda` `metal` `vulkan` | Asserts GPU ⇒ hybrid, skip probe |

## Testing strategy

- Unit-test `resolveRecallMode` against the precedence list with an **injected** probe
  verdict and env permutations — assert the full truth table. No real `getLlama`, no
  model load (project rule: tests must not load the embedding model).
- Unit-test cache read/write/invalidation (fresh, stale `nlcVersion`, corrupt file)
  over a tmp `XDG_CACHE_HOME`.
- CLI test: `--lex` and `--hybrid` mutually exclusive; `--hybrid` overrides an `auto`
  weak verdict; downgrade note present on stderr only.

## Out of scope

- lex+vec-no-rerank tier; warm-daemon behavior changes; `recall --session` changes;
  any change to capable-host behavior (Mac/working-GPU recall is byte-for-byte today's).
