import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { packedTarballFilename } = require("../scripts/smoke-clean-room.cjs") as {
  packedTarballFilename: (stdout: string) => string;
};

/** `npm pack --json` shape through npm 11: an array, one entry per packed package. */
const NPM11 = JSON.stringify([
  { id: "@ciel2142/qmemd@0.8.2", name: "@ciel2142/qmemd", filename: "ciel2142-qmemd-0.8.2.tgz", files: [] },
]);

/** npm 12 shape: an object keyed by package name. `[0]` on it is undefined — the
 *  release-CI break this helper exists for (run 32007206789). */
const NPM12 = JSON.stringify({
  "@ciel2142/qmemd": { id: "@ciel2142/qmemd@0.8.2", name: "@ciel2142/qmemd", filename: "ciel2142-qmemd-0.8.2.tgz", files: [] },
});

describe("packedTarballFilename (npm pack --json shape drift)", () => {
  it("reads the array shape emitted by npm <= 11", () => {
    expect(packedTarballFilename(NPM11)).toBe("ciel2142-qmemd-0.8.2.tgz");
  });

  it("reads the name-keyed object shape emitted by npm >= 12", () => {
    expect(packedTarballFilename(NPM12)).toBe("ciel2142-qmemd-0.8.2.tgz");
  });

  it("strips a directory prefix from the reported filename", () => {
    const withDir = JSON.stringify([{ filename: "/tmp/out/ciel2142-qmemd-0.8.2.tgz" }]);
    expect(packedTarballFilename(withDir)).toBe("ciel2142-qmemd-0.8.2.tgz");
  });

  it("throws with the raw output when the payload carries no filename", () => {
    expect(() => packedTarballFilename("[]")).toThrow(/no packed filename/i);
    expect(() => packedTarballFilename(JSON.stringify({ "@ciel2142/qmemd": { name: "x" } })))
      .toThrow(/no packed filename/i);
  });

  it("throws with the raw output when stdout is not JSON", () => {
    expect(() => packedTarballFilename("npm warn something\n")).toThrow(/npm warn something/);
  });
});
