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

import path from "node:path";
import {
  approvePairing,
  type PairedDevice,
  type PendingRequest,
  readJsonFile,
  writeJsonAtomic,
} from "@lib/device-pairing.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PAIRING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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

  const endAt = Date.now() + PAIRING_TIMEOUT_MS;

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

    const { updatedPendingById, updatedPairedByDeviceId } = approvePairing(pendingById, pairedByDeviceId, requestId);

    writeJsonAtomic(pendingPath, updatedPendingById);
    writeJsonAtomic(pairedPath, updatedPairedByDeviceId);

    console.error(`[pairing] auto-approved self deviceId=${selfDeviceId} requestId=${requestId}`);
    return;
  }
}

main().catch((err) => {
  console.error(`[pairing] auto-approve failed: ${String(err)}`);
  process.exitCode = 1;
});
