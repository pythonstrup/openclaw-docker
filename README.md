# OpenClaw Secure Docker Setup (Discord `@Claw` + Codex)

This setup enforces:
- Discord bot token via Docker secret file only
- Gateway auth token via Docker secret file only
- `@Claw` mention required in allowed guild/channel
- user ID allowlist
- DM disabled
- non-root, read-only, dropped capabilities
- exec tool restricted to `allowlist` mode (`ask=off`, approved `safeBins`)
- local data exfiltration blocked by default policy in `config/openclaw.json`
- reuses host Codex auth via bind mount (`${HOME}/.codex/auth.json`, read-only)
- startup bootstrap copies Codex OAuth into OpenClaw `auth-profiles.json` automatically (idempotent)
- Docker healthcheck verifies gateway readiness and Codex auth availability
- startup policy enforcement pins model/Discord gating every boot (idempotent)

## 1) Prepare

1. Build/pull an OpenClaw image and tag it `openclaw:local`.
2. Create secret files (Discord token, gateway token, Discord IDs):

```bash
./scripts/init-secrets.sh
```
## 2) Validate config

```bash
./scripts/check-config.sh
```

## 3) Start

```bash
docker compose up -d
```

## 4) Codex auth bootstrap

On every container start, entrypoint script:
- reads Codex auth from `/home/node/.codex/auth.json` (mounted from `${HOME}/.codex/auth.json`)
- writes/updates `~/.openclaw/agents/main/agent/auth-profiles.json` with `openai-codex:default`
- keeps file mode strict (`600`)

So after restart, auth remains usable without re-running onboarding.

## 4.1) Runtime policy pinning

At every container start, entrypoint enforces:
- `agents.defaults.model.primary = openai-codex/gpt-5.3-codex`
- `channels.discord.groupPolicy = allowlist`
- `channels.discord.dm.enabled = false`
- guild/channel/user allowlist from Docker secrets (`OPENCLAW_DISCORD_*_FILE`)
  channel/user는 콤마 구분 다중 ID 지원
- guild `requireMention` from `OPENCLAW_REQUIRE_MENTION` (currently `true`)
- mention regex (from `OPENCLAW_MENTION_PATTERN`)

## 5) Discord command style

In the allowed channel, use mention-form messages such as:

```text
@Claw 지금 상태 점검해줘
```

The bot ignores messages without `@Claw` and blocks non-allowlisted users.

## Healthcheck

`docker compose ps` shows `healthy` only when:
- gateway port `3010` is reachable inside container
- Discord token secret can be read
- `models status --json` reports no missing providers in use

## Security notes

- Keep `secrets/` permissions strict (`700` directory, `600` files).
- Do not put secrets in `.env` or compose `environment` plain values.
- required secrets are file-only (`*_FILE`) and plain secret env vars are rejected at startup.
- `${HOME}/.codex/auth.json` is mounted read-only; keep host file permissions strict.
- Keep personal Discord IDs only in `secrets/discord_guild_id.txt`, `secrets/discord_channel_ids.txt`, `secrets/discord_user_ids.txt` (do not commit).
- Keep service bound to `127.0.0.1:3010` and access through Tailscale.
- For strict network egress allowlisting, apply host firewall controls (example below).

### Optional: Host egress allowlist

Apply outbound allowlist for this container on host:

```bash
sudo CONTAINER_NAME=openclaw-secure ./scripts/egress-allowlist.sh
```

Current script policy:
- allow ESTABLISHED/RELATED
- allow DNS (`53/tcp`, `53/udp`)
- allow HTTPS (`443/tcp`)
- drop all other outbound traffic from the container

## Files

- `docker-compose.yml`: hardened runtime + Docker secret mount
- `config/openclaw.json`: Discord/channel/user/mention policy + Codex provider
- `scripts/entrypoint-with-secrets.sh`: loads secret files into runtime env
- `scripts/init-secrets.sh`: creates `secrets/discord_bot_token.txt`, `secrets/gateway_token.txt`, `secrets/discord_guild_id.txt`, `secrets/discord_channel_ids.txt`, `secrets/discord_user_ids.txt`
- `scripts/check-config.sh`: policy drift checks
- `scripts/egress-allowlist.sh`: host-side outbound firewall allowlist for the container
