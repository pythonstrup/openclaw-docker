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

import path from "node:path";
import {
  approvePairing,
  type PairedDevice,
  type PendingRequest,
  readJsonFile,
  writeJsonAtomic,
} from "@lib/device-pairing.ts";

function repoRootFrom(importMetaUrl: string): string {
  const scriptDir = path.dirname(new URL(importMetaUrl).pathname);
  return path.resolve(scriptDir, "..");
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
  Object.keys(pendingById).sort((a, b) => Number(pendingById[b]?.ts ?? 0) - Number(pendingById[a]?.ts ?? 0))[0];

if (!requestId) {
  console.error(`[fatal] no pending pairing requests found at ${pendingPath}`);
  process.exit(1);
}

if (!pendingById[requestId]) {
  console.error(`[fatal] requestId not found in pending.json: ${requestId}`);
  process.exit(1);
}

const { deviceId, updatedPendingById, updatedPairedByDeviceId } = approvePairing(
  pendingById,
  pairedByDeviceId,
  requestId,
);

writeJsonAtomic(pendingPath, updatedPendingById);
writeJsonAtomic(pairedPath, updatedPairedByDeviceId);

console.error(`[ok] approved device pairing requestId=${requestId} deviceId=${deviceId}`);
