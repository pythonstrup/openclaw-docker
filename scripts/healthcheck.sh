#!/bin/sh
set -eu

[ -r /run/secrets/discord_bot_token ] &&
[ -s /run/secrets/discord_bot_token ] &&
[ -r /run/secrets/openclaw_gateway_token ] &&
[ -s /run/secrets/openclaw_gateway_token ] &&

node -e "const n=require('net');const s=n.connect(3010,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000);" &&

node openclaw.mjs models status --json 2>/dev/null |
node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const ok=Array.isArray(j?.auth?.missingProvidersInUse)&&j.auth.missingProvidersInUse.length===0;process.exit(ok?0:1);}catch{process.exit(1)}});" &&

node openclaw.mjs models list --json 2>/dev/null |
node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const rows=Array.isArray(j?.models)?j.models:[];const ok=rows.length>0&&rows.every(r=>r&&r.missing!==true);process.exit(ok?0:1);}catch{process.exit(1)}});"
