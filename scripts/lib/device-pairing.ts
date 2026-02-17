/**
 * Shared types and utilities for OpenClaw device pairing approval.
 *
 * Used by:
 * - scripts/approve-device-pairing-local.ts  (manual CLI)
 * - scripts/bootstrap/auto-approve-self-pairing.ts  (container startup)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingRequest = {
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

export type DeviceToken = {
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type PairedDevice = {
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

export type ApprovalResult = {
  deviceId: string;
  updatedPendingById: Record<string, PendingRequest>;
  updatedPairedByDeviceId: Record<string, PairedDevice>;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[a-zA-Z0-9_\-:.]+$/;

export function isValidId(value: string): boolean {
  return SAFE_ID_RE.test(value);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode = 0o600,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch (err) {
    console.error(`[warn] chmod failed on tmp file: ${err}`);
  }
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch (err) {
    console.error(`[warn] chmod failed on ${filePath}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function uniqSortedStrings(items: Array<unknown>): string[] {
  const set = new Set<string>();
  for (const v of items) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) set.add(t);
  }
  return Array.from(set).sort();
}

export function mergeRoles(
  existing: PairedDevice | undefined,
  pending: PendingRequest,
): string[] | undefined {
  const merged: unknown[] = [];
  if (existing?.roles) merged.push(...existing.roles);
  if (existing?.role) merged.push(existing.role);
  if (pending.roles) merged.push(...pending.roles);
  if (pending.role) merged.push(pending.role);
  const out = uniqSortedStrings(merged);
  return out.length ? out : undefined;
}

export function mergeScopes(
  existing: PairedDevice | undefined,
  pending: PendingRequest,
): string[] {
  const merged: unknown[] = [];
  if (existing?.scopes) merged.push(...existing.scopes);
  if (pending.scopes) merged.push(...pending.scopes);
  return uniqSortedStrings(merged);
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Core approval logic (immutable)
// ---------------------------------------------------------------------------

/**
 * Build an approved PairedDevice and return new collections with the pending
 * request removed and the paired device added. Never mutates the inputs.
 *
 * Throws if requestId is missing or deviceId is empty.
 */
export function approvePairing(
  pendingById: Record<string, PendingRequest>,
  pairedByDeviceId: Record<string, PairedDevice>,
  requestId: string,
): ApprovalResult {
  const pending = pendingById[requestId];
  if (!pending) {
    throw new Error(`requestId not found in pending: ${requestId}`);
  }

  const deviceId = String(pending.deviceId ?? "").trim();
  if (!deviceId) {
    throw new Error(
      `pending request missing deviceId (requestId=${requestId})`,
    );
  }
  if (!isValidId(deviceId)) {
    throw new Error(`invalid deviceId format (requestId=${requestId})`);
  }

  const now = Date.now();
  const existing = pairedByDeviceId[deviceId];
  const roleForToken =
    typeof pending.role === "string" ? pending.role.trim() : "";

  if (roleForToken && !isValidId(roleForToken)) {
    throw new Error(`invalid role format (requestId=${requestId})`);
  }

  const existingTokens: Record<string, DeviceToken> =
    existing?.tokens && typeof existing.tokens === "object"
      ? { ...existing.tokens }
      : {};

  const tokens: Record<string, DeviceToken> = roleForToken
    ? {
        ...existingTokens,
        [roleForToken]: {
          token: newToken(),
          role: roleForToken,
          scopes: uniqSortedStrings(
            Array.isArray(pending.scopes) ? pending.scopes : [],
          ),
          createdAtMs: existingTokens[roleForToken]?.createdAtMs ?? now,
          rotatedAtMs: existingTokens[roleForToken] ? now : undefined,
          revokedAtMs: undefined,
          lastUsedAtMs: existingTokens[roleForToken]?.lastUsedAtMs,
        },
      }
    : existingTokens;

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

  const { [requestId]: _removed, ...updatedPendingById } = pendingById;
  const updatedPairedByDeviceId = { ...pairedByDeviceId, [deviceId]: device };

  return { deviceId, updatedPendingById, updatedPairedByDeviceId };
}
