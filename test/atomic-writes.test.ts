import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { closeSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QMDStore } from "@tobilu/qmd";
import { remember, markReviewed, serializeMemory } from "../src/engine.js";
import { fixMemory } from "../src/doctor.js";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

describe("atomic fact mutations (qp-g5o)", () => {
  let root: string, path: string, original: string;
  const store = { async update() {}, async searchLex() { return []; } } as unknown as QMDStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-atomic-"));
    await mkdir(join(root, "project"));
    path = join(root, "project", "fact.md");
    original = serializeMemory({ name: "fact", description: "Original fact", type: "project",
      project: "alpha", tags: [], created: "2026-01-01", pinned: false }, "Original body must survive.");
    await writeFile(path, original, { mode: 0o600 });
  });

  afterEach(async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementation(fs.writeFileSync);
    await rm(root, { recursive: true, force: true });
  });

  test.each(["replace", "reviewed", "doctor"])("an interrupted %s write preserves the entire original fact", async operation => {
    if (operation === "doctor") {
      original = original.replace("type: project", "type: invalid");
      await writeFile(path, original);
    }
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (String(file).startsWith(join(root, "project")) && !String(file).endsWith(".bak")) {
        fs.writeFileSync(file, String(data).slice(0, 8), options);
        throw new Error("simulated disk full after partial write");
      }
      return fs.writeFileSync(file, data, options);
    });
    const mutate = async () => {
      if (operation === "replace") await remember(store, root, { replace: "fact", fact: "Replacement body." });
      else if (operation === "reviewed") await markReviewed(store, root, "fact", { ttl: "7d" });
      else fixMemory(root);
    };
    await expect(mutate()).rejects.toThrow("simulated disk full");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(join(root, "project")).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("replacement publishes a complete new inode and preserves private permissions", async () => {
    const fd = openSync(path, "r");
    try {
      await remember(store, root, { replace: "fact", fact: "Replacement body." });
      expect(readFileSync(fd, "utf8")).toBe(original);
      expect(readFileSync(path, "utf8")).toContain("Replacement body.");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { closeSync(fd); }
  });
});
