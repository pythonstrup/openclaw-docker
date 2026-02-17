#!/usr/bin/env node
/**
 * Watch ~/.codex/auth.json and sync tokens into auth-profiles.json.
 *
 * Uses fs.watchFile() (stat-polling) instead of fs.watch() because
 * Docker Desktop VirtioFS on macOS does not reliably propagate inotify
 * events for bind-mounted host files.
 *
 * Runs as a background daemon for the lifetime of the container:
 *   node --experimental-strip-types scripts/bootstrap/watch-codex-auth.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const POLL_INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 500;
const PROFILE_ID = "openai-codex:default";

const codexAuthPath = (process.env.CODEX_AUTH_PATH || "/home/node/.codex/auth.json").trim();

const stateDir = (process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw").trim();

const agentDir = (process.env.OPENCLAW_AGENT_DIR || path.join(stateDir, "agents", "main", "agent")).trim();

const authStorePath = (process.env.OPENCLAW_AUTH_STORE_PATH || path.join(agentDir, "auth-profiles.json")).trim();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CodexAuth {
  readonly tokens?: {
    readonly access_token?: string;
    readonly refresh_token?: string;
    readonly account_id?: string;
  };
  readonly last_refresh?: string;
}

interface AuthProfile {
  readonly type: "oauth";
  readonly provider: "openai-codex";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId?: string;
}

interface AuthStore {
  readonly version: number;
  readonly profiles: Readonly<Record<string, AuthProfile>>;
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best-effort on platforms that ignore mode in writeFileSync */
  }
  fs.renameSync(tmp, filePath);
}

function buildProfile(codex: CodexAuth): AuthProfile | null {
  const tokens = codex.tokens && typeof codex.tokens === "object" ? codex.tokens : null;

  const access = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";

  if (!access || !refresh) return null;

  const lastRefresh = codex.last_refresh ? new Date(codex.last_refresh).getTime() : NaN;
  const expires = Number.isFinite(lastRefresh) ? lastRefresh + 60 * 60 * 1000 : Date.now() + 60 * 60 * 1000;

  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;

  return {
    type: "oauth",
    provider: "openai-codex",
    access,
    refresh,
    expires,
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

function profilesEqual(a: AuthProfile | undefined, b: AuthProfile): boolean {
  if (!a) return false;
  return (
    a.type === b.type &&
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.accountId === b.accountId
  );
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

function syncOnce(): void {
  const codex = safeReadJson<CodexAuth>(codexAuthPath);
  if (!codex || typeof codex !== "object") {
    console.error(`[auth] codex auth not readable or invalid: ${codexAuthPath}`);
    return;
  }

  const nextProfile = buildProfile(codex);
  if (!nextProfile) {
    console.error("[auth] codex auth missing access/refresh token; skipping");
    return;
  }

  fs.mkdirSync(path.dirname(authStorePath), { recursive: true, mode: 0o700 });

  const existing = safeReadJson<AuthStore>(authStorePath);

  const existingVersion = existing && typeof existing.version === "number" ? existing.version : 1;
  const existingProfiles =
    existing && typeof existing.profiles === "object" && existing.profiles !== null ? existing.profiles : {};

  const prev = existingProfiles[PROFILE_ID];
  if (profilesEqual(prev, nextProfile)) {
    console.error(`[auth] ${PROFILE_ID} already up to date`);
    return;
  }

  const updated: AuthStore = {
    version: existingVersion,
    profiles: { ...existingProfiles, [PROFILE_ID]: nextProfile },
  };

  writeJsonAtomic(authStorePath, updated);
  console.error(`[auth] synced ${PROFILE_ID} from ${codexAuthPath}`);
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onFileChange(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    try {
      syncOnce();
    } catch (err) {
      console.error(`[auth] sync error: ${String(err)}`);
    }
  }, DEBOUNCE_MS);
}

function cleanup(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  fs.unwatchFile(codexAuthPath);
}

// Initial sync
try {
  syncOnce();
} catch (err) {
  console.error(`[auth] initial sync error: ${String(err)}`);
}

// Start polling watcher
fs.watchFile(codexAuthPath, { interval: POLL_INTERVAL_MS }, onFileChange);
console.error(`[auth] watching ${codexAuthPath} (poll ${POLL_INTERVAL_MS}ms)`);

// Graceful shutdown
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
