#!/usr/bin/env node
/**
 * Auto-approve *self* device pairing requests.
 *
 * Purpose:
 * - Avoid a bootstrap deadlock when the gateway rejects tool connections with
 *   "pairing required", but pairing approval itself normally goes through the
 *   gateway.
 *
 * Security model:
 * - Only approves pending requests whose `deviceId` matches our own local
 *   identity deviceId (`$OPENCLAW_STATE_DIR/identity/device.json`).
 * - Ignores all other pending requests.
 * - Never prints tokens.
 *
 * Designed to run inside the OpenClaw container at startup:
 *   node --experimental-strip-types /usr/local/bin/auto-approve-self-pairing.ts
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type PendingRequest = {
  requestId: string;
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

type DeviceToken = {
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

type PairedDevice = {
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: Record<string, DeviceToken>;
  createdAtMs: number;
  approvedAtMs: number;
};

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {}
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

function uniqSortedStrings(items: Array<unknown>): string[] {
  const set = new Set<string>();
  for (const v of items) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) set.add(t);
  }
  return Array.from(set).sort();
}

function mergeRoles(existing: PairedDevice | undefined, pending: PendingRequest): string[] | undefined {
  const merged: unknown[] = [];
  if (existing?.roles) merged.push(...existing.roles);
  if (existing?.role) merged.push(existing.role);
  if (pending.roles) merged.push(...pending.roles);
  if (pending.role) merged.push(pending.role);
  const out = uniqSortedStrings(merged);
  return out.length ? out : undefined;
}

function mergeScopes(existing: PairedDevice | undefined, pending: PendingRequest): string[] {
  const merged: unknown[] = [];
  if (existing?.scopes) merged.push(...existing.scopes);
  if (pending.scopes) merged.push(...pending.scopes);
  return uniqSortedStrings(merged);
}

function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const stateDir = (process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw").trim();
  if (!stateDir) return;

  const identityPath = path.join(stateDir, "identity", "device.json");
  const devicesDir = path.join(stateDir, "devices");
  const pendingPath = path.join(devicesDir, "pending.json");
  const pairedPath = path.join(devicesDir, "paired.json");

  const identity = readJsonFile<{ deviceId?: string } | null>(identityPath, null);
  const selfDeviceId = typeof identity?.deviceId === "string" ? identity.deviceId.trim() : "";
  if (!selfDeviceId) return;

  const endAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  while (Date.now() < endAt) {
    const pairedByDeviceId = readJsonFile<Record<string, PairedDevice>>(pairedPath, {});
    if (pairedByDeviceId[selfDeviceId]) return;

    const pendingById = readJsonFile<Record<string, PendingRequest>>(pendingPath, {});
    const requestId = Object.keys(pendingById).find(
      (id) => String(pendingById[id]?.deviceId ?? "").trim() === selfDeviceId,
    );

    if (!requestId) {
      await sleep(2000);
      continue;
    }

    const pending = pendingById[requestId];
    if (!pending || String(pending.deviceId ?? "").trim() !== selfDeviceId) {
      await sleep(2000);
      continue;
    }

    const now = Date.now();
    const existing = pairedByDeviceId[selfDeviceId];
    const roleForToken = typeof pending.role === "string" ? pending.role.trim() : "";

    const tokens: Record<string, DeviceToken> =
      existing?.tokens && typeof existing.tokens === "object" ? { ...existing.tokens } : {};

    if (roleForToken) {
      const existingToken = tokens[roleForToken];
      tokens[roleForToken] = {
        token: newToken(),
        role: roleForToken,
        scopes: uniqSortedStrings(Array.isArray(pending.scopes) ? pending.scopes : []),
        createdAtMs: existingToken?.createdAtMs ?? now,
        rotatedAtMs: existingToken ? now : undefined,
        revokedAtMs: undefined,
        lastUsedAtMs: existingToken?.lastUsedAtMs,
      };
    }

    const device: PairedDevice = {
      deviceId: selfDeviceId,
      publicKey: pending.publicKey,
      displayName: pending.displayName,
      platform: pending.platform,
      clientId: pending.clientId,
      clientMode: pending.clientMode,
      role: pending.role,
      roles: mergeRoles(existing, pending),
      scopes: mergeScopes(existing, pending),
      remoteIp: pending.remoteIp,
      tokens,
      createdAtMs: existing?.createdAtMs ?? now,
      approvedAtMs: now,
    };

    delete pendingById[requestId];
    pairedByDeviceId[selfDeviceId] = device;

    writeJsonAtomic(pendingPath, pendingById);
    writeJsonAtomic(pairedPath, pairedByDeviceId);

    console.error(`[pairing] auto-approved self deviceId=${selfDeviceId} requestId=${requestId}`);
    return;
  }
}

main().catch((err) => {
  console.error(`[pairing] auto-approve failed: ${String(err)}`);
  process.exitCode = 0;
});

