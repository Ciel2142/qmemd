import { spawnSync } from "node:child_process";

/** Git exit status, or null when the process could not be spawned / timed out. */
export type GitRun = (args: string[], cwd: string) => number | null;

export interface GitDeps {
  /** Injectable git runner (tests). Defaults to a real `git` via spawnSync. */
  run?: GitRun;
}

/** Bound every git call so a write or session start never hangs on the network. */
const GIT_TIMEOUT_MS = 5000;

/**
 * Child-process environment that makes git fail fast instead of blocking on a credential
 * prompt (qmemd-b3z). An auth-misconfigured https remote otherwise triggers an interactive
 * prompt that hangs until GIT_TIMEOUT_MS on EVERY remember/forget/session-start — turning
 * the spec's "worst case ≤5s" into the common case — and a GUI askpass helper can spawn a
 * dialog that outlives the SIGTERM. GIT_TERMINAL_PROMPT=0 is the documented knob to fail
 * rather than prompt on the terminal; deleting GIT_ASKPASS/SSH_ASKPASS drops any inherited
 * popup helper so git can't escalate to a GUI dialog. Cross-platform (no hardcoded
 * /bin/true — qmemd ships a native Windows install). The upstream must therefore use an SSH
 * key or a helper-cached token; an interactive credential is treated as "no credential".
 */
export function nonInteractiveGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return env;
}

const defaultRun: GitRun = (args, cwd) =>
  spawnSync("git", ["-C", cwd, ...args], {
    stdio: "ignore",
    timeout: GIT_TIMEOUT_MS,
    env: nonInteractiveGitEnv(),
  }).status;

/**
 * Is `root` inside a git work tree? Uses `rev-parse --is-inside-work-tree` rather than an
 * existsSync('.git') heuristic so a worktree (.git is a file), a GIT_DIR-relocated repo, or a
 * memory dir nested in a larger repo (no local .git entry) are all recognized and still sync —
 * the old heuristic silently skipped every one of them (qmemd-3xf). Status semantics:
 *   0        → inside a work tree → proceed.
 *   non-zero → genuinely not a work tree → benign skip.
 *   null     → git unavailable / timed out: do NOT collapse to "not a repo" — that would
 *              re-hide the git-unavailable signal the upstream probe surfaces (qmemd-bwr).
 *              Treat as "assume repo" so the downstream commit/push/pull reports the failure.
 */
function isRepo(root: string, run: GitRun): boolean {
  const status = run(["rev-parse", "--is-inside-work-tree"], root);
  return status === 0 || status === null;
}

/**
 * Tri-state result of the tracking-upstream probe (qmemd-bwr). The old boolean
 * `run(...) === 0` collapsed two very different outcomes into "no upstream":
 *   - a genuine non-zero exit  → there really is no tracking branch (benign),
 *   - a null                   → git could not run at all (binary missing, crashed,
 *                                or timed out at GIT_TIMEOUT_MS).
 * Conflating them let a broken-git machine silently stop syncing while every write still
 * reported success. Keeping `unavailable` distinct lets the push/pull gates treat it as a
 * real failure (surfaced via {synced:false} + a warning) instead of a benign no-op.
 */
type UpstreamState = "present" | "absent" | "unavailable";

function upstreamState(root: string, run: GitRun): UpstreamState {
  const status = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
  if (status === 0) return "present";
  if (status === null) return "unavailable"; // spawn failure / timeout — NOT "no upstream"
  return "absent";                            // genuine non-zero exit: no tracking upstream
}

/**
 * Outcome of a best-effort commit (qmemd-ddr). `ok` is false ONLY when a commit that
 * should have happened actually failed (e.g. exit 128 from an unconfigured git identity)
 * — callers warn on that. The benign cases (no repo, nothing staged) are `ok:true`.
 */
export interface GitCommitResult {
  ok: boolean;
  committed: boolean;
  reason?: string;
}

/**
 * Outcome of a best-effort push (qmemd-ddr). `ok` is false ONLY when a push to a real
 * upstream failed; "no upstream"/"not a repo" are expected no-ops (`ok:true`).
 */
export interface GitPushResult {
  ok: boolean;
  pushed: boolean;
  reason?: string;
}

/**
 * Stage + commit one fact's file(s), scoped to its pathspec(s). Best-effort: never throws.
 * Returns a structured result so callers can tell a real failure (commit exited nonzero)
 * from the expected no-ops (qmemd-ddr).
 *
 * Every subcommand carries `-- <pathspec>` (qmemd-g6q): a bare `add -A` staged the whole
 * memory repo, so any stray file (a doctor --fix `.bak` backup, a hand-dropped note) was
 * silently swept into an unrelated `remember:`/`forget:` commit. `add -A -- <path>` stages
 * creations AND deletions of just that path (the forget case); the scoped `diff --cached`
 * probe keeps "nothing to commit" accurate even when out-of-band changes sit staged; the
 * commit pathspec makes the commit partial, so those out-of-band staged changes stay out
 * of the fact's commit (and stay staged for whoever staged them). `pathspec` is always
 * `<type>/<slug>.md` built from the closed type enum + an assertSafeSlug-validated slug,
 * so it can never start with a `:` pathspec-magic prefix.
 * Accepts multiple pathspecs for the supersede double-write (qmemd-bri) — both fact files
 * land in ONE commit.
 */
export function gitCommit(root: string, message: string, pathspec: string | string[], deps: GitDeps = {}): GitCommitResult {
  const run = deps.run ?? defaultRun;
  const paths = Array.isArray(pathspec) ? pathspec : [pathspec];
  try {
    if (!isRepo(root, run)) return { ok: true, committed: false, reason: "not-a-repo" };
    run(["add", "-A", "--", ...paths], root);
    // Separate a real commit failure (e.g. exit 128, unconfigured identity) from the
    // benign "nothing to commit" no-op (e.g. --replace with byte-identical content): a
    // clean staged path (`diff --cached --quiet -- <path>` == 0) means there is nothing
    // to commit, so don't run — and don't misreport — a commit. Only an exit-only probe
    // is needed, which fits the GitRun seam (no stdout capture).
    if (run(["diff", "--cached", "--quiet", "--", ...paths], root) === 0) {
      return { ok: true, committed: false, reason: "nothing-to-commit" };
    }
    const status = run(["commit", "-m", message, "--", ...paths], root);
    if (status === 0) return { ok: true, committed: true };
    return { ok: false, committed: false, reason: `commit-failed (status ${status})` };
  } catch {
    // best-effort: never fail a write because git is unavailable
    return { ok: false, committed: false, reason: "exception" };
  }
}

/** Push the current branch to its upstream. Best-effort + gated on repo & upstream. */
export function gitPush(root: string, deps: GitDeps = {}): GitPushResult {
  const run = deps.run ?? defaultRun;
  try {
    if (!isRepo(root, run)) return { ok: true, pushed: false, reason: "not-a-repo" };
    const up = upstreamState(root, run);
    // git-unavailable (probe returned null) is a REAL failure, not benign: reporting it as
    // no-upstream let a broken-git machine silently stop syncing (qmemd-bwr). Surface ok:false
    // so syncOutcome emits {synced:false} + a warning. A genuine non-zero probe is still benign.
    if (up === "unavailable") return { ok: false, pushed: false, reason: "git-unavailable" };
    if (up === "absent") return { ok: true, pushed: false, reason: "no-upstream" };
    const status = run(["push"], root);
    if (status === 0) return { ok: true, pushed: true };
    return { ok: false, pushed: false, reason: `push-failed (status ${status})` };
  } catch {
    // best-effort
    return { ok: false, pushed: false, reason: "exception" };
  }
}

/**
 * Outcome of a best-effort fast-forward pull (qmemd-bwr). Mirrors GitPushResult: `ok` is
 * false only when a pull that should have worked failed (git-unavailable, or `pull --ff-only`
 * exited nonzero). The benign no-ops (no repo, no upstream) are `ok:true`.
 */
export interface GitPullResult {
  ok: boolean;
  pulled: boolean;
  reason?: string;
}

/** Fast-forward-only pull from upstream. Best-effort + gated on repo & upstream. Returns a
 *  structured result (qmemd-bwr) so the session-start path can warn that sync is off when git
 *  is unavailable, instead of silently serving a stale snapshot. */
export function gitPullFfOnly(root: string, deps: GitDeps = {}): GitPullResult {
  const run = deps.run ?? defaultRun;
  try {
    if (!isRepo(root, run)) return { ok: true, pulled: false, reason: "not-a-repo" };
    const up = upstreamState(root, run);
    if (up === "unavailable") return { ok: false, pulled: false, reason: "git-unavailable" };
    if (up === "absent") return { ok: true, pulled: false, reason: "no-upstream" };
    const status = run(["pull", "--ff-only"], root);
    if (status === 0) return { ok: true, pulled: true };
    return { ok: false, pulled: false, reason: `pull-failed (status ${status})` };
  } catch {
    // best-effort
    return { ok: false, pulled: false, reason: "exception" };
  }
}

/**
 * The once-per-session diagnostic for a session-start pull that found git unavailable
 * (qmemd-bwr): a real repo whose upstream probe could not run (binary missing / crashed /
 * timed out), so memory sync is silently off. Returns the human message, or null when the
 * pull was fine or benignly skipped (no repo / no upstream). recall --session runs once per
 * session, so emitting on its result is naturally once-per-session — no extra throttle state.
 */
export function sessionSyncWarning(pull: GitPullResult): string | null {
  return !pull.ok && pull.reason === "git-unavailable"
    ? "git appears unavailable; memory sync is disabled this session."
    : null;
}
