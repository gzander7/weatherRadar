/// <reference lib="webworker" />

import type { LiveRadarFrameManifest, LiveRadarRadial, LiveRadarRadialBatch } from "../lib/types";

interface SweepState {
  frame: LiveRadarFrameManifest;
  radialsByIndex: Map<number, LiveRadarRadial>;
  gateCount: number;
}

interface RollingFieldState {
  frame: LiveRadarFrameManifest;
  currentSweepKey: string;
  currentRadialsByIndex: Map<number, LiveRadarRadial>;
  previousRadialsByIndex: Map<number, LiveRadarRadial>;
  gateCount: number;
}

type WorkerRequest =
  | { type: "bootstrap"; payload: LiveRadarRadialBatch }
  | { type: "radials"; payload: LiveRadarRadialBatch };

type WorkerResponse =
  | { type: "bootstrap-field"; payload: LiveRadarRadialBatch }
  | { type: "live-update"; payload: LiveRadarRadialBatch };

const sweepStates = new Map<string, SweepState>();
const rollingFields = new Map<string, RollingFieldState>();
const latestFieldKeyBySource = new Map<string, string>();

function sweepKey(frame: Pick<LiveRadarFrameManifest, "site" | "volumeId" | "tiltIndex" | "product">) {
  return [frame.site, frame.volumeId ?? "live", frame.tiltIndex, frame.product].join(":");
}

function rollingFieldKey(
  frame: Pick<LiveRadarFrameManifest, "sourceId" | "site" | "tiltIndex" | "product">
) {
  return [frame.sourceId, frame.site, frame.tiltIndex, frame.product].join(":");
}

function sortRadials(radials: LiveRadarRadial[]) {
  return radials.slice().sort((left, right) => left.radialIndex - right.radialIndex);
}

function normalizeAngleDegrees(angle: number) {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function positiveAngleDelta(start: number, end: number) {
  const normalizedStart = normalizeAngleDegrees(start);
  const normalizedEnd = normalizeAngleDegrees(end);
  const delta = normalizedEnd - normalizedStart;

  if (delta >= 0) {
    return delta;
  }

  return normalizedEnd + 360 - normalizedStart;
}

function angularMidpointDegrees(start: number, end: number) {
  return normalizeAngleDegrees(start + positiveAngleDelta(start, end) / 2);
}

function frameSweepId(frame: Pick<LiveRadarFrameManifest, "id" | "volumeId" | "tiltIndex">) {
  return `${frame.volumeId ?? frame.id}:tilt-${frame.tiltIndex}`;
}

function frameReceivedAtMs(frame: Pick<LiveRadarFrameManifest, "publishTime" | "ingestTime" | "scanTime">) {
  const parsed =
    Date.parse(frame.publishTime) ||
    Date.parse(frame.ingestTime) ||
    Date.parse(frame.scanTime);

  return Number.isFinite(parsed) ? parsed : Date.now();
}

function resolveAssignedSlot(
  frame: Pick<LiveRadarFrameManifest, "radialCount">,
  radial: LiveRadarRadial
) {
  const radialCount = Math.max(1, frame.radialCount ?? 720);
  const azimuthCenter = angularMidpointDegrees(radial.azimuthStart, radial.azimuthEnd);

  if (Number.isFinite(azimuthCenter)) {
    return Math.round((azimuthCenter / 360) * radialCount) % radialCount;
  }

  if (typeof radial.assignedSlotIndex === "number" && Number.isFinite(radial.assignedSlotIndex)) {
    return radial.assignedSlotIndex;
  }

  return radial.radialIndex;
}

function normalizeRadialBatch(batch: LiveRadarRadialBatch) {
  const sweepId = frameSweepId(batch.frame);
  const receivedAtMs = frameReceivedAtMs(batch.frame);

  return {
    frame: batch.frame,
    radials: batch.radials.map((radial) => {
      const assignedSlotIndex = resolveAssignedSlot(batch.frame, radial);

      return {
        ...radial,
        sourceRadialIndex: radial.sourceRadialIndex ?? radial.radialIndex ?? assignedSlotIndex,
        assignedSlotIndex,
        radialIndex: assignedSlotIndex,
        sweepId: radial.sweepId ?? sweepId,
        receivedAtMs: radial.receivedAtMs ?? receivedAtMs
      };
    })
  } satisfies LiveRadarRadialBatch;
}

function radialSignature(radial: LiveRadarRadial) {
  let checksum = 0;

  for (const gate of radial.gates) {
    checksum =
      (checksum * 33 +
        Math.round(gate.intensity * 1000) +
        Math.round((gate.reflectivityDbz ?? 0) * 10) +
        Math.round(gate.rangeStartKm * 10) +
        Math.round(gate.rangeEndKm * 10)) %
      2147483647;
  }

  return [
    radial.azimuthStart.toFixed(3),
    radial.azimuthEnd.toFixed(3),
    radial.gates.length,
    checksum
  ].join(":");
}

function copyFrameWithCounts(
  frame: LiveRadarFrameManifest,
  radialCount: number,
  gateCount: number
): LiveRadarFrameManifest {
  return {
    ...frame,
    radialCount: frame.radialCount ?? radialCount,
    gateCount
  };
}

function createSweepState(batch: LiveRadarRadialBatch): SweepState {
  return {
    frame: batch.frame,
    radialsByIndex: new Map(),
    gateCount: 0
  };
}

function createRollingFieldState(batch: LiveRadarRadialBatch): RollingFieldState {
  return {
    frame: batch.frame,
    currentSweepKey: frameSweepId(batch.frame),
    currentRadialsByIndex: new Map(),
    previousRadialsByIndex: new Map(),
    gateCount: 0
  };
}

function applyRadials(
  state: { radialsByIndex: Map<number, LiveRadarRadial>; gateCount: number },
  radials: LiveRadarRadial[]
) {
  const changedRadials: LiveRadarRadial[] = [];

  for (const radial of sortRadials(radials)) {
    const previousRadial = state.radialsByIndex.get(radial.radialIndex);

    if (previousRadial && radialSignature(previousRadial) === radialSignature(radial)) {
      continue;
    }

    if (previousRadial) {
      state.gateCount -= previousRadial.gates.length;
    }

    state.radialsByIndex.set(radial.radialIndex, radial);
    state.gateCount += radial.gates.length;
    changedRadials.push(radial);
  }

  return changedRadials;
}

function copyRadialForDisplay(
  frame: LiveRadarFrameManifest,
  radial: LiveRadarRadial,
  isCurrentSweep: boolean
): LiveRadarRadial {
  return {
    ...radial,
    sweepId: radial.sweepId ?? frameSweepId(frame),
    receivedAtMs: radial.receivedAtMs ?? frameReceivedAtMs(frame),
    isCurrentSweep,
    displayOpacity: isCurrentSweep ? 1 : 0.38
  };
}

function composeRollingRadials(state: RollingFieldState) {
  const composed = new Map<number, LiveRadarRadial>();

  for (const radial of state.previousRadialsByIndex.values()) {
    composed.set(radial.radialIndex, copyRadialForDisplay(state.frame, radial, false));
  }

  for (const radial of state.currentRadialsByIndex.values()) {
    composed.set(radial.radialIndex, copyRadialForDisplay(state.frame, radial, true));
  }

  return composed;
}

function refreshRollingGateCount(state: RollingFieldState) {
  state.gateCount = 0;

  for (const radial of composeRollingRadials(state).values()) {
    state.gateCount += radial.gates.length;
  }
}

function buildBatch(
  frame: LiveRadarFrameManifest,
  radials: Iterable<LiveRadarRadial>,
  totalRadialCount?: number,
  totalGateCount?: number
) {
  const orderedRadials = sortRadials([...radials]);
  return {
    frame: copyFrameWithCounts(
      frame,
      totalRadialCount ?? orderedRadials.length,
      totalGateCount ??
        orderedRadials.reduce((count, radial) => count + radial.gates.length, 0)
    ),
    radials: orderedRadials
  };
}

function handleBatch(batch: LiveRadarRadialBatch, mode: "bootstrap" | "radials") {
  const normalizedBatch = normalizeRadialBatch(batch);
  const sweepCacheKey = sweepKey(normalizedBatch.frame);
  let sweepState = sweepStates.get(sweepCacheKey);

  if (!sweepState || mode === "bootstrap") {
    sweepState = createSweepState(normalizedBatch);
    sweepStates.set(sweepCacheKey, sweepState);
  }

  sweepState.frame = normalizedBatch.frame;
  applyRadials(sweepState, normalizedBatch.radials);

  const rollingKey = rollingFieldKey(normalizedBatch.frame);
  let rollingField = rollingFields.get(rollingKey);

  if (!rollingField) {
    rollingField = createRollingFieldState(normalizedBatch);
    rollingFields.set(rollingKey, rollingField);
  }

  const incomingSweepKey = frameSweepId(normalizedBatch.frame);
  const startedNewSweep = rollingField.currentSweepKey !== incomingSweepKey;

  if (mode === "bootstrap") {
    rollingField.currentSweepKey = incomingSweepKey;
    rollingField.currentRadialsByIndex = new Map();
    rollingField.previousRadialsByIndex = new Map();
  } else if (startedNewSweep) {
    rollingField.previousRadialsByIndex = rollingField.currentRadialsByIndex;
    rollingField.currentRadialsByIndex = new Map();
    rollingField.currentSweepKey = incomingSweepKey;
  }

  rollingField.frame = normalizedBatch.frame;
  const changedRadials = applyRadials(
    {
      radialsByIndex: rollingField.currentRadialsByIndex,
      gateCount: 0
    },
    normalizedBatch.radials
  );
  const composedRadials = composeRollingRadials(rollingField);
  refreshRollingGateCount(rollingField);
  latestFieldKeyBySource.set(normalizedBatch.frame.sourceId, rollingKey);

  if (mode === "bootstrap") {
    return {
      type: "bootstrap-field",
      payload: buildBatch(
        rollingField.frame,
        composedRadials.values(),
        composedRadials.size,
        rollingField.gateCount
      )
    } satisfies WorkerResponse;
  }

  if (changedRadials.length === 0 && !startedNewSweep) {
    return null;
  }

  const responseRadials = startedNewSweep
    ? composedRadials.values()
    : changedRadials.map((radial) => copyRadialForDisplay(rollingField.frame, radial, true));

  return {
    type: "live-update",
    payload: buildBatch(
      rollingField.frame,
      responseRadials,
      composedRadials.size,
      rollingField.gateCount
    )
  } satisfies WorkerResponse;
}

const context = self as DedicatedWorkerGlobalScope;

context.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const response = handleBatch(message.payload, message.type);

  if (response) {
    context.postMessage(response);
  }
};

export {};
