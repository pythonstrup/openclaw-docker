#!/usr/bin/env node
/**
 * Emergency local device pairing approval (TypeScript).
 *
 * This breaks the bootstrap deadlock where the gateway requires a paired device,
 * but the device approval command itself needs a working gateway connection.
 *
 * It edits OpenClaw state files directly:
 * - ./workspace/devices/pending.json
 * - ./workspace/devices/paired.json
 *
 * Usage:
 *   node --experimental-strip-types scripts/approve-device-pairing-local.ts
 *   node --experimental-strip-types scripts/approve-device-pairing-local.ts <requestId>
 *
 * If you don't have Node 22+:
 * - Install Node 22+ (recommended), or
 * - Add a small wrapper in your own environment that runs node with
 *   `--experimental-strip-types` (not included here by request).
 *
 * Notes:
 * - Does not print tokens.
 * - Generates a fresh base64url token (32 bytes), matching OpenClaw's behavior.
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

function repoRootFrom(importMetaUrl: string): string {
  // file URL path is already absolute in Node on linux.
  const scriptDir = path.dirname(new URL(importMetaUrl).pathname);
  return path.resolve(scriptDir, "..");
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
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

const repoRoot = repoRootFrom(import.meta.url);
const devicesDir = path.join(repoRoot, "workspace", "devices");
const pendingPath = path.join(devicesDir, "pending.json");
const pairedPath = path.join(devicesDir, "paired.json");

const requestIdArg = process.argv[2]?.trim();

const pendingById = readJsonFile<Record<string, PendingRequest>>(pendingPath, {});
const pairedByDeviceId = readJsonFile<Record<string, PairedDevice>>(pairedPath, {});

const requestId =
  requestIdArg ||
  Object.keys(pendingById)
    .sort((a, b) => Number(pendingById[b]?.ts ?? 0) - Number(pendingById[a]?.ts ?? 0))[0];

if (!requestId) {
  console.error(`[fatal] no pending pairing requests found at ${pendingPath}`);
  process.exit(1);
}

const pending = pendingById[requestId];
if (!pending) {
  console.error(`[fatal] requestId not found in pending.json: ${requestId}`);
  process.exit(1);
}

const deviceId = String(pending.deviceId ?? "").trim();
if (!deviceId) {
  console.error(`[fatal] pending request missing deviceId (requestId=${requestId})`);
  process.exit(1);
}

const now = Date.now();
const existing = pairedByDeviceId[deviceId];
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
  deviceId,
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
pairedByDeviceId[deviceId] = device;

writeJsonAtomic(pendingPath, pendingById);
writeJsonAtomic(pairedPath, pairedByDeviceId);

console.error(`[ok] approved device pairing requestId=${requestId} deviceId=${deviceId}`);
