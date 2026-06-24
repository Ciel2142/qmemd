import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as openQmd, type QMDStore } from "@tobilu/qmd";
import {
  remember, forget, getFact, assertSafeSlug, slugify, serializeMemory,
} from "../../src/engine.js";
import { toHitDTO, toFactDTO, toListEntryDTO } from "../../src/mcp/server.js";

// qmemd-4lr: the security invariants, grouped explicitly and exercised as ATTACKS
// against the real public surfaces — not just unit calls on the guard function.
// Each test fails if its guard is removed from the surface it protects:
//   - assertSafeSlug on forget()/remember(replace)/getFact()  (qmemd-fd8)
//   - newline slug → git commit-trailer forgery               (qmemd-fd8)
//   - DTO mappers never leak an absolute fs path              (qmemd-81n)
// Surface-level twins live in test/cli.test.ts (jzz: CLI --type traversal e2e)
// and test/dto.test.ts (81n: per-mapper field allowlists).

// A slug that path.join() would normalize to OUTSIDE the memory root:
// join(root, "<type>", "../../canary") === join(parent, "canary").
const HOSTILE_SLUGS = ["../../canary", "..", "a/b", "a\\b", "/abs", "x/../y", ""];

describe("adversarial: traversal slugs against the real engine surfaces (fd8)", () => {
  let parent: string, root: string, canary: string, store: QMDStore;
  const CANARY_BODY = "CANARY — must never be read, written, or deleted through qmemd.";

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "qmemd-adv-"));
    root = join(parent, "mem");
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, "idx"), { recursive: true });
    // The canary is a VALID memory file one level above the root: if a traversal
    // slug ever reaches the fs layer, reading it would succeed, deleting it would
    // succeed, and the test below would catch either.
    canary = join(parent, "canary.md");
    await writeFile(canary, serializeMemory(
      { name: "canary", description: "canary", type: "user", tags: [], project: "global", created: "2026-06-01", pinned: false },
      CANARY_BODY));
    store = await openQmd({ dbPath: join(parent, "idx", "i.sqlite"), config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  });

  test("forget() rejects every hostile slug before touching the filesystem", async () => {
    for (const slug of HOSTILE_SLUGS) {
      await expect(forget(store, root, slug)).rejects.toThrow(/unsafe slug/);
    }
    await expect(readFile(canary, "utf-8")).resolves.toContain(CANARY_BODY);
  });

  test("remember --replace rejects every hostile slug and writes nothing outside root", async () => {
    for (const slug of HOSTILE_SLUGS) {
      await expect(remember(store, root, { fact: "poison", type: "user", replace: slug }))
        .rejects.toThrow(/unsafe slug/);
    }
    await expect(readFile(canary, "utf-8")).resolves.toContain(CANARY_BODY);
    // Nothing new appeared next to the root (the join-normalized escape target).
    expect((await readdir(parent)).sort()).toEqual(["canary.md", "idx", "mem"]);
  });

  test("remember --supersedes rejects a traversal target", async () => {
    await expect(remember(store, root, { fact: "poison", type: "user", supersedes: "../../canary" }))
      .rejects.toThrow(/unsafe slug/);
    await expect(readFile(canary, "utf-8")).resolves.toContain(CANARY_BODY);
  });

  test("getFact() refuses to read through a traversal slug (canary stays unreadable)", () => {
    for (const slug of HOSTILE_SLUGS) {
      expect(() => getFact(root, slug)).toThrow(/unsafe slug/);
    }
  });

  test("a newline slug is rejected BEFORE any git invocation (commit-trailer forgery)", async () => {
    const run = vi.fn(() => 0);
    await expect(forget(store, root, "ok\nCo-Authored-By: Evil <e@x>", { run }))
      .rejects.toThrow(/unsafe slug/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("adversarial: slugify() can never emit a slug the guard rejects", () => {
  test("nasty inputs slugify to '' or to a guard-passing slug", () => {
    const NASTY = [
      "../../etc/passwd", "..\\..\\windows", "a/b/c", "x\ny", "x\ry",
      "....", "  ", "日本語だけ", "-—–-", "a".repeat(500), ".hidden", "C:\\evil",
    ];
    for (const input of NASTY) {
      const s = slugify(input);
      if (s !== "") expect(() => assertSafeSlug(s)).not.toThrow();
    }
  });
});

describe("adversarial: structuredContent payloads never carry the store's fs layout (81n)", () => {
  const SECRET_ROOT = "/home/victim/.local/share/qmd-memory";

  /** Walk any JSON-able payload; collect every string value. */
  const strings = (v: unknown): string[] => {
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) return v.flatMap(strings);
    if (v && typeof v === "object") return Object.values(v).flatMap(strings);
    return [];
  };

  test("recall/get/list-shaped payloads built from path-bearing facts are path-free", () => {
    const hit = toHitDTO({
      slug: "s", path: `${SECRET_ROOT}/project/s.md`, type: "project",
      description: "d", score: 0.9, body: "b", platforms: [],
    });
    const fact = toFactDTO({
      slug: "s", type: "project", path: `${SECRET_ROOT}/project/s.md`, body: "b",
      frontmatter: { name: "s", description: "d", type: "project", tags: [], project: "global", platforms: [], created: "2026-06-01", pinned: false },
    });
    const entry = toListEntryDTO({
      slug: "s", type: "project", description: "d", tags: [], created: "2026-06-01", pinned: false, platforms: [],
    });
    // Composed exactly like the MCP tool results / REST bodies.
    const payloads = [{ hits: [hit], degraded: false }, fact, { entries: [entry] }];
    for (const p of payloads) {
      for (const s of strings(p)) {
        expect(s).not.toContain(SECRET_ROOT);
        expect(s).not.toMatch(/^\/|^[A-Za-z]:\\/); // no absolute unix/windows path in any field
      }
    }
  });
});
