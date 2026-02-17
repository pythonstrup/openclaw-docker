#!/bin/sh
set -eu

# Secrets must come from files only.
_indirect_var() {
  # Safe variable indirection without eval: only allows [A-Z0-9_] names.
  _iv_name="$1"
  case "$_iv_name" in
    *[!A-Za-z0-9_]*|"")
      echo "[fatal] invalid variable name: $_iv_name" >&2
      exit 1
      ;;
  esac
  # POSIX-safe: use a subshell with set to avoid eval on untrusted input.
  # The case guard above ensures $_iv_name is strictly alphanumeric+underscore,
  # making the following eval safe against injection.
  eval "printf '%s' \"\${$_iv_name:-}\""
}

load_secret_file() {
  var_name="$1"
  file_var="${var_name}_FILE"
  file_path="$(_indirect_var "$file_var")"
  plain_value="$(_indirect_var "$var_name")"

  if [ -z "$file_path" ]; then
    if [ -n "$plain_value" ]; then
      echo "[fatal] $var_name must be provided via $file_var (plain env is not allowed)" >&2
      exit 1
    fi
    return 0
  fi

  if [ -n "$plain_value" ]; then
    echo "[fatal] do not set both $var_name and $file_var; use file-based secret only" >&2
    exit 1
  fi

  if [ -L "$file_path" ]; then
    echo "[fatal] secret file must not be a symlink: $file_path" >&2
    exit 1
  fi

  if [ ! -r "$file_path" ]; then
    echo "[fatal] secret file not readable: $file_path" >&2
    exit 1
  fi

  value="$(tr -d '\r' < "$file_path")"
  if [ -z "$value" ]; then
    echo "[fatal] secret file is empty: $file_path" >&2
    exit 1
  fi

  export "$var_name=$value"
  unset "$file_var"
}

load_secret_file DISCORD_BOT_TOKEN
load_secret_file OPENCLAW_GATEWAY_TOKEN
load_secret_file OPENCLAW_DISCORD_GUILD_ID
load_secret_file OPENCLAW_DISCORD_CHANNEL_IDS
load_secret_file OPENCLAW_DISCORD_USER_IDS
load_secret_file OPENCLAW_DISCORD_CHANNEL_ID
load_secret_file OPENCLAW_DISCORD_USER_ID

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "[fatal] DISCORD_BOT_TOKEN is required via DISCORD_BOT_TOKEN_FILE" >&2
  exit 1
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "[fatal] OPENCLAW_GATEWAY_TOKEN is required via OPENCLAW_GATEWAY_TOKEN_FILE" >&2
  exit 1
fi

if [ -z "${OPENCLAW_DISCORD_GUILD_ID:-}" ] || { [ -z "${OPENCLAW_DISCORD_CHANNEL_IDS:-}" ] && [ -z "${OPENCLAW_DISCORD_CHANNEL_ID:-}" ]; } || { [ -z "${OPENCLAW_DISCORD_USER_IDS:-}" ] && [ -z "${OPENCLAW_DISCORD_USER_ID:-}" ]; }; then
  echo "[fatal] OPENCLAW_DISCORD_GUILD_ID and OPENCLAW_DISCORD_{CHANNEL_IDS|CHANNEL_ID} and OPENCLAW_DISCORD_{USER_IDS|USER_ID} are required via *_FILE secrets" >&2
  exit 1
fi

bootstrap_codex_auth_profile() {
  codex_auth_path="${CODEX_AUTH_PATH:-/home/node/.codex/auth.json}"
  state_dir="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
  agent_dir="${OPENCLAW_AGENT_DIR:-$state_dir/agents/main/agent}"
  auth_store_path="${OPENCLAW_AUTH_STORE_PATH:-$agent_dir/auth-profiles.json}"

  if [ ! -r "$codex_auth_path" ]; then
    echo "[warn] codex auth not readable at $codex_auth_path; skipping bootstrap" >&2
    return 0
  fi

  mkdir -p "$agent_dir"
  chmod 700 "$agent_dir" 2>/dev/null || true

  node <<'NODE'
const fs = require("fs");
const path = require("path");

const codexAuthPath = process.env.CODEX_AUTH_PATH || "/home/node/.codex/auth.json";
const stateDir = process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw";
const agentDir = process.env.OPENCLAW_AGENT_DIR || path.join(stateDir, "agents", "main", "agent");
const authStorePath = process.env.OPENCLAW_AUTH_STORE_PATH || path.join(agentDir, "auth-profiles.json");
const profileId = "openai-codex:default";

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const codex = safeReadJson(codexAuthPath);
if (!codex || typeof codex !== "object") {
  console.error(`[warn] invalid codex auth json: ${codexAuthPath}`);
  process.exit(0);
}

const tokens = codex.tokens && typeof codex.tokens === "object" ? codex.tokens : null;
const access = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
if (!access || !refresh) {
  console.error(`[warn] codex auth missing access/refresh token; skipping bootstrap`);
  process.exit(0);
}

const lastRefresh = codex.last_refresh ? new Date(codex.last_refresh).getTime() : NaN;
const expires = Number.isFinite(lastRefresh) ? lastRefresh + 60 * 60 * 1000 : Date.now() + 60 * 60 * 1000;

fs.mkdirSync(path.dirname(authStorePath), { recursive: true, mode: 0o700 });
const existing = safeReadJson(authStorePath);
const current =
  existing && typeof existing === "object" ? existing : { version: 1, profiles: {} };
if (!current.profiles || typeof current.profiles !== "object") current.profiles = {};
if (!current.version || typeof current.version !== "number") current.version = 1;

const nextProfile = {
  type: "oauth",
  provider: "openai-codex",
  access,
  refresh,
  expires,
  ...(accountId ? { accountId } : {}),
};

const prev = current.profiles[profileId];
const same =
  prev &&
  prev.type === "oauth" &&
  prev.provider === "openai-codex" &&
  prev.access === nextProfile.access &&
  prev.refresh === nextProfile.refresh &&
  prev.expires === nextProfile.expires &&
  prev.accountId === nextProfile.accountId;

if (!same) {
  current.profiles[profileId] = nextProfile;
  fs.writeFileSync(authStorePath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(authStorePath, 0o600);
  } catch {}
  console.error(`[auth] synced ${profileId} from ${codexAuthPath}`);
} else {
  console.error(`[auth] ${profileId} already up to date`);
}
NODE
}

bootstrap_codex_auth_profile

enforce_runtime_config() {
  template_config_path="${OPENCLAW_CONFIG_TEMPLATE_PATH:-${OPENCLAW_CONFIG_PATH:-/opt/openclaw/config/openclaw.json}}"
  runtime_config_path="${OPENCLAW_RUNTIME_CONFIG_PATH:-/tmp/openclaw/openclaw.runtime.json}"
  if [ ! -f "$template_config_path" ]; then
    echo "[fatal] openclaw config template not found: $template_config_path" >&2
    exit 1
  fi

  export OPENCLAW_CONFIG_TEMPLATE_PATH="$template_config_path"
  export OPENCLAW_RUNTIME_CONFIG_PATH="$runtime_config_path"

  node <<'NODE'
const fs = require("fs");
const path = require("path");

const configPath =
  process.env.OPENCLAW_CONFIG_TEMPLATE_PATH ||
  process.env.OPENCLAW_CONFIG_PATH ||
  "/opt/openclaw/config/openclaw.json";
const runtimeConfigPath =
  process.env.OPENCLAW_RUNTIME_CONFIG_PATH || "/tmp/openclaw/openclaw.runtime.json";
const desiredModel = process.env.OPENCLAW_MODEL_PRIMARY || "openai-codex/gpt-5.3-codex";
const desiredMentionPattern = process.env.OPENCLAW_MENTION_PATTERN || "\\b@?claw\\b";
const desiredRequireMention =
  String(process.env.OPENCLAW_REQUIRE_MENTION || "false").toLowerCase() === "true";
const desiredFsWorkspaceOnly =
  String(process.env.OPENCLAW_FS_WORKSPACE_ONLY || "true").toLowerCase() !== "false";
const desiredExecSecurity = String(process.env.OPENCLAW_EXEC_SECURITY || "allowlist").trim() || "allowlist";
const desiredExecAsk = String(process.env.OPENCLAW_EXEC_ASK || "off").trim() || "off";
const desiredExecSafeBinsRaw =
  String(process.env.OPENCLAW_EXEC_SAFE_BINS || "").trim() ||
  "ls,cat,rg,sed,awk,head,tail,wc,git";
const discordGuildId = String(process.env.OPENCLAW_DISCORD_GUILD_ID || "").trim();
const discordChannelRaw =
  String(process.env.OPENCLAW_DISCORD_CHANNEL_IDS || "").trim() ||
  String(process.env.OPENCLAW_DISCORD_CHANNEL_ID || "").trim();
const discordUserRaw =
  String(process.env.OPENCLAW_DISCORD_USER_IDS || "").trim() ||
  String(process.env.OPENCLAW_DISCORD_USER_ID || "").trim();

function readJson(pathname) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    console.error(`[fatal] failed to parse config: ${pathname}`);
    process.exit(1);
  }
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const cfg = readJson(configPath);

function parseNumericIds(raw) {
  return raw
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseList(raw) {
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  );
}

const discordChannelIds = parseNumericIds(discordChannelRaw);
const discordUserIds = parseNumericIds(discordUserRaw);
const channelIdsValid = discordChannelIds.length > 0 && discordChannelIds.every((id) => /^\d+$/.test(id));
const userIdsValid = discordUserIds.length > 0 && discordUserIds.every((id) => /^\d+$/.test(id));

if (!/^\d+$/.test(discordGuildId) || !channelIdsValid || !userIdsValid) {
  console.error(
    "[fatal] OPENCLAW_DISCORD_GUILD_ID and OPENCLAW_DISCORD_CHANNEL_IDS/OPENCLAW_DISCORD_USER_IDS must be numeric Discord IDs",
  );
  process.exit(1);
}

cfg.agents = ensureObject(cfg.agents);
cfg.agents.defaults = ensureObject(cfg.agents.defaults);
cfg.agents.defaults.model = ensureObject(cfg.agents.defaults.model);
cfg.agents.defaults.model.primary = desiredModel;

cfg.messages = ensureObject(cfg.messages);
cfg.messages.groupChat = ensureObject(cfg.messages.groupChat);
cfg.messages.groupChat.mentionPatterns = [desiredMentionPattern];

cfg.channels = ensureObject(cfg.channels);
cfg.channels.discord = ensureObject(cfg.channels.discord);
cfg.channels.discord.enabled = true;
cfg.channels.discord.groupPolicy = "allowlist";
cfg.channels.discord.allowBots = false;
cfg.channels.discord.dm = ensureObject(cfg.channels.discord.dm);
cfg.channels.discord.dm.enabled = false;
cfg.channels.discord.guilds = {
  [discordGuildId]: {
    requireMention: desiredRequireMention,
    users: discordUserIds,
    channels: Object.fromEntries(discordChannelIds.map((id) => [id, { allow: true }])),
  },
};

cfg.plugins = ensureObject(cfg.plugins);
cfg.plugins.entries = ensureObject(cfg.plugins.entries);
cfg.plugins.entries.discord = ensureObject(cfg.plugins.entries.discord);
cfg.plugins.entries.discord.enabled = true;

cfg.tools = ensureObject(cfg.tools);
cfg.tools.exec = ensureObject(cfg.tools.exec);
cfg.tools.exec.security = desiredExecSecurity;
cfg.tools.exec.ask = desiredExecAsk;
cfg.tools.exec.safeBins = parseList(desiredExecSafeBinsRaw);
cfg.tools.fs = ensureObject(cfg.tools.fs);
cfg.tools.fs.workspaceOnly = desiredFsWorkspaceOnly;
const deny = Array.isArray(cfg.tools.deny) ? cfg.tools.deny : [];
const denySet = new Set(deny.map((x) => String(x)));
denySet.delete("group:fs");
denySet.delete("group:web");
denySet.delete("browser");
denySet.delete("exec");
cfg.tools.deny = Array.from(denySet);

fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true, mode: 0o700 });
const prev = (() => {
  try {
    return fs.readFileSync(runtimeConfigPath, "utf8");
  } catch {
    return "";
  }
})();
const next = `${JSON.stringify(cfg, null, 2)}\n`;
if (prev !== next) {
  fs.writeFileSync(runtimeConfigPath, next, { mode: 0o600 });
  console.error(`[config] runtime policy enforced -> ${runtimeConfigPath}`);
} else {
  console.error(`[config] runtime policy already enforced -> ${runtimeConfigPath}`);
}
NODE

  export OPENCLAW_CONFIG_PATH="$runtime_config_path"
}

enforce_runtime_config

# Auto-approve *self* pairing in the background (TS script is bind-mounted).
# This avoids a bootstrap deadlock when the gateway requires pairing.
if [ -r /opt/openclaw/scripts/bootstrap/auto-approve-self-pairing.ts ]; then
  node --experimental-strip-types /opt/openclaw/scripts/bootstrap/auto-approve-self-pairing.ts >/dev/stderr 2>&1 || true &
fi

exec "$@"
