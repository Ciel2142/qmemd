import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { QMDStore } from "@tobilu/qmd";
import { getFact, listFacts, remember, type MemoryType, type RememberResult } from "../src/engine.js";
import { fixMemory } from "../src/doctor.js";

describe("concurrent fact creation (qp-rge)", () => {
  let root: string;
  const children: ChildProcess[] = [];
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-concurrent-")); });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  function worker(role: "first" | "second") {
    const child = fork(new URL("./fixtures/concurrent-writer.ts", import.meta.url), [root, role], {
      execArgv: ["--import", "tsx"], silent: true,
    });
    children.push(child);
    function message(kind: string): Promise<{ result: RememberResult }> {
      const pending = new Promise<{ result: RememberResult }>((resolve, reject) => {
        const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onExit = (code: number | null, signal: string | null) => onError(new Error(`writer exited before ${kind}: ${code ?? signal}`));
        const onMessage = (value: any) => {
          if (value.kind === kind) { cleanup(); resolve(value); }
          else if (value.kind === "error") onError(new Error(value.message));
        };
        child.on("message", onMessage).on("exit", onExit).on("error", onError);
      });
      pending.catch(() => {}); // a killed worker intentionally never sends its result
      return pending;
    }
    return { child, ready: message("ready"), entered: role === "first" ? message("entered") : null, result: message("result") };
  }

  test.each<MemoryType>(["project", "reference"])("serializes slug collisions across writers and %s folders", async secondType => {
    let entered!: () => void, release!: () => void;
    const firstEntered = new Promise<void>(r => { entered = r; });
    const firstMayFinish = new Promise<void>(r => { release = r; });
    let calls = 0;
    const store = {
      async update() {},
      async searchLex() {
        if (++calls === 1) { entered(); await firstMayFinish; }
        return [];
      },
    } as unknown as QMDStore;
    const first = remember(store, root, { as: "shared", fact: "Alpha stores backups in the attic.", type: "project", project: "alpha" });
    await firstEntered;
    const second = remember(store, root, { as: "shared", fact: "Beta listens for webhooks on port 4321.", type: secondType, project: "beta" });
    await delay(30);
    release();
    const results = await Promise.all([first, second]);
    expect(results.map(r => r.wrote)).toEqual([true, false]);
    expect(getFact(root, "shared")!.body.trim()).toBe("Alpha stores backups in the attic.");
    expect(listFacts(root).filter(f => f.slug === "shared")).toHaveLength(1);
  });

  test("separate processes share one slug namespace across type folders", async () => {
    const first = worker("first");
    await first.entered;
    const second = worker("second");
    await second.ready;
    await delay(50);
    first.child.send("continue");
    const results = await Promise.all([first.result, second.result]);
    expect(results.map(r => r.result.wrote)).toEqual([true, false]);
    expect(getFact(root, "shared")!.body.trim()).toBe("Alpha stores backups in the attic.");
    expect(listFacts(root).filter(f => f.slug === "shared")).toHaveLength(1);
  });

  test("a killed writer releases its lock without stale-file recovery", async () => {
    const first = worker("first");
    await first.entered;
    const exited = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await exited;
    const second = worker("second");
    expect((await second.result).result.wrote).toBe(true);
    expect(getFact(root, "shared")!.body).toContain("Beta receives webhooks");
  });

  test("synchronous doctor repair refuses to race an active writer", async () => {
    const first = worker("first");
    await first.entered;
    expect(() => fixMemory(root)).toThrow("memory store is busy");
    first.child.send("continue");
    expect((await first.result).result.wrote).toBe(true);
  });
});
