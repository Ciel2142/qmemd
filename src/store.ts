import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createStore, type QMDStore } from "@tobilu/qmd";
import { memoryRoot, indexDbPath } from "./paths.js";

export const MEMORY_COLLECTION = "memory";

/**
 * qmemd's own embedding model — independent of qmd's QMD_EMBED_MODEL.
 * Defaults to embeddinggemma-300M (~0.5 GB resident), ~25x lighter than qmd's
 * Qwen3-Embedding-8B (~13 GB measured). Ample for a small curated fact corpus,
 * and because qmemd's index is isolated its vectors never mix with qmd's.
 * Override with QMEMD_EMBED_MODEL.
 */
export function memoryEmbedModel(): string {
  return process.env.QMEMD_EMBED_MODEL
    || "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
}

// --- embed-model identity pinning (qmemd-rkl) -------------------------------
// The CLI and the install-service daemon share ONE index (QMEMD_DB). If they embed with
// different models (e.g. the daemon falls back to the default while the CLI uses a
// QMEMD_EMBED_MODEL override), the index ends up with vectors from two embedding spaces —
// different geometry, possibly different dimensions — which silently degrades or breaks
// hybrid recall. Pin the model id to the index and warn loudly on a mismatch at open.
// The marker lives next to the index file and is treated as authoritative only for a
// FRESH index (see openMemoryStore), so a `rm <index>` rebuild cleanly re-pins.

/** Path of the sidecar recording which embed model this index's vectors were built with. */
export function embedModelMarkerPath(dbPath: string): string {
  return dbPath + ".embed-model";
}

/** The embed model id recorded for this index, or null if none is recorded yet. */
export function readEmbedModelMarker(dbPath: string): string | null {
  const marker = embedModelMarkerPath(dbPath);
  if (!existsSync(marker)) return null;
  try {
    return readFileSync(marker, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** Record the embed model id for this index (best-effort; never throws). */
export function writeEmbedModelMarker(dbPath: string, model: string): void {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(embedModelMarkerPath(dbPath), model + "\n");
  } catch {
    // best-effort: the marker is a guard, not a correctness dependency
  }
}

/**
 * Compare the index's recorded embed model to `model`. On a mismatch, warn (the index
 * holds vectors from a different model — mixed-space hazard) and PRESERVE the recorded
 * id so the warning persists until the index is rebuilt. On first use (no marker), pin
 * `model`. Fail-open: a match or any fs error is a silent no-op.
 */
export function checkEmbedModelIdentity(
  dbPath: string,
  model: string,
  warn: (msg: string) => void = (m) => console.error(m),
): { mismatch: boolean; recorded: string | null } {
  const recorded = readEmbedModelMarker(dbPath);
  if (recorded && recorded !== model) {
    warn(`[qmemd] WARNING: embedding-model mismatch on the shared index '${dbPath}'. Its vectors were built with '${recorded}', but this process uses '${model}'. Mixed-model vectors degrade or break hybrid recall. Align QMEMD_EMBED_MODEL across the CLI and the install-service daemon, then delete the index (QMEMD_DB) to rebuild it under one model.`);
    return { mismatch: true, recorded };
  }
  if (!recorded) writeEmbedModelMarker(dbPath, model);
  return { mismatch: false, recorded };
}

/**
 * Open the dedicated qmemd store: a qmd index whose only collection is the
 * memory data dir, embedded with qmemd's own (small) model. createStore gives
 * the LlamaCpp a 5-min inactivity TTL with dispose-on-idle, so the model
 * auto-unloads when unused.
 */
export async function openMemoryStore(): Promise<QMDStore> {
  const dbPath = indexDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  // Pin the embed-model identity to the index (qmemd-rkl). A fresh index (no DB file yet)
  // is re-pinned authoritatively — covering both first use and a `rm <index>` rebuild,
  // which would otherwise leave a stale marker; an existing index is checked (warn on
  // mismatch, adopt when unmarked).
  const indexPreexisted = existsSync(dbPath);
  const model = memoryEmbedModel();
  const store = await createStore({
    dbPath,
    config: {
      models: { embed: model },
      collections: { [MEMORY_COLLECTION]: { path: memoryRoot(), pattern: "**/*.md" } },
    },
  });
  if (indexPreexisted) checkEmbedModelIdentity(dbPath, model);
  else writeEmbedModelMarker(dbPath, model);
  return store;
}
