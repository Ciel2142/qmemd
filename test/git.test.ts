import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommit, gitPush, gitPullFfOnly, sessionSyncWarning, nonInteractiveGitEnv, type GitRun } from "../src/git.js";

/**
 * Fake runner: records argv. `rev-parse --is-inside-work-tree` returns 0 iff `isRepo` (the
 * repo gate, qmemd-3xf); `rev-parse @{u}` returns 0 iff `upstream`.
 * `diff --cached --quiet` returns 0 (clean) iff `staged === false`, else 1 (changes).
 * `commit`/`push` return their configured exit codes (default 0). (qmemd-ddr)
 */
function makeFakeRun(upstream = false, opts: { staged?: boolean; commitStatus?: number; pushStatus?: number; isRepo?: boolean } = {}) {
  const { staged = true, commitStatus = 0, pushStatus = 0, isRepo = true } = opts;
  const calls: string[][] = [];
  const run: GitRun = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return isRepo ? 0 : 128;
    if (args[0] === "rev-parse") return upstream ? 0 : 1;
    if (args[0] === "diff") return staged ? 1 : 0;
    if (args[0] === "commit") return commitStatus;
    if (args[0] === "push") return pushStatus;
    return 0;
  };
  return { calls, run };
}

const REPO_PROBE = ["rev-parse", "--is-inside-work-tree"];

describe("git helpers (unit, fake runner)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "qmemd-git-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("gitCommit probes for a repo then no-ops (no add/commit) when not a repo", () => {
    const { calls, run } = makeFakeRun(false, { isRepo: false });
    gitCommit(dir, "remember: x", "user/x.md", { run });
    expect(calls).toEqual([REPO_PROBE]);
  });

  test("gitCommit scopes add, probe, and commit to the fact pathspec (qmemd-g6q)", () => {
    // A bare `add -A` staged EVERYTHING in the memory repo — stray files (doctor --fix
    // .bak backups, hand-dropped notes) silently rode along in unrelated fact commits.
    // Every subcommand carries `-- <pathspec>` so only the fact itself is staged, probed,
    // and committed (the `--` commit pathspec also keeps out files staged out-of-band).
    mkdirSync(join(dir, ".git"));
    const { calls, run } = makeFakeRun(false);
    gitCommit(dir, "remember: x", "user/x.md", { run });
    expect(calls).toEqual([
      REPO_PROBE,
      ["add", "-A", "--", "user/x.md"],
      ["diff", "--cached", "--quiet", "--", "user/x.md"],
      ["commit", "-m", "remember: x", "--", "user/x.md"],
    ]);
  });

  // --- structured result: commit/push success vs failure vs benign no-op (qmemd-ddr) ---

  test("gitCommit returns committed:true on success", () => {
    mkdirSync(join(dir, ".git"));
    const { run } = makeFakeRun(false, { staged: true, commitStatus: 0 });
    expect(gitCommit(dir, "m", "user/x.md", { run })).toEqual({ ok: true, committed: true });
  });

  test("gitCommit reports failure (ok:false) when commit exits nonzero (unconfigured identity)", () => {
    mkdirSync(join(dir, ".git"));
    const { run } = makeFakeRun(false, { staged: true, commitStatus: 128 });
    const res = gitCommit(dir, "m", "user/x.md", { run });
    expect(res.ok).toBe(false);
    expect(res.committed).toBe(false);
  });

  test("gitCommit nothing-to-commit is a benign no-op — no commit attempt, ok:true", () => {
    mkdirSync(join(dir, ".git"));
    const { calls, run } = makeFakeRun(false, { staged: false });
    const res = gitCommit(dir, "m", "user/x.md", { run });
    expect(res).toEqual({ ok: true, committed: false, reason: "nothing-to-commit" });
    expect(calls.some(c => c[0] === "commit")).toBe(false);
  });

  test("gitCommit not-a-repo is benign (ok:true, committed:false)", () => {
    const { run } = makeFakeRun(false, { isRepo: false });
    expect(gitCommit(dir, "m", "user/x.md", { run })).toEqual({ ok: true, committed: false, reason: "not-a-repo" });
  });

  test("gitPush returns pushed:true on success", () => {
    mkdirSync(join(dir, ".git"));
    const { run } = makeFakeRun(true, { pushStatus: 0 });
    expect(gitPush(dir, { run })).toEqual({ ok: true, pushed: true });
  });

  test("gitPush reports failure (ok:false) when push exits nonzero", () => {
    mkdirSync(join(dir, ".git"));
    const { run } = makeFakeRun(true, { pushStatus: 1 });
    const res = gitPush(dir, { run });
    expect(res.ok).toBe(false);
    expect(res.pushed).toBe(false);
  });

  test("gitPush no-upstream is benign (ok:true, pushed:false)", () => {
    mkdirSync(join(dir, ".git"));
    const { run } = makeFakeRun(false);
    expect(gitPush(dir, { run })).toEqual({ ok: true, pushed: false, reason: "no-upstream" });
  });

  test("gitPush not-a-repo is benign (ok:true, pushed:false)", () => {
    const { run } = makeFakeRun(true, { isRepo: false });
    expect(gitPush(dir, { run })).toEqual({ ok: true, pushed: false, reason: "not-a-repo" });
  });

  const UPSTREAM_PROBE = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];

  test("gitPush probes for a repo then no-ops (no upstream probe / push) when not a repo", () => {
    const { calls, run } = makeFakeRun(true, { isRepo: false });
    gitPush(dir, { run });
    expect(calls).toEqual([REPO_PROBE]);
  });

  test("gitPush skips (probe only) when no upstream", () => {
    mkdirSync(join(dir, ".git"));
    const { calls, run } = makeFakeRun(false);
    gitPush(dir, { run });
    expect(calls).toEqual([REPO_PROBE, UPSTREAM_PROBE]);
  });

  test("gitPush pushes when upstream is set", () => {
    mkdirSync(join(dir, ".git"));
    const { calls, run } = makeFakeRun(true);
    gitPush(dir, { run });
    expect(calls).toEqual([REPO_PROBE, UPSTREAM_PROBE, ["push"]]);
  });

  test("gitPullFfOnly pulls --ff-only when upstream is set", () => {
    mkdirSync(join(dir, ".git"));
    const { calls, run } = makeFakeRun(true);
    gitPullFfOnly(dir, { run });
    expect(calls).toEqual([REPO_PROBE, UPSTREAM_PROBE, ["pull", "--ff-only"]]);
  });

  test("gitPullFfOnly skips when no upstream", () => {
    mkdirSync(join(dir, ".git"));
    const { calls, run } = makeFakeRun(false);
    gitPullFfOnly(dir, { run });
    expect(calls).toEqual([REPO_PROBE, UPSTREAM_PROBE]);
  });

  test("a fully-unavailable git (every probe null) surfaces git-unavailable, not not-a-repo (qmemd-3xf)", () => {
    // The new repo gate runs `rev-parse --is-inside-work-tree`. A null (git missing / timeout)
    // must NOT collapse to "not a repo" — that would re-hide the git-unavailable signal bwr
    // surfaces at the upstream probe. dir has no .git; only the rev-parse probe decides.
    const allNull: GitRun = () => null;
    expect(gitPush(dir, { run: allNull })).toEqual({ ok: false, pushed: false, reason: "git-unavailable" });
  });

  test("best-effort: a throwing runner never propagates", () => {
    mkdirSync(join(dir, ".git"));
    const throwing: GitRun = () => { throw new Error("boom"); };
    expect(() => gitCommit(dir, "m", "user/x.md", { run: throwing })).not.toThrow();
    expect(() => gitPush(dir, { run: throwing })).not.toThrow();
    expect(() => gitPullFfOnly(dir, { run: throwing })).not.toThrow();
  });

  test("stages, probes, and commits ALL given pathspecs (bri double-write)", () => {
    const calls: string[][] = [];
    const run: GitRun = (args) => { calls.push(args); return args[0] === "diff" ? 1 : 0; }; // diff: dirty
    const res = gitCommit("/repo", "remember: b (supersedes a)", ["project/b.md", "project/a.md"], { run });
    expect(res).toEqual({ ok: true, committed: true });
    expect(calls).toContainEqual(["add", "-A", "--", "project/b.md", "project/a.md"]);
    expect(calls).toContainEqual(["diff", "--cached", "--quiet", "--", "project/b.md", "project/a.md"]);
    expect(calls).toContainEqual(["commit", "-m", "remember: b (supersedes a)", "--", "project/b.md", "project/a.md"]);
  });

  test("still accepts a single-string pathspec", () => {
    const calls: string[][] = [];
    const run: GitRun = (args) => { calls.push(args); return args[0] === "diff" ? 1 : 0; };
    gitCommit("/repo", "remember: x", "project/x.md", { run });
    expect(calls).toContainEqual(["add", "-A", "--", "project/x.md"]);
  });
});

describe("git availability vs no-upstream distinction (qmemd-bwr)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "qmemd-bwr-")); mkdirSync(join(dir, ".git")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // The repo gate (`rev-parse --is-inside-work-tree`) answers 0 (a real repo); these fakes vary
  // only the UPSTREAM probe (`rev-parse @{u}`). Upstream probe returns null — git missing /
  // crashed / timed out (spawnSync.status is null) — vs a clean non-zero exit (real repo, no
  // upstream).
  const repoProbe = (args: string[]) => args[0] === "rev-parse" && args[1] === "--is-inside-work-tree";
  const gitUnavailable: GitRun = (args) => (repoProbe(args) ? 0 : args[0] === "rev-parse" ? null : 0);
  const noUpstream: GitRun = (args) => (repoProbe(args) ? 0 : args[0] === "rev-parse" ? 1 : 0);
  const upstreamOk: GitRun = () => 0;

  test("gitPush treats a null upstream probe as a real failure, not benign no-upstream", () => {
    // The bug: null collapsed to not-0 ⇒ reported {ok:true, reason:'no-upstream'} ⇒ a broken-git
    // machine silently stopped syncing while every write still reported success.
    expect(gitPush(dir, { run: gitUnavailable })).toEqual({ ok: false, pushed: false, reason: "git-unavailable" });
  });

  test("gitPush still treats a non-zero upstream probe as benign no-upstream (regression guard)", () => {
    expect(gitPush(dir, { run: noUpstream })).toEqual({ ok: true, pushed: false, reason: "no-upstream" });
  });

  test("gitPullFfOnly reports git-unavailable when the upstream probe returns null", () => {
    expect(gitPullFfOnly(dir, { run: gitUnavailable })).toEqual({ ok: false, pulled: false, reason: "git-unavailable" });
  });

  test("gitPullFfOnly is benign (no-upstream) on a non-zero probe", () => {
    expect(gitPullFfOnly(dir, { run: noUpstream })).toEqual({ ok: true, pulled: false, reason: "no-upstream" });
  });

  test("gitPullFfOnly pulls and reports pulled when upstream is present", () => {
    expect(gitPullFfOnly(dir, { run: upstreamOk })).toEqual({ ok: true, pulled: true });
  });

  test("sessionSyncWarning fires only on git-unavailable, silent on healthy/benign pulls", () => {
    expect(sessionSyncWarning({ ok: false, pulled: false, reason: "git-unavailable" })).toMatch(/git appears unavailable/);
    expect(sessionSyncWarning({ ok: true, pulled: true })).toBeNull();
    expect(sessionSyncWarning({ ok: true, pulled: false, reason: "no-upstream" })).toBeNull();
    expect(sessionSyncWarning({ ok: true, pulled: false, reason: "not-a-repo" })).toBeNull();
    // A pull-failed (nonzero exit, git ran fine) is a transient hiccup, not the persistent
    // "sync is off" condition the once-per-session diagnostic is for — stays silent.
    expect(sessionSyncWarning({ ok: false, pulled: false, reason: "pull-failed (status 1)" })).toBeNull();
  });
});

describe("nonInteractiveGitEnv (qmemd-b3z): a credential-needing git fails fast, never hangs", () => {
  test("sets GIT_TERMINAL_PROMPT=0 so a missing credential fails immediately instead of blocking on a prompt", () => {
    const env = nonInteractiveGitEnv({ PATH: "/usr/bin", HOME: "/home/u" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // the rest of the parent environment is inherited (git still needs PATH/HOME)
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
  });

  test("strips an inherited askpass helper so git cannot spawn a GUI credential dialog that outlives SIGTERM", () => {
    const env = nonInteractiveGitEnv({
      GIT_ASKPASS: "/usr/lib/git-core/git-gui--askpass",
      SSH_ASKPASS: "/usr/bin/ksshaskpass",
    });
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
  });
});

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

describe.runIf(gitAvailable)("git helpers (integration, real git)", () => {
  let base: string, work: string, bare: string, clone: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "qmemd-gitint-"));
    work = join(base, "work");
    bare = join(base, "remote.git");
    clone = join(base, "clone");
    mkdirSync(work);
    spawnSync("git", ["init", "-q", "-b", "main", work]);
    spawnSync("git", ["-C", work, "config", "user.email", "t@t"]);
    spawnSync("git", ["-C", work, "config", "user.name", "t"]);
    spawnSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
    spawnSync("git", ["-C", work, "remote", "add", "origin", bare]);
    writeFileSync(join(work, "seed.md"), "seed\n");
    spawnSync("git", ["-C", work, "add", "-A"]);
    spawnSync("git", ["-C", work, "commit", "-qm", "seed"]);
    spawnSync("git", ["-C", work, "push", "-qu", "origin", "main"]);
  });

  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("gitCommit + gitPush propagate to the remote", () => {
    writeFileSync(join(work, "fact.md"), "hello\n");
    gitCommit(work, "remember: fact", "fact.md");
    gitPush(work);
    const log = spawnSync("git", ["-C", bare, "log", "--oneline"], { encoding: "utf-8" }).stdout;
    expect(log).toContain("remember: fact");
  });

  test("syncs a memory dir nested in a repo with no local .git entry (qmemd-3xf)", () => {
    // The old existsSync(join(root,'.git')) heuristic returns false for a subdir of a repo,
    // so a memory dir nested in a larger repo silently skipped all sync. rev-parse
    // --is-inside-work-tree recognises it as a work tree and commits land in the parent repo.
    const nested = join(work, "memory");
    mkdirSync(nested);
    writeFileSync(join(nested, "fact.md"), "nested\n");
    const res = gitCommit(nested, "remember: nested", "fact.md");
    expect(res.committed).toBe(true);
    const log = spawnSync("git", ["-C", work, "log", "--oneline"], { encoding: "utf-8" }).stdout;
    expect(log).toContain("remember: nested");
  });

  test("gitPullFfOnly fetches a remote commit", () => {
    spawnSync("git", ["clone", "-q", bare, clone]);
    writeFileSync(join(work, "fromwork.md"), "x\n");
    gitCommit(work, "remember: fromwork", "fromwork.md");
    gitPush(work);
    gitPullFfOnly(clone);
    expect(existsSync(join(clone, "fromwork.md"))).toBe(true);
  });

  test("a stray file beside the fact is NOT swept into the commit (qmemd-g6q)", () => {
    // The bug: `add -A` staged the whole repo, so a doctor --fix backup (or any stray
    // file) silently landed in the next remember/forget commit. The pathspec-scoped
    // commit must leave the stray file untracked and out of the commit entirely.
    mkdirSync(join(work, "user"));
    writeFileSync(join(work, "user", "fact.md"), "the fact\n");
    writeFileSync(join(work, "user", "fact.md.bak"), "stray backup\n");
    const res = gitCommit(work, "remember: fact", "user/fact.md");
    expect(res.committed).toBe(true);
    const shown = spawnSync("git", ["-C", work, "show", "--stat", "--name-only", "--format=", "HEAD"], { encoding: "utf-8" }).stdout;
    expect(shown).toContain("user/fact.md");
    expect(shown).not.toContain("fact.md.bak");
    const status = spawnSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf-8" }).stdout;
    expect(status).toContain("?? user/fact.md.bak"); // still untracked, not committed
  });

  test("a deletion commits through the same pathspec form (forget path, qmemd-g6q)", () => {
    mkdirSync(join(work, "user"));
    writeFileSync(join(work, "user", "gone.md"), "to be forgotten\n");
    gitCommit(work, "remember: gone", "user/gone.md");
    rmSync(join(work, "user", "gone.md"));
    const res = gitCommit(work, "forget: gone", "user/gone.md");
    expect(res.committed).toBe(true);
    const log = spawnSync("git", ["-C", work, "log", "--oneline"], { encoding: "utf-8" }).stdout;
    expect(log).toContain("forget: gone");
    const ls = spawnSync("git", ["-C", work, "ls-files", "user/gone.md"], { encoding: "utf-8" }).stdout;
    expect(ls.trim()).toBe(""); // deletion really landed
  });
});
