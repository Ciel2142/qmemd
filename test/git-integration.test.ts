import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as openQmd, type QMDStore } from "@tobilu/qmd";
import { remember, forget, memoryFilePath } from "../src/engine.js";

// qmemd-k9q: the unit suite (test/git.test.ts) exercises gitCommit/gitPush against an
// injectable runner only — no test ever inited a REAL .git under the memory root. This
// suite does, and asserts the documented invariants end-to-end:
//   - remember()/forget() actually land a commit (message + pathspec + clean tree);
//   - the fact file is written + committed even when reindex FAILS (commit-BEFORE-reindex:
//     an index failure surfaces as indexed:false and must never strand an uncommitted fact).
// Git-availability-gated: skips cleanly on a machine with no git binary.

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!gitAvailable)("remember/forget land real git commits (k9q)", () => {
  let parent: string, root: string, store: QMDStore;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "qmemd-git-"));
    root = join(parent, "mem");
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, "idx"), { recursive: true });
    expect(git(root, "init", "-q").status).toBe(0);
    // Local identity + no signing so commit works regardless of the host's global config.
    git(root, "config", "user.email", "test@qmemd.local");
    git(root, "config", "user.name", "qmemd-test");
    git(root, "config", "commit.gpgsign", "false");
    store = await openQmd({ dbPath: join(parent, "idx", "i.sqlite"), config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  });

  test("remember commits the fact file with the 'remember: <slug>' message", async () => {
    const res = await remember(store, root, { fact: "Use Bun not Node", type: "user" });
    expect(res.wrote).toBe(true);
    expect(res.synced).toBe(true); // committed; push is a benign no-upstream no-op

    const log = git(root, "log", "-1", "--format=%s");
    expect(log.stdout.trim()).toBe("remember: use-bun-not-node");
    const files = git(root, "show", "--name-only", "--format=", "HEAD");
    expect(files.stdout).toContain("user/use-bun-not-node.md");
    // Nothing left uncommitted — the write is fully captured by the commit.
    expect(git(root, "status", "--porcelain").stdout.trim()).toBe("");
  });

  test("forget commits the deletion with the 'forget: <slug>' message", async () => {
    await remember(store, root, { fact: "Use Bun not Node", type: "user" });
    const res = await forget(store, root, "use-bun-not-node");
    expect(res.removed).toBe(true);

    expect(git(root, "log", "-1", "--format=%s").stdout.trim()).toBe("forget: use-bun-not-node");
    expect(existsSync(memoryFilePath(root, "user", "use-bun-not-node"))).toBe(false);
    expect(git(root, "status", "--porcelain").stdout.trim()).toBe("");
  });

  test("the fact is committed even when reindex throws (commit-BEFORE-reindex invariant)", async () => {
    // A store whose update() always fails — the lex index can't be written.
    const broken = {
      update: async () => { throw new Error("SQLITE_BUSY: simulated index failure"); },
      close: async () => {},
    } as unknown as QMDStore;

    // force skips the dedup tiers, so the broken store's search surface is never touched.
    const res = await remember(broken, root, { fact: "Survives index failure", type: "project", force: true });

    expect(res.wrote).toBe(true);
    expect(res.indexed).toBe(false); // failure surfaced, not hidden
    expect(existsSync(memoryFilePath(root, "project", "survives-index-failure"))).toBe(true);
    // The commit landed BEFORE the reindex attempt — the fact is never stranded uncommitted.
    expect(git(root, "log", "-1", "--format=%s").stdout.trim()).toBe("remember: survives-index-failure");
    expect(git(root, "status", "--porcelain").stdout.trim()).toBe("");
  });
});
