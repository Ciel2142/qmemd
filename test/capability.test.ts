import { describe, test, expect } from "vitest";
import { resolveExplicitMode, isCapableBackend, nodeLlamaCppVersion } from "../src/capability.js";

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
