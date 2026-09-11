// Isolated model-loading experiment: fresh corpus, first/warm/after-no-op passes.
// Never run as part of the model-free unit suite. RSS snapshots are not peak memory.
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { remember, recallQueryWithStatus } from '../../src/engine.js';
import { memoryEmbedModel } from '../../src/store.js';

// Run with node --import tsx; optionally point at a candidate qmd src/index.ts.
const candidate = process.argv[2];
const entry = candidate ? pathToFileURL(resolve(candidate)).href : import.meta.resolve('@tobilu/qmd');
const variant = candidate ? 'candidate' : 'released';
const { createStore } = await import(entry);
const { disposeDefaultLlamaCpp } = await import(new URL(entry.endsWith('.ts') ? './llm.ts' : './llm.js', entry).href);
const golden = JSON.parse(await readFile(new URL('../../test/golden/golden-set.json', import.meta.url), 'utf8'));
const parent = await mkdtemp(join(tmpdir(), 'qmemd-upstream-measure-'));
const root = join(parent, 'mem');
await mkdir(root);
const store = await createStore({ dbPath: join(parent, 'index.sqlite'), config: { models: {embed: memoryEmbedModel()}, collections: {memory: {path: root, pattern: '**/*.md'}}}});
const qs = [...golden.queries, ...golden.paraphrase_queries];
const count = () => store.internal.db.prepare('SELECT count(*) n FROM llm_cache').get().n;
const stats = (xs: number[]) => { const sorted = [...xs].sort((a,b)=>a-b); return { n: xs.length, p50: sorted[Math.ceil(xs.length*.5)-1], p95: sorted[Math.ceil(xs.length*.95)-1] }; };
async function recallPass(phase: string) {
  const ms: number[] = []; let degraded = 0;
  for (const q of qs) { const t = performance.now(); const r = await recallQueryWithStatus(store, root, q.query, {limit:5}); ms.push(performance.now()-t); degraded += Number(r.degraded); }
  console.log(JSON.stringify({ variant, phase, latencyMs: stats(ms), degraded, cacheRows: count(), rssMb: process.memoryUsage().rss / 1048576 }));
}
try {
  for (const c of golden.corpus) await remember(store, root, {...c, project:'global'});
  const start = performance.now(); await store.embed({collection:'memory'});
  console.log(JSON.stringify({variant, phase:'embed', ms: performance.now()-start, rssMb: process.memoryUsage().rss/1048576}));
  await recallPass('first');
  await recallPass('warm');
  const before = count(); const updated = await store.update({collections:['memory']});
  console.log(JSON.stringify({variant, phase:'noop-update', before, after:count(), updated}));
  await recallPass('after-noop-update');
} finally {
  await store.close(); await disposeDefaultLlamaCpp(); await rm(parent, {recursive:true, force:true});
}
