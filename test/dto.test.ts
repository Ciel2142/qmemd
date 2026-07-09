import { describe, test, expect } from "vitest";
import { toHitDTO, toFactDTO, toListEntryDTO } from "../src/mcp/server.js";

describe("DTO mappers never leak an absolute path (qmemd-81n)", () => {
  test("toHitDTO drops path, keeps the allowlisted fields incl. project (qmemd-due)", () => {
    const dto = toHitDTO({
      slug: "s", path: "/home/u/.local/share/qmd-memory/project/s.md",
      type: "project", description: "d", score: 0.5, body: "b", platforms: ["linux"], project: "alpha",
    });
    expect("path" in dto).toBe(false);
    expect(dto).toEqual({ slug: "s", type: "project", description: "d", score: 0.5, body: "b", platforms: ["linux"], project: "alpha" });
  });

  test("toFactDTO drops path, exposes frontmatter fields + trimmed body", () => {
    const dto = toFactDTO({
      slug: "s", type: "user", path: "/abs/secret/path/s.md",
      body: "  body text  ",
      frontmatter: {
        name: "s", description: "d", type: "user", tags: ["t"],
        project: "global", platforms: ["macos"], created: "2026-06-01", pinned: true,
      },
    });
    expect("path" in dto).toBe(false);
    expect(dto).toEqual({
      slug: "s", type: "user", description: "d", tags: ["t"],
      pinned: true, created: "2026-06-01", body: "body text", platforms: ["macos"],
    });
  });

  test("toListEntryDTO passes the no-path entry through", () => {
    const dto = toListEntryDTO({
      slug: "s", type: "reference", description: "d",
      tags: [], created: "2026-06-01", pinned: false, platforms: [], project: "alpha",
    });
    expect("path" in dto).toBe(false);
    expect(dto).toEqual({ slug: "s", type: "reference", description: "d", tags: [], created: "2026-06-01", pinned: false, platforms: [], supersededBy: undefined });
  });

  test("toListEntryDTO passes supersededBy through (bri)", () => {
    const dto = toListEntryDTO({
      slug: "old-fact", type: "project", description: "d",
      tags: [], created: "2026-06-01", pinned: false, platforms: [], project: "alpha", supersededBy: "new-fact",
    });
    expect(dto.supersededBy).toBe("new-fact");
    expect("path" in dto).toBe(false);
  });

  test("toFactDTO exposes supersession fields when present (bri integration review)", () => {
    const dto = toFactDTO({
      slug: "new-fact", type: "project", path: "/abs/secret/path/new-fact.md",
      body: "body",
      frontmatter: {
        name: "new-fact", description: "d", type: "project", tags: [],
        project: "global", platforms: [], created: "2026-06-01", pinned: false,
        updated: "2026-06-10T12:00:00.000Z",
        supersedes: "old-fact",
        conflictsWith: undefined,
        supersededBy: undefined,
      },
    });
    expect(dto.updated).toBe("2026-06-10T12:00:00.000Z");
    expect(dto.supersedes).toBe("old-fact");
    expect(dto.supersededBy).toBeUndefined();
    expect(dto.conflictsWith).toBeUndefined();
    expect("path" in dto).toBe(false);
  });

  test("toFactDTO exposes supersededBy on a retired fact (bri integration review)", () => {
    const dto = toFactDTO({
      slug: "old-fact", type: "project", path: "/abs/secret/path/old-fact.md",
      body: "old body",
      frontmatter: {
        name: "old-fact", description: "d", type: "project", tags: [],
        project: "global", platforms: [], created: "2026-05-01", pinned: false,
        supersededBy: "new-fact",
      },
    });
    expect(dto.supersededBy).toBe("new-fact");
    expect(dto.supersedes).toBeUndefined();
    expect(dto.updated).toBeUndefined();
    expect(dto.conflictsWith).toBeUndefined();
    expect("path" in dto).toBe(false);
  });

  test("toFactDTO leaves supersession fields absent on a clean fact (bri integration review)", () => {
    const dto = toFactDTO({
      slug: "clean", type: "user", path: "/abs/secret/path/clean.md",
      body: "body",
      frontmatter: {
        name: "clean", description: "d", type: "user", tags: [],
        project: "global", platforms: [], created: "2026-06-01", pinned: false,
      },
    });
    expect(dto.updated).toBeUndefined();
    expect(dto.supersedes).toBeUndefined();
    expect(dto.supersededBy).toBeUndefined();
    expect(dto.conflictsWith).toBeUndefined();
  });

  test("toFactDTO exposes conflictsWith on a force-written contradicting fact (cr4/bri)", () => {
    const dto = toFactDTO({
      slug: "conflict-fact", type: "project", path: "/abs/secret/path/conflict-fact.md",
      body: "body",
      frontmatter: {
        name: "conflict-fact", description: "d", type: "project", tags: [],
        project: "global", platforms: [], created: "2026-06-01", pinned: false,
        conflictsWith: "other-fact",
      },
    });
    expect(dto.conflictsWith).toBe("other-fact");
    expect(dto.supersedes).toBeUndefined();
    expect(dto.supersededBy).toBeUndefined();
    expect("path" in dto).toBe(false);
  });
});

describe("toRememberDTO (qp-nq2 — one mapper for MCP structuredContent + REST)", () => {
  test("maps the full remember surface incl. authorityComparison, drops path", async () => {
    const { toRememberDTO } = await import("../src/mcp/server.js");
    const res = {
      wrote: false, slug: "s", path: "/abs/secret/s.md", type: "project" as const,
      duplicateOf: "other", duplicateDescription: "dd", duplicateBody: "db",
      disposition: "conflict" as const,
      authorityComparison: { candidate: { source: "a" }, existing: { slug: "other" } },
      indexed: true, synced: true, dedupSkipped: 0,
      supersedeWarning: "w",
    };
    // Structural cast: only the mapped subset matters here.
    const dto = toRememberDTO(res as never);
    expect("path" in dto).toBe(false);
    // REST omitted authorityComparison before the shared mapper (the drift this locks out).
    expect(dto.authorityComparison).toEqual(res.authorityComparison);
    expect(dto).toMatchObject({ wrote: false, slug: "s", type: "project", duplicateOf: "other", disposition: "conflict", supersedeWarning: "w" });
  });
});
