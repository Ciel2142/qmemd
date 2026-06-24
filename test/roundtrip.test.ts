import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as openQmd, type QMDStore } from "@tobilu/qmd";
import { remember, forget, recallQueryWithStatus, memoryFilePath } from "../src/engine.js";

// qmemd-4lr: markdown-is-source-of-truth invariant. After forget(), a full reindex
// (store.update — what `qmemd reindex` runs) must land on the SAME index + filesystem
// state: the forgotten fact never resurrects from a stale index row, the kept fact
// never drops. And an out-of-band file deletion + reindex converges to the same state
// a forget() would have left. Lex-only — no model load.

describe("forget() + reindex round-trip (4lr)", () => {
  let parent: string, root: string, store: QMDStore;

  const lexSlugs = async (query: string): Promise<string[]> => {
    const res = await recallQueryWithStatus(store, root, query, { lexOnly: true });
    return res.hits.map(h => h.slug);
  };
  const reindex = () => store.update({ collections: ["memory"] });

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "qmemd-rt-"));
    root = join(parent, "mem");
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, "idx"), { recursive: true });
    store = await openQmd({ dbPath: join(parent, "idx", "i.sqlite"), config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
    await remember(store, root, { fact: "Redpanda broker runs on the lab pi", type: "project" });
    await remember(store, root, { fact: "Grafana dashboards live on the k3s sandbox cluster", type: "reference" });
  });
  afterEach(async () => {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  });

  test("forget drops the fact from disk AND index; a later reindex changes nothing", async () => {
    expect(await lexSlugs("redpanda broker")).toContain("redpanda-broker-runs-on-the-lab-pi");
    expect(await lexSlugs("grafana dashboards")).toContain("grafana-dashboards-live-on-the-k3s-sandbox-cluster");

    const res = await forget(store, root, "redpanda-broker-runs-on-the-lab-pi");
    expect(res.removed).toBe(true);
    expect(existsSync(memoryFilePath(root, "project", "redpanda-broker-runs-on-the-lab-pi"))).toBe(false);

    const afterForget = {
      redpanda: await lexSlugs("redpanda broker"),
      grafana: await lexSlugs("grafana dashboards"),
    };
    expect(afterForget.redpanda).not.toContain("redpanda-broker-runs-on-the-lab-pi");
    expect(afterForget.grafana).toContain("grafana-dashboards-live-on-the-k3s-sandbox-cluster");

    // Reindex from the markdown corpus — the index must converge to the same state:
    // no resurrection of the forgotten fact, no loss of the kept one.
    await reindex();
    expect(await lexSlugs("redpanda broker")).toEqual(afterForget.redpanda);
    expect(await lexSlugs("grafana dashboards")).toEqual(afterForget.grafana);
    expect(existsSync(memoryFilePath(root, "reference", "grafana-dashboards-live-on-the-k3s-sandbox-cluster"))).toBe(true);
  });

  test("an out-of-band file deletion + reindex converges to the forget() end state", async () => {
    // Simulate a git pull / manual edit removing a fact behind the index's back.
    rmSync(memoryFilePath(root, "reference", "grafana-dashboards-live-on-the-k3s-sandbox-cluster"));
    await reindex();
    expect(await lexSlugs("grafana dashboards")).not.toContain("grafana-dashboards-live-on-the-k3s-sandbox-cluster");
    expect(await lexSlugs("redpanda broker")).toContain("redpanda-broker-runs-on-the-lab-pi");
  });
});
