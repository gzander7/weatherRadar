const productAliases = new Map([
  ["REF", "REF"],
  ["REFLECTIVITY", "REF"],
  ["BASE_REFLECTIVITY", "REF"]
]);

export function normalizeRadarStationId(stationId) {
  return String(stationId ?? "").trim().toUpperCase();
}

export function normalizeRadarProduct(product = "REF") {
  const normalized = String(product ?? "REF").trim().toUpperCase();
  return productAliases.get(normalized) ?? normalized;
}

export function normalizeRadarTilt(tilt = 0.5) {
  const numericTilt = Number(tilt);
  return Number.isFinite(numericTilt) ? Number(numericTilt.toFixed(2)) : 0.5;
}

export function createRadarStateCacheKey(stationId, product = "REF", tilt = 0.5) {
  return [
    normalizeRadarStationId(stationId),
    normalizeRadarProduct(product),
    normalizeRadarTilt(tilt)
  ].join(":");
}

function frameSweepId(frame) {
  return `${frame.volumeId ?? frame.id}:tilt-${frame.tiltIndex}`;
}

function sortRadials(radials) {
  return [...radials].sort((left, right) => left.radialIndex - right.radialIndex);
}

function cloneRadial(radial) {
  return {
    ...radial,
    gates: radial.gates.map((gate) => ({ ...gate }))
  };
}

function cloneFrame(frame) {
  return { ...frame };
}

function createSweepBuffer(frame) {
  return {
    sweepId: frameSweepId(frame),
    frame: cloneFrame(frame),
    radialsByIndex: new Map(),
    radialCount: frame.radialCount ?? 720,
    gateCount: 0
  };
}

function applyRadialsToSweepBuffer(sweepBuffer, radials) {
  for (const radial of sortRadials(radials)) {
    const previous = sweepBuffer.radialsByIndex.get(radial.radialIndex);

    if (previous) {
      sweepBuffer.gateCount -= previous.gates.length;
    }

    const nextRadial = cloneRadial(radial);
    sweepBuffer.radialsByIndex.set(nextRadial.radialIndex, nextRadial);
    sweepBuffer.gateCount += nextRadial.gates.length;
  }

  sweepBuffer.radialCount = Math.max(
    sweepBuffer.radialCount,
    ...radials.map((radial) => radial.radialIndex + 1)
  );
}

function serializeSweepBuffer(sweepBuffer, sequence) {
  if (!sweepBuffer) {
    return undefined;
  }

  return {
    sweepId: sweepBuffer.sweepId,
    frame: {
      ...cloneFrame(sweepBuffer.frame),
      sequence,
      gateCount: sweepBuffer.gateCount,
      radialCount: sweepBuffer.radialCount
    },
    radials: sortRadials(sweepBuffer.radialsByIndex.values()).map(cloneRadial),
    radialCount: sweepBuffer.radialCount,
    gateCount: sweepBuffer.gateCount
  };
}

function composeVisibleRadials(currentSweep, previousSweep) {
  const composed = new Map();

  if (previousSweep) {
    for (const radial of previousSweep.radialsByIndex.values()) {
      composed.set(radial.radialIndex, {
        ...cloneRadial(radial),
        isCurrentSweep: false,
        displayOpacity: 0.38
      });
    }
  }

  for (const radial of currentSweep.radialsByIndex.values()) {
    composed.set(radial.radialIndex, {
      ...cloneRadial(radial),
      isCurrentSweep: true,
      displayOpacity: 1
    });
  }

  return sortRadials(composed.values());
}

function oldestTime(...timestamps) {
  const parsed = timestamps
    .filter(Boolean)
    .map((timestamp) => ({ timestamp, value: Date.parse(timestamp) }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) => left.value - right.value);

  return parsed[0]?.timestamp;
}

export class RadarStateCache {
  constructor() {
    this.states = new Map();
    this.sequences = new Map();
  }

  getKey({ stationId, product = "REF", tilt = 0.5 }) {
    return createRadarStateCacheKey(stationId, product, tilt);
  }

  getSequence(stationId, product = "REF", tilt = 0.5) {
    return this.sequences.get(createRadarStateCacheKey(stationId, product, tilt)) ?? 0;
  }

  updateFromPatch({ stationId, product = "REF", tilt = 0.5, frame, radials }) {
    const key = createRadarStateCacheKey(stationId, product, tilt);
    const previousSequence = this.sequences.get(key) ?? 0;
    const sequence = previousSequence + 1;
    this.sequences.set(key, sequence);

    let state = this.states.get(key);
    const incomingSweepId = frameSweepId(frame);

    if (!state) {
      state = {
        stationId: normalizeRadarStationId(stationId),
        product: normalizeRadarProduct(product),
        tilt: normalizeRadarTilt(tilt),
        sequence,
        currentSweep: createSweepBuffer(frame),
        previousSweep: undefined,
        newestRadarTime: frame.scanTime,
        oldestVisibleRadarTime: frame.scanTime,
        updatedAt: new Date().toISOString()
      };
      this.states.set(key, state);
    } else if (state.currentSweep.sweepId !== incomingSweepId) {
      state.previousSweep = state.currentSweep;
      state.currentSweep = createSweepBuffer(frame);
    }

    applyRadialsToSweepBuffer(state.currentSweep, radials);
    state.currentSweep.frame = {
      ...cloneFrame(frame),
      sequence,
      radialCount: state.currentSweep.radialCount,
      gateCount: state.currentSweep.gateCount
    };
    state.sequence = sequence;
    state.newestRadarTime = frame.scanTime ?? state.newestRadarTime;
    state.oldestVisibleRadarTime = oldestTime(
      state.currentSweep.frame.scanTime,
      state.previousSweep?.frame.scanTime
    );
    state.updatedAt = new Date().toISOString();

    const patch = {
      type: "radial_batch",
      stationId: state.stationId,
      product: state.product,
      tilt: state.tilt,
      sequence,
      frame: {
        ...cloneFrame(frame),
        product: state.product,
        sequence
      },
      radials: sortRadials(radials).map(cloneRadial)
    };

    return {
      state: this.getSnapshot(stationId, product, tilt),
      patch
    };
  }

  getSnapshot(stationId, product = "REF", tilt = 0.5) {
    const key = createRadarStateCacheKey(stationId, product, tilt);
    const state = this.states.get(key);

    if (!state) {
      return null;
    }

    const currentSweep = serializeSweepBuffer(state.currentSweep, state.sequence);
    const previousSweep = serializeSweepBuffer(state.previousSweep, state.sequence);
    const visibleRadials = composeVisibleRadials(state.currentSweep, state.previousSweep);
    const gateCount = visibleRadials.reduce((count, radial) => count + radial.gates.length, 0);

    return {
      stationId: state.stationId,
      product: state.product,
      tilt: state.tilt,
      sequence: state.sequence,
      newestRadarTime: state.newestRadarTime,
      oldestVisibleRadarTime: state.oldestVisibleRadarTime,
      updatedAt: state.updatedAt,
      currentSweep,
      previousSweep,
      frame: {
        ...currentSweep.frame,
        product: state.product,
        sequence: state.sequence,
        gateCount,
        radialCount: visibleRadials.length
      },
      radials: visibleRadials
    };
  }
}
