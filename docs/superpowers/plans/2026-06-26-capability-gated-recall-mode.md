# Capability-gated default recall mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default `qmemd recall` to lex on hosts with no working GPU backend (keeping hybrid on Mac/Metal, working CUDA/Vulkan, and whenever a warm daemon is reachable), decided by an accurate, cached node-llama-cpp backend probe.

**Architecture:** A new `src/capability.ts` owns (a) a synchronous explicit-mode resolver over flags + env, (b) a cached GPU-backend probe via `getLlama({build:"never"})` that loads no model, and (c) thin composition helpers. The CLI recall case and the MCP stdio recall handler compute `lexOnly` from these instead of reading the `--lex`/`lexOnly` flag directly. The warm HTTP daemon is exempt — it amortizes the model load by design.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 22, vitest, `@tobilu/qmd`, `node-llama-cpp`.

## Global Constraints

- Node ≥ 22; package is ESM (`"type": "module"`); TypeScript `strict`.
- **Tests MUST NOT load the embedding model** — exercise lex/filesystem/injected paths only. Never run a real hybrid recall in a test, and never call the real `probeGpuBackend` in a unit test.
- The `qmemd` bin runs `dist/`, but tests run `src/` via `tsx` — no rebuild needed for tests; a final `npm run build` must still pass (`tsc` strict).
- Frontmatter format and `recallQuery` signature are unchanged. `recall --session` is untouched.
- DRY, YAGNI, TDD, frequent commits.
- Pure-lex fallback only — no lex+vec-without-reranker tier.

## File Structure

- **Create** `src/capability.ts` — all capability/mode logic (types, `resolveExplicitMode`, `probeGpuBackend`, `isCapableBackend`, `nodeLlamaCppVersion`, cached `getGpuCapability`, `autoRecallMode`, `shouldAutoResolve`). One responsibility: "what recall mode should this host default to."
- **Create** `test/capability.test.ts` — unit tests for the above (pure + injected probe; no model, no real `getLlama`).
- **Modify** `src/cli/qmemd.ts` — add `--hybrid` flag; compute `lexOnly` via the resolver; gate daemon delegation; emit the downgrade note; update usage text.
- **Modify** `test/cli.test.ts` — add `runCliEnv` helper + 3 deterministic, model-free recall-mode tests.
- **Modify** `src/mcp/server.ts` — add `warmServer` + `resolveAutoMode` to `MemoryServerOptions`; apply `shouldAutoResolve` in the stdio recall path; set `warmServer: true` on the HTTP daemon.
- **Modify** `test/mcp.test.ts` — one in-process test that the stdio server auto-resolves to lex via an injected resolver (model-free).

---

### Task 1: `resolveExplicitMode` — flags + env precedence (no probe)

**Files:**
- Create: `src/capability.ts`
- Test: `test/capability.test.ts`

**Interfaces:**
- Produces:
  - `type GpuVerdict = "metal" | "cuda" | "vulkan" | false`
  - `type RecallMode = "lex" | "hybrid"`
  - `type ModePolicy = RecallMode | "auto"`
  - `type ExplicitSource = "lex-flag" | "hybrid-flag" | "env-mode" | "force-cpu" | "llama-gpu" | null`
  - `interface ExplicitDecision { mode: ModePolicy; source: ExplicitSource }`
  - `resolveExplicitMode(flags: { lex?: boolean; hybrid?: boolean }, env?: NodeJS.ProcessEnv): ExplicitDecision`

- [ ] **Step 1: Write the failing test**

```ts
// test/capability.test.ts
import { describe, test, expect } from "vitest";
import { resolveExplicitMode } from "../src/capability.js";

const E = (env: Record<string, string | undefined>) => env as NodeJS.ProcessEnv;

describe("resolveExplicitMode precedence", () => {
  test("--lex flag wins over everything", () => {
    expect(resolveExplicitMode({ lex: true, hybrid: false }, E({ QMEMD_RECALL_MODE: "hybrid", QMD_FORCE_CPU: "1" })))
      .toEqual({ mode: "lex", source: "lex-flag" });
  });
  test("--hybrid flag wins over env", () => {
    expect(resolveExplicitMode({ hybrid: true }, E({ QMEMD_RECALL_MODE: "lex" })))
      .toEqual({ mode: "hybrid", source: "hybrid-flag" });
  });
  test("QMEMD_RECALL_MODE=lex|hybrid forces when no flag", () => {
    expect(resolveExplicitMode({}, E({ QMEMD_RECALL_MODE: "lex" }))).toEqual({ mode: "lex", source: "env-mode" });
    expect(resolveExplicitMode({}, E({ QMEMD_RECALL_MODE: "HYBRID" }))).toEqual({ mode: "hybrid", source: "env-mode" });
  });
  test("QMD_FORCE_CPU truthy => lex (below QMEMD_RECALL_MODE)", () => {
    expect(resolveExplicitMode({}, E({ QMD_FORCE_CPU: "1" }))).toEqual({ mode: "lex", source: "force-cpu" });
    expect(resolveExplicitMode({}, E({ QMD_FORCE_CPU: "false" }))).toEqual({ mode: "auto", source: null });
  });
  test("QMD_LLAMA_GPU=cuda|metal|vulkan => hybrid", () => {
    expect(resolveExplicitMode({}, E({ QMD_LLAMA_GPU: "cuda" }))).toEqual({ mode: "hybrid", source: "llama-gpu" });
  });
  test("nothing set => auto", () => {
    expect(resolveExplicitMode({}, E({}))).toEqual({ mode: "auto", source: null });
    expect(resolveExplicitMode({}, E({ QMEMD_RECALL_MODE: "auto" }))).toEqual({ mode: "auto", source: null });
    expect(resolveExplicitMode({}, E({ QMEMD_RECALL_MODE: "garbage" }))).toEqual({ mode: "auto", source: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capability.test.ts -t "resolveExplicitMode"`
Expected: FAIL — `Cannot find module '../src/capability.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/capability.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/capability.test.ts -t "resolveExplicitMode"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/capability.ts test/capability.test.ts
git commit -m "feat(capability): explicit recall-mode resolver (flags + env precedence)"
```

---

### Task 2: GPU-backend probe + capability check + nlc version

**Files:**
- Modify: `src/capability.ts`
- Test: `test/capability.test.ts`

**Interfaces:**
- Consumes: `GpuVerdict` (Task 1).
- Produces:
  - `isCapableBackend(gpu: GpuVerdict): boolean`
  - `probeGpuBackend(): Promise<GpuVerdict>` — real binding probe, loads no model; never throws.
  - `nodeLlamaCppVersion(): string` — installed node-llama-cpp version, or `"unknown"`.

- [ ] **Step 1: Write the failing test** (only the pure pieces — never call the real probe in a unit test)

```ts
// append to test/capability.test.ts
import { isCapableBackend, nodeLlamaCppVersion } from "../src/capability.js";

describe("isCapableBackend", () => {
  test("a real GPU backend is capable", () => {
    expect(isCapableBackend("metal")).toBe(true);
    expect(isCapableBackend("cuda")).toBe(true);
    expect(isCapableBackend("vulkan")).toBe(true);
  });
  test("false (CPU / no working backend) is not capable", () => {
    expect(isCapableBackend(false)).toBe(false);
  });
});

describe("nodeLlamaCppVersion", () => {
  test("returns a non-empty string (a semver or 'unknown')", () => {
    expect(typeof nodeLlamaCppVersion()).toBe("string");
    expect(nodeLlamaCppVersion().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capability.test.ts -t "isCapableBackend"`
Expected: FAIL — `isCapableBackend is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `src/capability.ts`)

```ts
import { createRequire } from "node:module";

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
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama({ build: "never", gpu: "auto", logLevel: "error" });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/capability.test.ts -t "isCapableBackend"` then `-t "nodeLlamaCppVersion"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capability.ts test/capability.test.ts
git commit -m "feat(capability): no-model GPU-backend probe + nlc version"
```

---

### Task 3: Cached `getGpuCapability`

**Files:**
- Modify: `src/capability.ts`
- Test: `test/capability.test.ts`

**Interfaces:**
- Consumes: `GpuVerdict`, `probeGpuBackend`, `nodeLlamaCppVersion` (Task 2); `cacheDir` from `./paths.js`.
- Produces:
  - `interface CapabilityCache { gpu: GpuVerdict; nlcVersion: string; probedAt: string }`
  - `interface CapabilityDeps { probe?: () => Promise<GpuVerdict>; nlcVersion?: string; cacheDir?: string; now?: () => string }`
  - `getGpuCapability(deps?: CapabilityDeps): Promise<GpuVerdict>` — probes once, caches the verdict at `<cacheDir>/gpu-capability.json`, re-probes only when the file is missing/corrupt or the nlc version changed.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/capability.test.ts
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGpuCapability } from "../src/capability.js";

describe("getGpuCapability caching", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "qmemd-cap-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("fresh: probes once and writes the cache file", async () => {
    let calls = 0;
    const probe = async () => { calls++; return "cuda" as const; };
    const gpu = await getGpuCapability({ probe, nlcVersion: "1.0.0", cacheDir: dir, now: () => "2026-06-26T00:00:00Z" });
    expect(gpu).toBe("cuda");
    expect(calls).toBe(1);
    const written = JSON.parse(await readFile(join(dir, "gpu-capability.json"), "utf-8"));
    expect(written).toEqual({ gpu: "cuda", nlcVersion: "1.0.0", probedAt: "2026-06-26T00:00:00Z" });
  });

  test("cache hit: same version => no re-probe", async () => {
    let calls = 0;
    const probe = async () => { calls++; return false as const; };
    const deps = { probe, nlcVersion: "1.0.0", cacheDir: dir };
    expect(await getGpuCapability(deps)).toBe(false);
    expect(await getGpuCapability(deps)).toBe(false);
    expect(calls).toBe(1);
  });

  test("stale version => re-probe and overwrite", async () => {
    await writeFile(join(dir, "gpu-capability.json"), JSON.stringify({ gpu: "metal", nlcVersion: "0.9.0", probedAt: "x" }));
    let calls = 0;
    const probe = async () => { calls++; return false as const; };
    expect(await getGpuCapability({ probe, nlcVersion: "1.0.0", cacheDir: dir })).toBe(false);
    expect(calls).toBe(1);
  });

  test("corrupt cache => re-probe", async () => {
    await writeFile(join(dir, "gpu-capability.json"), "{ not json");
    let calls = 0;
    const probe = async () => { calls++; return "vulkan" as const; };
    expect(await getGpuCapability({ probe, nlcVersion: "1.0.0", cacheDir: dir })).toBe("vulkan");
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capability.test.ts -t "getGpuCapability"`
Expected: FAIL — `getGpuCapability is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `src/capability.ts`)

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { cacheDir } from "./paths.js";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/capability.test.ts -t "getGpuCapability"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/capability.ts test/capability.test.ts
git commit -m "feat(capability): cached GPU-capability verdict with version invalidation"
```

---

### Task 4: `autoRecallMode` + `shouldAutoResolve`

**Files:**
- Modify: `src/capability.ts`
- Test: `test/capability.test.ts`

**Interfaces:**
- Consumes: `getGpuCapability`, `isCapableBackend`, `CapabilityDeps` (Task 3).
- Produces:
  - `autoRecallMode(deps?: CapabilityDeps): Promise<RecallMode>` — `"hybrid"` when the cached backend is capable, else `"lex"`.
  - `shouldAutoResolve(lexOnly: boolean | undefined, warmServer: boolean | undefined): boolean` — true only when no explicit `lexOnly` was given AND the server is not the warm daemon.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/capability.test.ts
import { autoRecallMode, shouldAutoResolve } from "../src/capability.js";

describe("autoRecallMode", () => {
  test("capable backend => hybrid", async () => {
    expect(await autoRecallMode({ probe: async () => "cuda", nlcVersion: "1", cacheDir: dirForAuto() })).toBe("hybrid");
  });
  test("weak backend => lex", async () => {
    expect(await autoRecallMode({ probe: async () => false, nlcVersion: "1", cacheDir: dirForAuto() })).toBe("lex");
  });
});

describe("shouldAutoResolve", () => {
  test("undefined lexOnly + cold server => resolve", () => {
    expect(shouldAutoResolve(undefined, false)).toBe(true);
    expect(shouldAutoResolve(undefined, undefined)).toBe(true);
  });
  test("explicit lexOnly => never resolve", () => {
    expect(shouldAutoResolve(true, false)).toBe(false);
    expect(shouldAutoResolve(false, false)).toBe(false);
  });
  test("warm daemon => never resolve", () => {
    expect(shouldAutoResolve(undefined, true)).toBe(false);
  });
});
```

Add this helper near the top of the test file (after imports) so each `autoRecallMode` case gets a clean cache dir:

```ts
import { mkdtempSync } from "node:fs";
function dirForAuto(): string { return mkdtempSync(join(tmpdir(), "qmemd-auto-")); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capability.test.ts -t "autoRecallMode"`
Expected: FAIL — `autoRecallMode is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `src/capability.ts`)

```ts
/** The default recall mode for this host when nothing explicit decided (uses the cached probe). */
export async function autoRecallMode(deps?: CapabilityDeps): Promise<RecallMode> {
  return isCapableBackend(await getGpuCapability(deps)) ? "hybrid" : "lex";
}

/** Whether a recall handler should consult the auto resolver: only when the caller gave no
 *  explicit lexOnly AND this is not the warm HTTP daemon (which never auto-downgrades). */
export function shouldAutoResolve(lexOnly: boolean | undefined, warmServer: boolean | undefined): boolean {
  return lexOnly === undefined && !warmServer;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/capability.test.ts`
Expected: PASS (all capability tests).

- [ ] **Step 5: Commit**

```bash
git add src/capability.ts test/capability.test.ts
git commit -m "feat(capability): autoRecallMode + shouldAutoResolve composition helpers"
```

---

### Task 5: CLI — `--hybrid` flag, mode resolution, downgrade note

**Files:**
- Modify: `src/cli/qmemd.ts` (imports near top; parseArgs `options` block ~line 200; recall case ~lines 304-358; usage strings line 175 + 304)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `resolveExplicitMode`, `autoRecallMode`, `RecallMode` from `../capability.js`.
- Produces: CLI behavior — `--hybrid` forces hybrid; `--lex`/`--hybrid` mutually exclusive; auto/host-driven lex prints a stderr note.

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/cli.test.ts (after the existing runCli helper)
function runCliEnv(args: string[], root: string, extraEnv: Record<string, string>) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, QMD_MEMORY_DIR: root, QMEMD_DB: join(root, ".idx", "i.sqlite"), ...extraEnv },
  });
}

describe("recall mode resolution (capability gate)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-mode-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("--lex and --hybrid are mutually exclusive", () => {
    const res = runCli(["recall", "anything", "--lex", "--hybrid"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("mutually exclusive");
  });

  test("QMD_FORCE_CPU forces lex and prints a downgrade note (model-free)", () => {
    expect(runCli(["remember", "rabbit season fact", "--type", "project"], root).status).toBe(0);
    const res = runCliEnv(["recall", "rabbit"], root, { QMD_FORCE_CPU: "1" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("rabbit season fact");
    expect(res.stderr).toContain("lex recall");
  });

  test("QMEMD_RECALL_MODE=lex forces lex WITHOUT a note (user chose it)", () => {
    expect(runCli(["remember", "duck season fact", "--type", "project"], root).status).toBe(0);
    const res = runCliEnv(["recall", "duck"], root, { QMEMD_RECALL_MODE: "lex" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("duck season fact");
    expect(res.stderr).not.toContain("lex recall");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts -t "recall mode resolution"`
Expected: FAIL — `--lex --hybrid` is accepted today (no mutual-exclusion error), and no downgrade note is printed.

- [ ] **Step 3: Implement**

3a. Add the import near the other `../` imports at the top of `src/cli/qmemd.ts`:

```ts
import { resolveExplicitMode, autoRecallMode, type RecallMode } from "../capability.js";
```

3b. In the parseArgs `options` block, add `hybrid` next to `lex`:

```ts
    pin: { type: "boolean" }, force: { type: "boolean" }, lex: { type: "boolean" }, hybrid: { type: "boolean" },
```

3c. In the `recall` case, immediately after the line `const platform = allPlatforms ? "all" : requireValidPlatform(values.platform);`, insert:

```ts
      // --lex / --hybrid force the mode for this call and are mutually exclusive — like
      // --platform/--all-platforms, reject the combo instead of letting one silently win.
      if (values.lex && values.hybrid) {
        console.error("--lex and --hybrid are mutually exclusive — pass only one. --lex forces lexical (fast, model-free); --hybrid forces full hybrid recall.");
        process.exit(1);
      }
      const modeDecision = resolveExplicitMode({ lex: !!values.lex, hybrid: !!values.hybrid });
```

3d. Change the daemon-delegation gate from `if (!values.lex) {` to:

```ts
      // Warm daemon serves hybrid at warm latency — try it for any non-lex mode (incl. auto:
      // a reachable warm daemon outranks the local probe). Explicit lex never delegates.
      if (modeDecision.mode !== "lex") {
```

3e. Replace the local-store recall block (the `const store = await openMemoryStore(); try { ... } finally {...}` after the daemon block) with:

```ts
      const store = await openMemoryStore();
      try {
        // No warm daemon answered. Auto resolves via the cached GPU probe; explicit modes pass through.
        const mode: RecallMode = modeDecision.mode === "auto" ? await autoRecallMode() : modeDecision.mode;
        const lexOnly = mode === "lex";
        // Downgrade note: only when lex was host-driven (forced-CPU or the auto probe), never when
        // the user explicitly asked for lex. Stderr only, so --json output is untouched.
        if (lexOnly && !values.json) {
          if (modeDecision.source === "force-cpu")
            console.error(`${y}note:${r} QMD_FORCE_CPU set — using lex recall (fast). Force hybrid with --hybrid.`);
          else if (modeDecision.mode === "auto")
            console.error(`${y}note:${r} CPU-only host — using lex recall (fast). Force hybrid with --hybrid or QMEMD_RECALL_MODE=hybrid.`);
        }
        const result = await recallQueryWithStatus(store, root, query, {
          type, limit, lexOnly, fullBody: !!values.full, skim: !!values.skim, minScore, platform, project, crossProject,
        });
        printRecallResult(result, !!values.json, minScore, { project, crossProject });
      } finally { await store.close(); }
```

3f. Update the two usage strings to advertise `--hybrid` (line ~175 and the recall-case `Usage:` at ~line 304). Change `[--lex]` to `[--lex|--hybrid]` in both:

```ts
  console.log("  qmemd recall <query> [--lex|--hybrid] [--cross-project] [--type T] [--platform P|--all-platforms] [--limit N] [--full] [--skim] [--json]");
```

```ts
      if (!query) { console.error(`Usage: qmemd recall <query> [--lex|--hybrid] [--type T] [--platform P|--all-platforms] [--limit N] [--min-score N] [--full] [--skim] [--json]\n       qmemd recall --session`); process.exit(1); }
```

(Leave the existing `--min-score is ignored with --lex` note keyed on `values.lex` — it concerns the explicit flag and is out of scope here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli.test.ts -t "recall mode resolution"`
Expected: PASS (3 tests). Then run the whole CLI file to catch regressions: `npx vitest run test/cli.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/qmemd.ts test/cli.test.ts
git commit -m "feat(cli): capability-gated recall default + --hybrid flag"
```

---

### Task 6: MCP — warm-daemon exemption + stdio auto-resolution

**Files:**
- Modify: `src/mcp/server.ts` (imports; `MemoryServerOptions` ~line 93; recall handler ~line 258; `startMcpHttpServer`'s `buildMemoryServer` call ~line 512)
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `shouldAutoResolve`, `autoRecallMode`, `RecallMode` from `../capability.js`.
- Produces: `MemoryServerOptions.warmServer?: boolean` and `MemoryServerOptions.resolveAutoMode?: () => Promise<RecallMode>`; stdio recall defaults to lex on a weak host; HTTP daemon recall is unchanged (always hybrid by default).

- [ ] **Step 1: Write the failing test**

```ts
// append to test/mcp.test.ts (a new describe; reuses the file's tmp-store pattern)
import { buildMemoryServer } from "../src/mcp/server.js";

describe("MCP recall capability gate", () => {
  test("stdio server auto-resolves an unspecified recall to lex on a weak host", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmemd-mcpcap-"));
    const dbDir = await mkdtemp(join(tmpdir(), "qmemd-mcpcapdb-"));
    const store = await openQmd({ dbPath: join(dbDir, "i.sqlite"), config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });

    let resolverCalls = 0;
    const server = buildMemoryServer(store, root, { resolveAutoMode: async () => { resolverCalls++; return "lex"; } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(ct);

    // Seed a fact via the remember tool (writes md + lex-reindex; no model).
    await client.callTool({ name: "remember", arguments: { fact: "wabbit tracks here", type: "project" } });

    // Recall WITHOUT lexOnly => the cold stdio server must consult the resolver and run lex.
    const res = await client.callTool({ name: "recall", arguments: { query: "wabbit" } });
    const text = (res.content as Array<{ type: string; text: string }>).map(c => c.text).join("\n");

    expect(resolverCalls).toBe(1);
    expect(text).toContain("wabbit tracks here");

    await client.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcp.test.ts -t "capability gate"`
Expected: FAIL — `resolveAutoMode` is not an accepted option / `resolverCalls` is 0 (handler ignores it today).

- [ ] **Step 3: Implement**

3a. Add the import near the other `../` imports at the top of `src/mcp/server.ts`:

```ts
import { shouldAutoResolve, autoRecallMode, type RecallMode } from "../capability.js";
```

3b. Extend `MemoryServerOptions` (after the `gitDeps` field, before the closing `}`):

```ts
  /** True only for the warm HTTP daemon: it amortizes the model load by design and never
   *  auto-downgrades. The per-session stdio server leaves this false, so on a CPU-only host
   *  its default recall resolves to lex (the capability gate). */
  warmServer?: boolean;
  /** Injectable auto-mode resolver (tests). Production uses capability.autoRecallMode. */
  resolveAutoMode?: () => Promise<RecallMode>;
```

3c. In the recall handler, replace the single `recallQueryWithStatus(...)` call at ~line 259 with a computed `effectiveLexOnly`:

```ts
      // Capability gate: when the caller gave no explicit lexOnly AND this is not the warm
      // daemon, default the mode from the host's GPU capability (lex on a CPU-only box).
      let effectiveLexOnly = lexOnly;
      if (shouldAutoResolve(lexOnly, opts.warmServer)) {
        const mode = await (opts.resolveAutoMode ?? autoRecallMode)();
        effectiveLexOnly = mode === "lex";
      }
      const { hits, degraded, vectorsPending, moreMatches, belowFloor, saturated, crossProjectHidden } = await recallQueryWithStatus(store, root, query, { type, limit, lexOnly: effectiveLexOnly, minScore, skim, platform: allPlatforms ? "all" : platform, project: currentProject, crossProject: cross_project });
```

3d. In `startMcpHttpServer`, add `warmServer: true` to the `buildMemoryServer(store, root, { ... })` options (~line 512):

```ts
  const server = buildMemoryServer(store, root, { sessionDefaultProject: "global", warmServer: true });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mcp.test.ts -t "capability gate"`
Expected: PASS. Then the whole MCP file: `npx vitest run test/mcp.test.ts` — Expected: PASS (existing tests pass `lexOnly` explicitly, so `shouldAutoResolve` returns false and they are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/mcp.test.ts
git commit -m "feat(mcp): stdio recall capability gate; warm daemon stays hybrid"
```

---

### Task 7: Build + full suite + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Type-check / build**

Run: `npm run build`
Expected: `tsc` exits 0, no errors. (Catches any strict-mode / unused-symbol slips across the edits.)

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green. No test loads the embedding model (no multi-second model-load lines; suite runtime unchanged from baseline).

- [ ] **Step 3: Manual smoke — mutual exclusion + downgrade note**

Run:
```bash
npm run qmemd -- recall "x" --lex --hybrid; echo "exit=$?"
QMD_FORCE_CPU=1 npm run qmemd -- recall "anything"
```
Expected: first prints the mutual-exclusion error and `exit=1`; second prints a `note: QMD_FORCE_CPU set — using lex recall ...` line on stderr and returns results (no model load).

- [ ] **Step 4: Commit (if any doc/touch-ups)**

```bash
git add -A
git commit -m "test: verify capability-gated recall end-to-end" --allow-empty
```

---

## Self-Review

**Spec coverage**

- Detection via trustworthy `getLlama({build:"never"}).gpu`, not `getLlamaGpuTypes` → Task 2 (`probeGpuBackend`, with the rationale comment).
- Caching at `<cacheDir>/gpu-capability.json` with version invalidation → Task 3.
- Mode-resolution precedence (flag > QMEMD_RECALL_MODE > QMD_FORCE_CPU/QMD_LLAMA_GPU > daemon > probe) → Task 1 (`resolveExplicitMode` for the explicit tiers), Task 5 (daemon gate sits between explicit and probe), Task 4 (`autoRecallMode` for the probe tier).
- Integration at CLI cold path + MCP stdio; HTTP daemon stays hybrid → Tasks 5 and 6.
- Surfacing one-line downgrade note, stderr only, `--json` untouched → Task 5.
- Failure direction (probe throw ⇒ lex) → Task 2 (`probeGpuBackend` catch ⇒ false ⇒ lex).
- Testing with injected probe, no model load → Tasks 1-4 (capability.test.ts), 5 (force-cpu/env, model-free), 6 (injected resolver, lex only).
- Out of scope (lex+vec tier, daemon behavior, `recall --session`) → respected; none touched.

**Placeholder scan:** none — every code/test step has full content.

**Type consistency:** `GpuVerdict`, `RecallMode`, `ModePolicy`, `ExplicitDecision`, `CapabilityDeps`, `CapabilityCache` are defined in Task 1-3 and consumed verbatim later. `resolveExplicitMode` / `probeGpuBackend` / `isCapableBackend` / `nodeLlamaCppVersion` / `getGpuCapability` / `autoRecallMode` / `shouldAutoResolve` signatures match across producer and consumer tasks. CLI/MCP both import from `../capability.js`; tests from `../src/capability.js`.

**Known one-time blemish (documented, not a blocker):** the first real `probeGpuBackend` on a host with no working prebuilt emits node-llama-cpp native "Failed to load a prebuilt binary…" lines on stderr before returning `false`. The verdict is then cached, so it is a one-time occurrence. Silencing it (child-process probe isolation) is a deliberate follow-up, not in this plan.
