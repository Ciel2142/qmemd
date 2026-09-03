import { basename } from "node:path";
import { type MemoryType } from "./engine.js";

/** Default write scope for a fact of `type` written from `cwd` (qmemd-due wave: scope
 *  default). user/feedback are per-machine, not per-repo, so they always default to
 *  global; project/reference default to the repo they're written from. */
export function defaultProjectFor(type: MemoryType, cwd: string): string {
  if (type === "user" || type === "feedback") return "global";
  return basename(cwd) || "global";
}

export function isBlankProject(project: string | undefined): boolean {
  return project === undefined || project.trim() === "";
}

/** The write scope every surface passes to `remember()` (qmemd-due). A blank (absent or
 *  whitespace-only) project defaults per type+cwd — except on `replace`, which is an in-place
 *  update: undefined there lets the engine keep the fact's stored scope rather than silently
 *  re-homing it to the caller's repo (decision D1). */
export function resolveWriteScope(input: { project?: string; type?: MemoryType; replace?: boolean; cwd: string }): string | undefined {
  const explicit = isBlankProject(input.project) ? undefined : input.project;
  if (input.replace) return explicit;
  return explicit ?? defaultProjectFor(input.type ?? "reference", input.cwd);
}
