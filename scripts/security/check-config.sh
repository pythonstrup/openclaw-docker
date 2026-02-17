#!/bin/sh
set -eu

BASE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
CONFIG="$BASE_DIR/config/openclaw.json"
COMPOSE="$BASE_DIR/docker-compose.yml"

[ -f "$CONFIG" ] || { echo "missing $CONFIG" >&2; exit 1; }
[ -f "$COMPOSE" ] || { echo "missing $COMPOSE" >&2; exit 1; }

if command -v jq >/dev/null 2>&1; then
  jq empty "$CONFIG" >/dev/null
else
  echo "jq not found; skipping JSON parse check"
fi

for pattern in '"groupPolicy": "allowlist"' '"mentionPatterns"' '"dm"' '"enabled": false' '"primary": "openai-codex/gpt-5.3-codex"' '${OPENCLAW_GATEWAY_TOKEN}'; do
  if ! grep -q "$pattern" "$CONFIG"; then
    echo "missing expected setting: $pattern" >&2
    exit 1
  fi
done

for pattern in '"fs"' '"workspaceOnly": true' '"exec"' '"security": "allowlist"' '"ask": "off"' '"safeBins"'; do
  if ! grep -q "$pattern" "$CONFIG"; then
    echo "missing expected tools setting: $pattern" >&2
    exit 1
  fi
done

if grep -q '"group:fs"' "$CONFIG"; then
  echo "group:fs should not be denied when workspaceOnly is enabled" >&2
  exit 1
fi

if grep -q '"group:web"' "$CONFIG"; then
  echo "group:web should be allowed" >&2
  exit 1
fi

if grep -q '"browser"' "$CONFIG"; then
  echo "browser should be allowed" >&2
  exit 1
fi

if grep -q '"exec"' "$CONFIG" && grep -q '"deny"' "$CONFIG"; then
  if grep -q '"deny":[[:space:]]*\\[[^]]*"exec"' "$CONFIG"; then
    echo "exec should be allowed (not denied)" >&2
    exit 1
  fi
fi

if ! grep -q 'DISCORD_BOT_TOKEN_FILE' "$COMPOSE"; then
  echo "compose must use DISCORD_BOT_TOKEN_FILE" >&2
  exit 1
fi

for var in OPENCLAW_DISCORD_GUILD_ID_FILE OPENCLAW_DISCORD_CHANNEL_IDS_FILE OPENCLAW_DISCORD_USER_IDS_FILE; do
  if ! grep -q "$var" "$COMPOSE"; then
    echo "compose must pass $var" >&2
    exit 1
  fi
done

if ! grep -q 'OPENCLAW_REQUIRE_MENTION: "true"' "$COMPOSE"; then
  echo 'compose must enforce OPENCLAW_REQUIRE_MENTION: "true"' >&2
  exit 1
fi

if ! grep -q 'OPENCLAW_EXEC_ASK: "off"' "$COMPOSE"; then
  echo 'compose must enforce OPENCLAW_EXEC_ASK: "off"' >&2
  exit 1
fi

if ! grep -q 'OPENCLAW_EXEC_SAFE_BINS: ls,cat,rg,sed,awk,head,tail,wc,git' "$COMPOSE"; then
  echo 'compose must keep OPENCLAW_EXEC_SAFE_BINS in approved allowlist' >&2
  exit 1
fi

if ! grep -q 'OPENCLAW_GATEWAY_TOKEN_FILE' "$COMPOSE"; then
  echo "compose must use OPENCLAW_GATEWAY_TOKEN_FILE" >&2
  exit 1
fi

if ! grep -q '\${HOME}/.codex/auth.json' "$COMPOSE"; then
  echo "compose must mount \${HOME}/.codex/auth.json (read-only)" >&2
  exit 1
fi

if grep -Eq 'source:[[:space:]]*/home/[^/]+/\.codex/auth\.json|-[[:space:]]*/home/[^/]+/\.codex/auth\.json:' "$COMPOSE"; then
  echo "compose should not hardcode a user home path for .codex/auth.json; use \${HOME}" >&2
  exit 1
fi

if ! grep -q 'entrypoint-with-secrets.sh' "$COMPOSE"; then
  echo "compose must use entrypoint-with-secrets.sh bootstrap" >&2
  exit 1
fi

if ! grep -q 'healthcheck:' "$COMPOSE"; then
  echo "compose must define healthcheck" >&2
  exit 1
fi

if ! grep -q 'healthcheck.sh' "$COMPOSE"; then
  echo "compose must use healthcheck.sh script" >&2
  exit 1
fi

if grep -q 'DISCORD_BOT_TOKEN:' "$COMPOSE"; then
  echo "plain DISCORD_BOT_TOKEN env detected in compose" >&2
  exit 1
fi

if grep -q 'OPENCLAW_GATEWAY_TOKEN:' "$COMPOSE"; then
  echo "plain OPENCLAW_GATEWAY_TOKEN env detected in compose" >&2
  exit 1
fi

if grep -q 'export DISCORD_BOT_TOKEN=' "$COMPOSE" || grep -q 'export OPENCLAW_GATEWAY_TOKEN=' "$COMPOSE"; then
  echo "healthcheck must not export secrets into environment; check secret files with [ -r ] instead" >&2
  exit 1
fi

echo "config checks passed"
