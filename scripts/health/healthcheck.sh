#!/bin/sh
set -eu

# Docker healthchecks may run with an unexpected working directory. OpenClaw's
# entrypoint and assets live under /app in the image.
if [ -d /app ]; then
  cd /app
fi

log_fail() {
  # Persist last failure for debugging (docker inspect output is not always available).
  ts="$(date -Iseconds 2>/dev/null || date)"
  mkdir -p /tmp/openclaw 2>/dev/null || true
  printf '%s %s\n' "$ts" "$1" > /tmp/openclaw/healthcheck.last 2>/dev/null || true
  exit 1
}

[ -r /run/secrets/discord_bot_token ] || log_fail "missing /run/secrets/discord_bot_token"
[ -s /run/secrets/discord_bot_token ] || log_fail "empty /run/secrets/discord_bot_token"
[ -r /run/secrets/openclaw_gateway_token ] || log_fail "missing /run/secrets/openclaw_gateway_token"
[ -s /run/secrets/openclaw_gateway_token ] || log_fail "empty /run/secrets/openclaw_gateway_token"

node -e "const n=require('net');const s=n.connect(3010,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000);" \
  || log_fail "gateway port 3010 not reachable"

status_json="$(
  DISCORD_BOT_TOKEN="$(tr -d '\r' < /run/secrets/discord_bot_token)" \
  OPENCLAW_GATEWAY_TOKEN="$(tr -d '\r' < /run/secrets/openclaw_gateway_token)" \
  node openclaw.mjs models status --json 2>/dev/null || true
)"
J="$status_json" node -e "const d=process.env.J||'';try{const j=JSON.parse(d);const ok=Array.isArray(j?.auth?.missingProvidersInUse)&&j.auth.missingProvidersInUse.length===0;process.exit(ok?0:1);}catch{process.exit(1)}" \
  || log_fail "models status failed or missingProvidersInUse non-empty"

list_json="$(
  DISCORD_BOT_TOKEN="$(tr -d '\r' < /run/secrets/discord_bot_token)" \
  OPENCLAW_GATEWAY_TOKEN="$(tr -d '\r' < /run/secrets/openclaw_gateway_token)" \
  node openclaw.mjs models list --json 2>/dev/null || true
)"
J="$list_json" node -e "const d=process.env.J||'';try{const j=JSON.parse(d);const rows=Array.isArray(j?.models)?j.models:[];const ok=rows.length>0&&rows.every(r=>r&&r.missing!==true);process.exit(ok?0:1);}catch{process.exit(1)}" \
  || log_fail "models list failed or has missing models"
