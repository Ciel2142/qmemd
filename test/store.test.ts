import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  embedModelMarkerPath, readEmbedModelMarker, writeEmbedModelMarker, checkEmbedModelIdentity,
} from "../src/store.js";

describe("embed-model identity marker (qmemd-rkl)", () => {
  let dir: string, db: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "qmemd-store-")); db = join(dir, "index.sqlite"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("marker path is the index path + .embed-model", () => {
    expect(embedModelMarkerPath(db)).toBe(db + ".embed-model");
  });

  test("readEmbedModelMarker returns null when no marker exists", () => {
    expect(readEmbedModelMarker(db)).toBeNull();
  });

  test("write then read round-trips the model id", () => {
    writeEmbedModelMarker(db, "hf:foo/bar.gguf");
    expect(readEmbedModelMarker(db)).toBe("hf:foo/bar.gguf");
  });

  test("checkEmbedModelIdentity persists the model on first use (no marker), no warning", () => {
    const warn = vi.fn();
    const res = checkEmbedModelIdentity(db, "model-A", warn);
    expect(res.mismatch).toBe(false);
    expect(readEmbedModelMarker(db)).toBe("model-A");
    expect(warn).not.toHaveBeenCalled();
  });

  test("checkEmbedModelIdentity is a silent no-op when the model is unchanged", () => {
    writeEmbedModelMarker(db, "model-A");
    const warn = vi.fn();
    const res = checkEmbedModelIdentity(db, "model-A", warn);
    expect(res.mismatch).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test("checkEmbedModelIdentity warns on mismatch and preserves the recorded model", () => {
    writeEmbedModelMarker(db, "model-A");
    const warn = vi.fn();
    const res = checkEmbedModelIdentity(db, "model-B", warn);
    expect(res.mismatch).toBe(true);
    expect(res.recorded).toBe("model-A");
    expect(warn).toHaveBeenCalledOnce();
    // The marker is NOT overwritten on mismatch, so the warning persists until the index
    // is rebuilt — overwriting would silently mask the mixed-vector hazard.
    expect(readEmbedModelMarker(db)).toBe("model-A");
  });
});

describe("openMemoryStore embed-model pinning (qmemd-rkl, integration)", () => {
  test("re-opening the same index with a different QMEMD_EMBED_MODEL warns about the mismatch", async () => {
    const { openMemoryStore } = await import("../src/store.js");
    const dir = mkdtempSync(join(tmpdir(), "qmemd-pin-"));
    const orig = {
      mem: process.env.QMD_MEMORY_DIR, db: process.env.QMEMD_DB, model: process.env.QMEMD_EMBED_MODEL,
    };
    process.env.QMD_MEMORY_DIR = dir;
    process.env.QMEMD_DB = join(dir, "index.sqlite");
    try {
      // First open creates the index and pins model-one (fresh index → authoritative).
      process.env.QMEMD_EMBED_MODEL = "hf:model-one";
      const s1 = await openMemoryStore();
      await s1.close();

      // Second open against the now-existing index with a different model must warn.
      const errs: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => { errs.push(String(m)); });
      process.env.QMEMD_EMBED_MODEL = "hf:model-two";
      const s2 = await openMemoryStore();
      await s2.close();
      spy.mockRestore();

      expect(errs.some((e) => e.toLowerCase().includes("mismatch"))).toBe(true);
    } finally {
      for (const [k, v] of [["QMD_MEMORY_DIR", orig.mem], ["QMEMD_DB", orig.db], ["QMEMD_EMBED_MODEL", orig.model]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
