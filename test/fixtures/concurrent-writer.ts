import type { QMDStore } from "@tobilu/qmd";
import { remember } from "../../src/engine.js";

const [root, role] = process.argv.slice(2);
const store = {
  async update() {},
  async searchLex() {
    if (role === "first") {
      process.send!({ kind: "entered" });
      await new Promise<void>(resolve => process.once("message", () => resolve()));
    }
    return [];
  },
} as unknown as QMDStore;

process.send!({ kind: "ready" });
try {
  const result = await remember(store, root!, {
    as: "shared", fact: role === "first" ? "Alpha stores backups in the attic." : "Beta receives webhooks on port 4321.",
    type: role === "first" ? "project" : "reference", project: role!,
  });
  process.send!({ kind: "result", result });
} catch (e) {
  process.send!({ kind: "error", message: String(e) });
  process.exitCode = 1;
} finally { process.disconnect(); }
