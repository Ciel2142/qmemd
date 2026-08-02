/**
 * Hermetic environment for spawned-CLI tests (a1r).
 *
 * The spawn helpers used to pass `{ ...process.env, QMD_MEMORY_DIR: root, ... }`, so
 * every qmemd knob exported by the developer's shell reconfigured the child under test.
 * The worst case is not hypothetical: a host exporting QMEMD_RECALL_MODE=hybrid makes
 * the child take the delegation gate (src/cli/qmemd.ts:378) and answer from the LIVE
 * daemon on 127.0.0.1 — the real corpus — instead of the test's fixture root, so the
 * suite passes or fails on the maintainer's machine state.
 *
 * Strip the whole `QMEMD_` + `QMD_` family and let each test opt back in explicitly.
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("QMEMD_") || key.startsWith("QMD_")) continue;
    base[key] = value;
  }
  return { ...base, ...extra };
}
