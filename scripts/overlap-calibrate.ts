// Overlap calibration replay (Task 4, open item 3): replays the operator's real Bash
// history through `matchCommand` against one project's token map, printing per-command
// hits for hand-labelling plus a summary (fire rate, hit histogram, top slugs). Opens no
// store, loads no embedding model — filesystem + in-memory scoring only. Not a test,
// never part of `npm test`.
//   npm run calibrate:overlap -- [--log ~/.claude/bash-commands.log] [--project <repo>]
//                                 [--last N] [--df-fraction F] [--min-score S]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { memoryRoot } from "../src/paths.js";
import {
  buildTokenMap, commandTokens, isOwnSubjectCommand, matchCommand,
  OVERLAP_DF_FRACTION, OVERLAP_MIN_SCORE,
  type TokenMap,
} from "../src/overlap.js";

const COMMAND_TRUNCATE = 100;
const TOP_SLUGS = 20;
const LOG_LINE_RE = /^\[[^\]]*\]\s*(.*)$/;

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function parseArgs(argv: string[]) {
  const flag = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const log = expandHome(flag("--log") ?? "~/.claude/bash-commands.log");
  const project = flag("--project") ?? basename(process.cwd());
  const lastArg = flag("--last");
  const last = lastArg !== undefined ? Number.parseInt(lastArg, 10) : undefined;
  const dfFractionArg = flag("--df-fraction");
  const minScoreArg = flag("--min-score");
  const dfFraction = dfFractionArg !== undefined ? Number.parseFloat(dfFractionArg) : undefined;
  const minScore = minScoreArg !== undefined ? Number.parseFloat(minScoreArg) : undefined;
  return { log, project, last, dfFraction, minScore };
}

export interface SelectedCommands {
  commands: string[];
  skippedOwnSubject: number;
}

/** Drop the trailing empty element a final newline produces before slicing, or
 *  `--last N` silently processes N-1 real records. */
export function selectCommands(logText: string, last: number | undefined): SelectedCommands {
  const rawLines = logText.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines = last !== undefined ? rawLines.slice(-last) : rawLines;

  const commands: string[] = [];
  let skippedOwnSubject = 0;
  for (const line of lines) {
    const m = LOG_LINE_RE.exec(line);
    const command = (m ? m[1] : line).trim();
    if (command.length === 0) continue;
    if (isOwnSubjectCommand(command)) { skippedOwnSubject++; continue; }
    commands.push(command);
  }
  return { commands, skippedOwnSubject };
}

interface ReplayStats {
  replayed: number;
  withHit: number;
  histogram: Map<number, number>;
  slugFireCount: Map<string, number>;
}

function replay(root: string, commands: string[], map: TokenMap, dfFraction: number | undefined, minScore: number | undefined, out: (s: string) => void): ReplayStats {
  const stats: ReplayStats = {
    replayed: 0,
    withHit: 0,
    histogram: new Map(),
    slugFireCount: new Map(),
  };
  const exclude = new Set<string>();
  for (const command of commands) {
    stats.replayed++;
    const tokens = commandTokens(command);
    const hits = matchCommand(root, tokens, map, exclude, { dfFraction, minScore });
    if (hits.length === 0) continue;
    stats.withHit++;
    stats.histogram.set(hits.length, (stats.histogram.get(hits.length) ?? 0) + 1);
    const truncated = command.length > COMMAND_TRUNCATE ? command.slice(0, COMMAND_TRUNCATE) : command;
    for (const hit of hits) {
      stats.slugFireCount.set(hit.slug, (stats.slugFireCount.get(hit.slug) ?? 0) + 1);
      out(`${hit.score} ${hit.slug} [${hit.tokens.join(",")}]  ::  ${truncated}`);
    }
  }
  return stats;
}

function printSummary(stats: ReplayStats, skippedOwnSubject: number, factCount: number, dfFraction: number, minScore: number, project: string, logPath: string) {
  const rate = stats.replayed > 0 ? (stats.withHit / stats.replayed) : 0;
  const dfCap = Math.max(3, Math.ceil(dfFraction * factCount));
  console.log("--- summary ---");
  console.log(`log: ${logPath}`);
  console.log(`project: ${project}  facts: ${factCount}  df-cap: ${dfCap}  min-score: ${minScore}`);
  console.log(`commands replayed: ${stats.replayed}`);
  console.log(`skipped own-subject: ${skippedOwnSubject}`);
  console.log(`commands with >=1 hit: ${stats.withHit}  fire rate: ${(rate * 100).toFixed(2)}%`);
  console.log("hit-count histogram:");
  for (const n of [...stats.histogram.keys()].sort((a, b) => a - b)) {
    console.log(`  ${n} hit${n === 1 ? "" : "s"}: ${stats.histogram.get(n)}`);
  }
  console.log(`top-${TOP_SLUGS} slugs by fire count:`);
  const topSlugs = [...stats.slugFireCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_SLUGS);
  for (const [slug, count] of topSlugs) {
    console.log(`  ${count}  ${slug}`);
  }
}

function main() {
  const { log, project, last, dfFraction, minScore } = parseArgs(process.argv.slice(2));
  const root = memoryRoot();
  const map = buildTokenMap(root, project);
  const logText = readFileSync(log, "utf-8");
  const { commands, skippedOwnSubject } = selectCommands(logText, last);
  const effectiveDfFraction = dfFraction ?? OVERLAP_DF_FRACTION;
  const effectiveMinScore = minScore ?? OVERLAP_MIN_SCORE;
  const stats = replay(root, commands, map, dfFraction, minScore, (s) => console.log(s));
  printSummary(stats, skippedOwnSubject, Object.keys(map.facts).length, effectiveDfFraction, effectiveMinScore, project, log);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
