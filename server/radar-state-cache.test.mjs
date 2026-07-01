import assert from "node:assert/strict";
import test from "node:test";
import {
  RadarStateCache,
  createRadarStateCacheKey
} from "./radar-state-cache.mjs";

function frame(overrides = {}) {
  return {
    id: "volume-a:0:1",
    sourceId: "keax-ref",
    site: "KEAX",
    volumeId: "volume-a",
    tiltIndex: 0,
    radialIndex: 0,
    chunkSequence: 1,
    isTiltComplete: false,
    isVolumeComplete: false,
    radialCount: 720,
    gateCount: 1,
    product: "REF",
    elevation: 0.5,
    scanTime: "2026-06-24T20:00:00.000Z",
    ingestTime: "2026-06-24T20:00:01.000Z",
    publishTime: "2026-06-24T20:00:02.000Z",
    completionRatio: 0.1,
    ingestLane: "chunks",
    renderHint: "canvas-bins",
    ...overrides
  };
}

function radial(radialIndex, intensity = 0.7) {
  return {
    tiltIndex: 0,
    radialIndex,
    sourceRadialIndex: radialIndex,
    assignedSlotIndex: radialIndex,
    azimuthStart: radialIndex * 0.5,
    azimuthEnd: radialIndex * 0.5 + 0.5,
    gates: [
      {
        azimuthStart: radialIndex * 0.5,
        azimuthEnd: radialIndex * 0.5 + 0.5,
        rangeStartKm: 10,
        rangeEndKm: 11,
        intensity,
        reflectivityDbz: 42
      }
    ]
  };
}

function replayBuffered(snapshotSequence, patches) {
  return patches
    .filter((patch) => patch.sequence > snapshotSequence)
    .sort((left, right) => left.sequence - right.sequence);
}

test("radar state cache keys normalize station, product, and tilt", () => {
  assert.equal(createRadarStateCacheKey("keax", "reflectivity", "0.50"), "KEAX:REF:0.5");
});

test("radar state cache sequences increase monotonically per station product tilt", () => {
  const cache = new RadarStateCache();
  const first = cache.updateFromPatch({
    stationId: "KEAX",
    product: "REF",
    tilt: 0.5,
    frame: frame({ chunkSequence: 1 }),
    radials: [radial(1)]
  });
  const second = cache.updateFromPatch({
    stationId: "KEAX",
    product: "REF",
    tilt: 0.5,
    frame: frame({ chunkSequence: 2 }),
    radials: [radial(2)]
  });

  assert.equal(first.patch.sequence, 1);
  assert.equal(second.patch.sequence, 2);
  assert.equal(cache.getSnapshot("KEAX", "REF", 0.5).sequence, 2);
});

test("snapshot load followed by buffered patch replay applies only newer patches", () => {
  const cache = new RadarStateCache();
  cache.updateFromPatch({
    stationId: "KEAX",
    product: "REF",
    tilt: 0.5,
    frame: frame({ chunkSequence: 1 }),
    radials: [radial(1)]
  });
  const snapshot = cache.getSnapshot("KEAX", "REF", 0.5);
  const duplicatePatch = { sequence: snapshot.sequence, radials: [radial(1)] };
  const newerPatch = { sequence: snapshot.sequence + 1, radials: [radial(2)] };

  assert.deepEqual(replayBuffered(snapshot.sequence, [newerPatch, duplicatePatch]), [newerPatch]);
});

test("snapshot keeps previous sweep data when a new sweep starts", () => {
  const cache = new RadarStateCache();
  cache.updateFromPatch({
    stationId: "KEAX",
    product: "REF",
    tilt: 0.5,
    frame: frame({ volumeId: "volume-a", id: "volume-a:0:1" }),
    radials: [radial(10)]
  });
  cache.updateFromPatch({
    stationId: "KEAX",
    product: "REF",
    tilt: 0.5,
    frame: frame({
      volumeId: "volume-b",
      id: "volume-b:0:1",
      scanTime: "2026-06-24T20:05:00.000Z"
    }),
    radials: [radial(11)]
  });

  const snapshot = cache.getSnapshot("KEAX", "REF", 0.5);
  assert.equal(snapshot.currentSweep.radials[0].radialIndex, 11);
  assert.equal(snapshot.previousSweep.radials[0].radialIndex, 10);
  assert.equal(snapshot.radials.length, 2);
});

test("snapshot preserves physical radial resolution for sparse visible data", () => {
  const cache = new RadarStateCache();
  cache.updateFromPatch({
    stationId: "KEAX",
    product: "REF",
    tilt: 0.5,
    frame: frame({ radialCount: 720 }),
    radials: [radial(10), radial(200)]
  });

  const snapshot = cache.getSnapshot("KEAX", "REF", 0.5);
  assert.equal(snapshot.radials.length, 2);
  assert.equal(snapshot.frame.radialCount, 720);
});
