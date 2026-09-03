import { describe, test, expect } from "vitest";
import { defaultProjectFor, isBlankProject, resolveWriteScope } from "../src/scope.js";

describe("defaultProjectFor", () => {
  // covers: SC-26
  test("user and feedback default to global regardless of cwd", () => {
    expect(defaultProjectFor("user", "/home/igi21/experiements/qmemd-public")).toBe("global");
    expect(defaultProjectFor("feedback", "/")).toBe("global");
  });

  // covers: SC-26
  test("project and reference default to basename(cwd)", () => {
    expect(defaultProjectFor("project", "/home/igi21/experiements/qmemd-public")).toBe("qmemd-public");
    expect(defaultProjectFor("reference", "/home/igi21/experiements/qmemd-public")).toBe("qmemd-public");
  });

  // covers: SC-26
  test("project/reference falls back to global when basename(cwd) is empty", () => {
    expect(defaultProjectFor("project", "/")).toBe("global");
    expect(defaultProjectFor("reference", "/")).toBe("global");
  });
});

describe("isBlankProject", () => {
  // covers: SC-26
  test("true for undefined, empty, and whitespace-only", () => {
    expect(isBlankProject(undefined)).toBe(true);
    expect(isBlankProject("")).toBe(true);
    expect(isBlankProject("   ")).toBe(true);
  });

  // covers: SC-26
  test("false for a non-blank project", () => {
    expect(isBlankProject("x")).toBe(false);
  });
});

describe("resolveWriteScope", () => {
  // covers: SC-27
  test("a non-replace write takes the explicit project, else the type+cwd default", () => {
    expect(resolveWriteScope({ project: "chosen", type: "project", cwd: "/x/repo-a" })).toBe("chosen");
    expect(resolveWriteScope({ type: "project", cwd: "/x/repo-a" })).toBe("repo-a");
    expect(resolveWriteScope({ type: "user", cwd: "/x/repo-a" })).toBe("global");
  });

  // covers: SC-27
  test("an untyped write defaults as a reference fact, scoped to the cwd", () => {
    expect(resolveWriteScope({ cwd: "/x/repo-a" })).toBe("repo-a");
  });

  // covers: SC-27
  test("a replace passes an explicit project through but never substitutes a default", () => {
    expect(resolveWriteScope({ project: "chosen", type: "project", replace: true, cwd: "/x/repo-a" })).toBe("chosen");
    expect(resolveWriteScope({ type: "project", replace: true, cwd: "/x/repo-a" })).toBeUndefined();
  });

  // covers: SC-29
  test("a blank project is treated as missing on both paths", () => {
    expect(resolveWriteScope({ project: "   ", type: "project", cwd: "/x/repo-a" })).toBe("repo-a");
    expect(resolveWriteScope({ project: "", type: "project", replace: true, cwd: "/x/repo-a" })).toBeUndefined();
  });
});
