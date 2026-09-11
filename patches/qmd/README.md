# qmd upstream fixes

qmemd remains pinned to released `@tobilu/qmd@2.8.3`. These patches are review
artifacts and are **not applied during install or build**. The user chose
upstream fixes followed by a released dependency upgrade.

`qmd-main-retrieval.patch` targets upstream commit
`04e4dbd8245c527a88f1a8f0bda547aef9ca81fb`. It fixes three outstanding defects:

| Defect | Change | qmemd adoption issue |
| --- | --- | --- |
| Resource failure cached as relevance | Throw on unavailable reranking; reject fallback responses before caching; version score keys to exclude historical scores | `qp-bud1` |
| Source depth fixed at 20 | Add validated `sourceLimit` to SDK hybrid/structured searches, preserving metadata filters and the strong-signal probe | `qp-94v2` |
| Every SDK update clears inference caches | Preserve query/model and query/model/chunk cache entries; changed chunks get new scores | `qp-1qs2` |

Current upstream already fixes store-owned tokenization through
`chunkDocumentByTokensWithLlm`; its regression is retained in the patch.
Released 2.8.3 still needs that fix (`qp-fep1`).

`qmd-2.8.3-retrieval.patch` is the reproduction/backport against release commit
`facd35e01359e59d938bc9418e93fb9318addee3`. It includes all four fixes and is
kept to reproduce the measurements below. Apply **one** patch to its matching
base; do not apply both patches to one checkout.

## Apply and verify

In a separate qmd checkout at the matching commit:

```sh
git apply --check /path/to/qmemd/patches/qmd/qmd-main-retrieval.patch
git apply /path/to/qmemd/patches/qmd/qmd-main-retrieval.patch
bun install --frozen-lockfile
npm run test:types
CI=true npx vitest run test/sdk-regressions.test.ts test/sdk.test.ts test/store.test.ts test/llm.test.ts
CI=true npx vitest run test/metadata-search.test.ts test/metadata-store.test.ts test/metadata-filter.test.ts test/metadata.test.ts
```

The new tests use real SQLite indexing, vector retrieval, fusion, and caching;
only tokenization and model inference are replaced. They exercise recovery from
resource failures, reuse after no-op and changed-content updates, all source
routes, and preservation of metadata filters. Model-dependent upstream cases
are skipped under `CI=true`.

Validation on the main patch: 460 tests passed and 50 model-dependent tests
skipped across SDK/store/LLM/metadata suites; another 15 metadata HTTP/CLI tests
passed. TypeScript and the upstream pinned lint rules passed. Applying the
exported patch to a fresh base and rerunning its 27 regressions also passed.
The 2.8.3 backport passed 387 tests with 50 skips, plus 167 CLI tests and
TypeScript checks. Local checks used Node 25.9.0; upstream CI remains responsible
for its full supported-runtime matrix.

## Measurements

`measurements.json` records separate fresh processes for released 2.8.3 and the
2.8.3 backport on macOS arm64, Node 25.9.0, node-llama-cpp 3.20.0. Each used
34 synthetic facts, 18 queries, cached GGUF files, and a fresh index. The model
IDs match the benchmark baseline in `test/golden/recall-baseline.json`.

| Observation | Released 2.8.3 | 2.8.3 backport |
| --- | ---: | ---: |
| Cold embedding | 2,270 ms | 1,340 ms |
| RSS immediately after embedding | 2,476 MiB | 2,039 MiB |
| Cache rows before → after no-op update | 403 → 0 | 389 → 389 |
| Recall after no-op update, median | 454.4 ms | 15.5 ms |
| Recall after no-op update, p95 | 4,614.0 ms | 49.2 ms |

These are single-fixture observations, not production guarantees. RSS is a
snapshot, not peak memory. Expansion is nondeterministic, so generated cache
counts and first-pass timings differ. Both variants reported zero degraded
queries. The tokenizer improvement is already present on current upstream main.

To repeat from qmemd after installing dependencies in both checkouts:

```sh
QMEMD_EMBED_TIMEOUT_MS=120000 node --import tsx patches/qmd/measure.mts
QMEMD_EMBED_TIMEOUT_MS=120000 node --import tsx patches/qmd/measure.mts /path/to/patched-qmd/src/index.ts
```

This experiment loads models and is separate from the model-free test suite.

## Release integration

The adoption issues stay open until a qmd release includes the fixes. Increasing
`sourceLimit` alone does not prove scoped recall is exhaustive: vector chunk
deduplication, backend limits, and metadata overfetch can still underfill a
source. qmemd will need to use the released metadata/source-depth APIs and
handle completeness conservatively. Real-corpus floor calibration and a change
to the default search policy also remain separate, evidence-dependent work.
