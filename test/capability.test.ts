import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExplicitMode, isCapableBackend, nodeLlamaCppVersion, getGpuCapability } from "../src/capability.js";

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
