import { describe, test, expect } from "vitest";
import { selectCommands } from "../scripts/overlap-calibrate.js";

describe("overlap-calibrate selectCommands", () => {
  // covers: SC-49
  test("takes exactly the last N records from a newline-terminated log", () => {
    const logText = Array.from({ length: 10 }, (_, i) => `[2026-01-01T00:00:0${i}Z] cmd${i}`).join("\n") + "\n";
    const { commands } = selectCommands(logText, 3);
    expect(commands).toEqual(["cmd7", "cmd8", "cmd9"]);
  });

  // covers: SC-49
  test("a trailing newline's phantom empty line does not consume one of the --last N records", () => {
    const logText = "[2026-01-01T00:00:00Z] echo a\n[2026-01-01T00:00:01Z] echo b\n[2026-01-01T00:00:02Z] echo c\n";
    const { commands } = selectCommands(logText, 3);
    expect(commands).toEqual(["echo a", "echo b", "echo c"]);
  });

  // covers: SC-49
  test("strips the bracketed ISO timestamp prefix", () => {
    const { commands } = selectCommands("[2026-01-01T00:00:00.000Z] git status\n", undefined);
    expect(commands).toEqual(["git status"]);
  });

  // covers: SC-49
  test("skips blank lines without counting them as own-subject", () => {
    const logText = "[2026-01-01T00:00:00Z] echo one\n\n[2026-01-01T00:00:01Z]   \n[2026-01-01T00:00:02Z] echo two\n";
    const { commands, skippedOwnSubject } = selectCommands(logText, undefined);
    expect(commands).toEqual(["echo one", "echo two"]);
    expect(skippedOwnSubject).toBe(0);
  });

  // covers: SC-49
  test("drops own-subject commands and counts them", () => {
    const logText = [
      "[2026-01-01T00:00:00Z] br ready",
      "[2026-01-01T00:00:01Z] qmemd recall x",
      "[2026-01-01T00:00:02Z] git status",
    ].join("\n") + "\n";
    const { commands, skippedOwnSubject } = selectCommands(logText, undefined);
    expect(commands).toEqual(["git status"]);
    expect(skippedOwnSubject).toBe(2);
  });
});
