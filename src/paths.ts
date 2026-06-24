import { homedir } from "node:os";
import { join } from "node:path";

/** Memory data dir. Same env var qmd used, so the daemon.env/data dir carry over unchanged. */
export function memoryRoot(): string {
  return process.env.QMD_MEMORY_DIR || join(homedir(), ".local", "share", "qmd-memory");
}

/**
 * Dedicated qmemd index DB — never qmd's ~/.cache/qmd/index.sqlite.
 * QMEMD_DB pins an exact path (wins); otherwise it lives under cacheDir(), so
 * index.sqlite stays co-located with the daemon's pid/log and honours
 * XDG_CACHE_HOME like everything else under cacheDir().
 */
export function indexDbPath(): string {
  return process.env.QMEMD_DB || join(cacheDir(), "index.sqlite");
}

/**
 * Cache dir for the index DB and the HTTP daemon's pid/log files. Honours
 * XDG_CACHE_HOME (so tests can redirect it) and otherwise falls back to
 * ~/.cache/qmemd.
 */
export function cacheDir(): string {
  return process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "qmemd")
    : join(homedir(), ".cache", "qmemd");
}

/** Pid + log file paths for the HTTP MCP daemon, under cacheDir(). */
export function daemonPaths(): { pidPath: string; logPath: string } {
  const dir = cacheDir();
  return { pidPath: join(dir, "mcp.pid"), logPath: join(dir, "mcp.log") };
}

/** Base XDG config dir (honours XDG_CONFIG_HOME so tests can redirect). */
function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/** systemd --user unit dir. systemd itself reads this exact path. */
export function systemdUserDir(): string {
  return join(configHome(), "systemd", "user");
}

/** qmemd config dir — holds the daemon.env EnvironmentFile for the systemd unit. */
export function qmemdConfigDir(): string {
  return join(configHome(), "qmemd");
}

/** macOS LaunchAgents dir for the per-user launchd plist. */
export function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

/** macOS logs dir for the launchd daemon's stdout/stderr. */
export function macLogsDir(): string {
  return join(homedir(), "Library", "Logs");
}
