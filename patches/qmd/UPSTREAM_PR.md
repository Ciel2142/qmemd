Title: Fix SDK rerank cache failures and expose source retrieval depth

SDK callers can receive cached synthetic relevance scores after a transient
reranker allocation failure, lose every warm inference cache entry on a no-op
update, and retrieve only 20 documents despite requesting a larger rerank pool.
These changes address those three behaviors.

Reranking now throws when no inference context is available and refuses
`model: "fallback"` results before cache writes. A new score-cache namespace
excludes historical fallback, double-sigmoid, and intent-insensitive entries.
This causes a one-time cache miss for existing score entries; query-expansion
caches remain reusable.

`SearchOptions.sourceLimit` controls retrieval depth separately from
`candidateLimit` and final `limit`. It defaults to 20 and preserves metadata
predicates on original, expanded, and structured lexical/vector searches.
The strong-signal probe still inspects a runner-up when `sourceLimit` is 1.
Short result arrays remain best-effort: backend limits and chunk deduplication
can underfill retrieval, as documented.

SDK updates retain caches keyed by their inference inputs. Changed chunk text
gets a new rerank key, while unchanged query/model/chunk combinations stay warm.

The 27 new regressions exercise real SQLite indexing, retrieval, fusion, and
cache behavior with model inference replaced. They include coverage for the
store-owned tokenizer fix already present on main. Relevant SDK, store, LLM,
and metadata suites and TypeScript checks pass; model-dependent cases are
skipped in the model-free run.

Patch base: `04e4dbd8245c527a88f1a8f0bda547aef9ca81fb`.
