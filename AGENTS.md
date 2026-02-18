# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

openclaw-docker is a security-hardened Docker Compose deployment for OpenClaw (AI bot framework) with Discord integration and OpenAI Codex provider. It enforces file-based secrets, non-root containers, read-only filesystems, and runtime policy pinning on every startup.

## Development Commands

### Lint & Format (TypeScript scripts only)
```bash
bunx biome check scripts/          # check formatting + linting
bunx biome check scripts/ --write  # auto-fix
bunx biome format scripts/ --write # format only
bunx biome lint scripts/           # lint only
```

### Type Check
```bash
bun tsc --noEmit
```

### Validate Security Policy
```bash
./scripts/security/check-config.sh
```

### Shell Script Syntax Check
```bash
sh -n scripts/bootstrap/entrypoint-with-secrets.sh
sh -n scripts/health/healthcheck.sh
```

### Run TypeScript Scripts (no build step)
```bash
node --experimental-strip-types scripts/approve-device-pairing-local.ts
```

### Docker Operations
```bash
docker compose up -d                     # start
docker compose ps                        # check health
docker compose logs -f openclaw-secure   # stream logs
docker compose down                      # stop
```

### First-Time Setup
```bash
./scripts/setup/init-secrets.sh          # create secret files interactively
./scripts/security/check-config.sh       # validate before launch
docker compose up -d
```

## Architecture

### Bootstrap Sequence (container startup)
`entrypoint-with-secrets.sh` orchestrates all initialization:
1. Loads 5 required secrets from `/run/secrets/*` (file-based only, rejects plain env vars)
2. Spawns `watch-codex-auth.ts` daemon — polls host `~/.codex/auth.json` every 5s, syncs OAuth tokens to container's `auth-profiles.json` atomically
3. Generates runtime config at `/tmp/openclaw/openclaw.runtime.json` — overlays policy enforcement (model pinning, Discord allowlists, exec tool restrictions) onto template config
4. Spawns `auto-approve-self-pairing.ts` daemon — prevents bootstrap deadlock by approving container's own device pairing requests
5. Execs `node openclaw.mjs gateway --allow-unconfigured`

### Key Directories
- `config/` — Base config template (never contains secrets)
- `scripts/bootstrap/` — Entrypoint and background daemons
- `scripts/health/` — Docker healthcheck
- `scripts/security/` — Policy validation, egress firewall
- `scripts/setup/` — Interactive secret initialization
- `scripts/lib/` — Shared TypeScript modules
- `secrets/` — Git-ignored, file-based Docker secrets (mode 600)
- `workspace/` — Git-ignored, container read-write state

### Shared Module: `scripts/lib/device-pairing.ts`
Centralized device pairing logic used by both `approve-device-pairing-local.ts` (manual CLI) and `auto-approve-self-pairing.ts` (auto daemon). Exports pure functions with immutable update semantics — never mutates input objects.

### Healthcheck (`scripts/health/healthcheck.sh`)
Multi-layer check: secret file readability → gateway TCP reachability on :3010 → `models status` auth verification → `models list` availability. Failure details logged to `/tmp/openclaw/healthcheck.last`.

## Conventions

### Security
- Secrets are **file-based only** via Docker Secrets — the entrypoint rejects plain env vars for sensitive values
- All file writes use atomic temp+rename pattern with strict permissions (mode 0o600)
- Discord IDs validated as numeric before processing
- Container runs as UID 1000:1000 with read-only root FS, all capabilities dropped

### Code Style
- TypeScript with strict mode, ESNext target, bundler module resolution
- Biome: 2-space indent, 120 char width, double quotes, semicolons always, trailing commas
- Path aliases in tsconfig (`@/*` → `scripts/*`, `@lib/*` → `scripts/lib/*`) but scripts use relative imports because `node --experimental-strip-types` doesn't resolve aliases
- Immutable data patterns throughout — spread operators and destructuring for updates, never in-place mutation

### Tooling
- Runtime: Bun 1.3.9 (dev tooling), Node.js 22.17.1 (container runtime)
- No build step — TypeScript scripts run directly via `node --experimental-strip-types`
- No test framework configured yet
