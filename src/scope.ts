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
