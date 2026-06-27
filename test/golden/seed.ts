// Loads + validates the committed golden set and seeds it into a fresh tmp store. Shared
// by the model-free vitest guard and the model-loading bench script — the ONLY difference
// is whether an embed model is configured (the `embedModel` option). Throws plain Errors
// (framework-agnostic) on a corpus/query integrity failure, so authoring typos surface at
// seed time rather than as a confusing recall miss (qmemd-3u8).

import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "@tobilu/qmd";
import { remember, type MemoryType } from "../../src/engine.js";

export interface GoldenQuery {
  query: string;
  relevant: string[];
  top?: string; // single best slug (P@1 / tripwire target); defaults to relevant[0]
}

export interface GoldenSet {
  corpus: { type: MemoryType; fact: string; slug: string }[];
  queries: GoldenQuery[];
  min_score: number;
}

export interface SeededStore {
  store: QMDStore;
  root: string;
  golden: GoldenSet;
  cleanup: () => Promise<void>;
}

/** The single best slug for a query: explicit `top`, else `relevant[0]`. */
export function topSlug(q: GoldenQuery): string {
  return q.top ?? q.relevant[0];
}

/** Throw on a structural or referential error: duplicate corpus slug, a query with no
 *  relevant slugs, or a query referencing a slug absent from the corpus. Returns the set
 *  unchanged on success. */
export function validateGoldenSet(golden: GoldenSet): GoldenSet {
  const slugs = new Set<string>();
  for (const c of golden.corpus) {
    if (slugs.has(c.slug)) throw new Error(`golden set: duplicate corpus slug '${c.slug}'`);
    slugs.add(c.slug);
  }
  for (const q of golden.queries) {
    if (!q.relevant?.length) throw new Error(`golden set: query '${q.query}' has no relevant slugs`);
    for (const s of [...q.relevant, ...(q.top ? [q.top] : [])]) {
      if (!slugs.has(s)) throw new Error(`golden set: query '${q.query}' references unknown slug '${s}'`);
    }
  }
  return golden;
}

/** Read + validate the committed golden set from disk. */
export async function loadGoldenSet(path: string): Promise<GoldenSet> {
  return validateGoldenSet(JSON.parse(await readFile(path, "utf-8")) as GoldenSet);
}

export interface TmpMemoryStore {
  store: QMDStore;
  root: string;
  cleanup: () => Promise<void>;
}

/** A fresh empty tmp store (no corpus seeded). Lex-only unless `embedModel` is set. The tmp
 *  dir is not a git repo, so remember()'s git sync is a no-op. Shared by the behavioral eval
 *  partitions (retirement/staleness) and by seedGoldenStore. */
export async function createTmpMemoryStore(
  opts: { embedModel?: string } = {},
): Promise<TmpMemoryStore> {
  const parent = await mkdtemp(join(tmpdir(), "qmemd-golden-"));
  const root = join(parent, "mem");
  await mkdir(root, { recursive: true });
  await mkdir(join(parent, "idx"), { recursive: true });
  const store = await createStore({
    dbPath: join(parent, "idx", "i.sqlite"),
    config: {
      ...(opts.embedModel ? { models: { embed: opts.embedModel } } : {}),
      collections: { memory: { path: root, pattern: "**/*.md" } },
    },
  });
  return {
    store,
    root,
    cleanup: async () => {
      await store.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** Seed the golden corpus into a fresh tmp store. With `embedModel` set the store is
 *  hybrid-capable (the bench); without it the store is lex-only and loads no model (the
 *  vitest guard). The tmp dir is not a git repo, so remember()'s git sync is a no-op.
 *  Throws if any fact deduped or wrote under an unexpected slug. */
export async function seedGoldenStore(
  goldenSetPath: string,
  opts: { embedModel?: string } = {},
): Promise<SeededStore> {
  const golden = await loadGoldenSet(goldenSetPath);
  const tmp = await createTmpMemoryStore(opts);
  for (const entry of golden.corpus) {
    const res = await remember(tmp.store, tmp.root, { fact: entry.fact, type: entry.type });
    if (!res.wrote) throw new Error(`corpus fact '${entry.slug}' deduped against '${res.duplicateOf}'`);
    if (res.slug !== entry.slug) throw new Error(`corpus fact wrote slug '${res.slug}', expected '${entry.slug}'`);
  }
  return { store: tmp.store, root: tmp.root, golden, cleanup: tmp.cleanup };
}
