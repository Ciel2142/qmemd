import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { captureDaemonEnv, serviceArtifacts } from "../src/service.js";
import { writeArtifacts, removeArtifacts } from "../src/service.js";

describe("captureDaemonEnv", () => {
  const base = { QMD_MEMORY_DIR: "/mem", PATH: "/bin", QMEMD_DB: "/db", QMD_EMBED_MODEL: "qwen3" };

  test("linux captures memory dir, PATH, LD_LIBRARY_PATH, QMEMD_DB", () => {
    const env = { ...base, LD_LIBRARY_PATH: "/cuda" };
    expect(captureDaemonEnv("linux", env)).toEqual([
      ["QMD_MEMORY_DIR", "/mem"],
      ["PATH", "/bin"],
      ["LD_LIBRARY_PATH", "/cuda"],
      ["QMEMD_DB", "/db"],
    ]);
  });

  test("never captures QMD_EMBED_MODEL", () => {
    const pairs = captureDaemonEnv("linux", { ...base, LD_LIBRARY_PATH: "/cuda" });
    expect(pairs.find(([k]) => k === "QMD_EMBED_MODEL")).toBeUndefined();
  });

  test("captures QMEMD_EMBED_MODEL when set, so the daemon embeds with the CLI's model (qmemd-rkl)", () => {
    const pairs = captureDaemonEnv("linux", { ...base, QMEMD_EMBED_MODEL: "hf:custom/model.gguf" });
    expect(pairs).toContainEqual(["QMEMD_EMBED_MODEL", "hf:custom/model.gguf"]);
  });

  test("omits QMEMD_EMBED_MODEL when unset (qmemd-rkl)", () => {
    const pairs = captureDaemonEnv("linux", base); // base has no QMEMD_EMBED_MODEL
    expect(pairs.find(([k]) => k === "QMEMD_EMBED_MODEL")).toBeUndefined();
  });

  test("captures XDG_CACHE_HOME when set, so the daemon's cacheDir()/index path matches the CLI's (qp-daemon-index-identity-health-0lq)", () => {
    // Without QMEMD_DB, indexDbPath() derives from cacheDir() → XDG_CACHE_HOME. A systemd --user
    // daemon never sources .bashrc, so an uncaptured XDG_CACHE_HOME makes it open an empty
    // ~/.cache/qmemd index while the CLI writes under $XDG_CACHE_HOME — /health rootHash still
    // matches, so every hybrid recall delegates and returns hits:[] though facts exist on disk.
    const pairs = captureDaemonEnv("linux", { ...base, XDG_CACHE_HOME: "/home/u/.cache" });
    expect(pairs).toContainEqual(["XDG_CACHE_HOME", "/home/u/.cache"]);
  });

  test("omits XDG_CACHE_HOME when unset", () => {
    expect(captureDaemonEnv("linux", base).find(([k]) => k === "XDG_CACHE_HOME")).toBeUndefined();
  });

  test("darwin omits LD_LIBRARY_PATH even when set", () => {
    const pairs = captureDaemonEnv("darwin", { ...base, LD_LIBRARY_PATH: "/cuda" });
    expect(pairs.find(([k]) => k === "LD_LIBRARY_PATH")).toBeUndefined();
  });

  test("omits optional vars that are unset", () => {
    const pairs = captureDaemonEnv("linux", { QMD_MEMORY_DIR: "/mem", PATH: "/bin" });
    expect(pairs.map(([k]) => k)).toEqual(["QMD_MEMORY_DIR", "PATH"]);
  });
});

const OPTS = {
  port: 8182,
  exec: { bin: "/usr/bin/bun", entry: "/app/dist/cli/qmemd.js" },
  env: [["QMD_MEMORY_DIR", "/mem"], ["PATH", "/bin"]] as Array<[string, string]>,
  dirs: {
    systemdUser: "/c/systemd/user",
    qmemdConfig: "/c/qmemd",
    launchAgents: "/h/Library/LaunchAgents",
    macLogs: "/h/Library/Logs",
  },
};

describe("serviceArtifacts linux", () => {
  const a = serviceArtifacts("linux", OPTS);

  test("writes unit + daemon.env at the systemd paths", () => {
    expect(a.files.map(f => f.path)).toEqual([
      join("/c/systemd/user", "qmemd-mcp.service"),
      join("/c/qmemd", "daemon.env"),
    ]);
  });

  test("unit has Restart=always, EnvironmentFile, and the port-baked ExecStart", () => {
    const unit = a.files[0].content;
    expect(unit).toContain("Restart=always");
    expect(unit).toContain(`EnvironmentFile=${join("/c/qmemd", "daemon.env")}`);
    expect(unit).toContain("ExecStart=/usr/bin/bun /app/dist/cli/qmemd.js mcp --http --port 8182");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("daemon.env carries the pairs and never QMD_EMBED_MODEL", () => {
    const envFile = a.files[1].content;
    expect(envFile).toContain("QMD_MEMORY_DIR=/mem");
    expect(envFile).toContain("PATH=/bin");
    expect(envFile).not.toContain("QMD_EMBED_MODEL");
  });

  test("activation + deactivation command sequences", () => {
    expect(a.activation).toEqual([
      "loginctl enable-linger",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now qmemd-mcp.service",
    ]);
    expect(a.deactivation).toEqual([
      "systemctl --user disable --now qmemd-mcp.service",
      "systemctl --user daemon-reload",
    ]);
  });
});

describe("serviceArtifacts darwin", () => {
  const a = serviceArtifacts("darwin", { ...OPTS, env: [["QMD_MEMORY_DIR", "/mem"], ["PATH", "/bin"]] });

  test("writes a single plist at the LaunchAgents path", () => {
    expect(a.files.map(f => f.path)).toEqual([
      join("/h/Library/LaunchAgents", "io.qmemd.mcp.plist"),
    ]);
  });

  test("plist has Label, KeepAlive, RunAtLoad, and the port-baked ProgramArguments", () => {
    const plist = a.files[0].content;
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>io.qmemd.mcp</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/app/dist/cli/qmemd.js</string>");
    expect(plist).toContain("<string>--port</string>");
    expect(plist).toContain("<string>8182</string>");
  });

  test("plist EnvironmentVariables carries the pairs, no LD_LIBRARY_PATH, no QMD_EMBED_MODEL", () => {
    const plist = a.files[0].content;
    expect(plist).toContain("<key>QMD_MEMORY_DIR</key>");
    expect(plist).toContain("<string>/mem</string>");
    expect(plist).not.toContain("LD_LIBRARY_PATH");
    expect(plist).not.toContain("QMD_EMBED_MODEL");
  });

  test("activation bootstrap + deactivation bootout", () => {
    expect(a.activation).toEqual([
      "launchctl bootstrap gui/$(id -u) /h/Library/LaunchAgents/io.qmemd.mcp.plist",
    ]);
    expect(a.deactivation).toEqual([
      "launchctl bootout gui/$(id -u)/io.qmemd.mcp",
    ]);
  });
});

describe("writeArtifacts / removeArtifacts", () => {
  test("writes content, creating nested dirs; removes idempotently", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qmemd-svc-"));
    try {
      const arts = {
        files: [{ path: join(tmp, "a", "b", "x.service"), content: "hello\n" }],
        activation: [],
        deactivation: [],
      };
      writeArtifacts(arts);
      expect(readFileSync(join(tmp, "a", "b", "x.service"), "utf-8")).toBe("hello\n");

      const removed = removeArtifacts(arts);
      expect(removed).toEqual([join(tmp, "a", "b", "x.service")]);
      expect(existsSync(join(tmp, "a", "b", "x.service"))).toBe(false);

      expect(removeArtifacts(arts)).toEqual([]); // already gone → no-op
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
