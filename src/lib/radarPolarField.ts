import type { LiveRadarFrameManifest, LiveRadarRadial, RadarGateBin } from "./types";

export interface PolarRadialData {
  sourceId: string;
  site: string;
  product: string;
  tiltIndex: number;
  radialIndex: number;
  sweepId?: string;
  receivedAtMs?: number;
  isCurrentSweep?: boolean;
  displayOpacity: number;
  azimuthStart: number;
  azimuthEnd: number;
  gateCount: number;
  rangeStartKm: Float32Array;
  rangeEndKm: Float32Array;
  intensity: Float32Array;
  reflectivityDbz: Float32Array;
}

export interface PolarFieldState {
  frame?: LiveRadarFrameManifest;
  radialsByIndex: Map<number, PolarRadialData>;
  gateCount: number;
}

export function createPolarFieldState(frame?: LiveRadarFrameManifest): PolarFieldState {
  return {
    frame,
    radialsByIndex: new Map(),
    gateCount: 0
  };
}

export function sortPolarRadials<T extends { radialIndex: number }>(radials: Iterable<T>) {
  return [...radials].sort((left, right) => left.radialIndex - right.radialIndex);
}

export function toPolarRadialData(
  sourceId: string,
  frame: Pick<LiveRadarFrameManifest, "site" | "product"> | undefined,
  radial: LiveRadarRadial
): PolarRadialData {
  const gateCount = radial.gates.length;
  const rangeStartKm = new Float32Array(gateCount);
  const rangeEndKm = new Float32Array(gateCount);
  const intensity = new Float32Array(gateCount);
  const reflectivityDbz = new Float32Array(gateCount);

  for (let index = 0; index < gateCount; index += 1) {
    const gate = radial.gates[index];
    rangeStartKm[index] = gate.rangeStartKm;
    rangeEndKm[index] = gate.rangeEndKm;
    intensity[index] = gate.intensity;
    reflectivityDbz[index] = gate.reflectivityDbz ?? Number.NaN;
  }

  return {
    sourceId,
    site: frame?.site ?? sourceId.split("-")[0].toUpperCase(),
    product: frame?.product ?? "reflectivity",
    tiltIndex: radial.tiltIndex,
    radialIndex: radial.radialIndex,
    sweepId: radial.sweepId,
    receivedAtMs: radial.receivedAtMs,
    isCurrentSweep: radial.isCurrentSweep,
    displayOpacity: Math.max(0, Math.min(1, radial.displayOpacity ?? 1)),
    azimuthStart: radial.azimuthStart,
    azimuthEnd: radial.azimuthEnd,
    gateCount,
    rangeStartKm,
    rangeEndKm,
    intensity,
    reflectivityDbz
  };
}

export function patchPolarFieldState(
  fieldState: PolarFieldState,
  sourceId: string,
  frame: LiveRadarFrameManifest,
  radials: LiveRadarRadial[]
) {
  fieldState.frame = frame;
  const changedRadials: PolarRadialData[] = [];

  for (const radial of radials) {
    const previous = fieldState.radialsByIndex.get(radial.radialIndex);

    if (previous) {
      fieldState.gateCount -= previous.gateCount;
    }

    const typedRadial = toPolarRadialData(sourceId, frame, radial);
    fieldState.radialsByIndex.set(radial.radialIndex, typedRadial);
    fieldState.gateCount += typedRadial.gateCount;
    changedRadials.push(typedRadial);
  }

  return changedRadials;
}

export function collectPatchPolarRadials(
  fieldState: PolarFieldState,
  changedRadials: PolarRadialData[],
  radialCountHint: number | undefined,
  neighborRadius = 1
) {
  const selected = new Map<number, PolarRadialData>();
  const radialCount = Math.max(0, radialCountHint ?? 0);
  const allowWrap =
    radialCount > 0 && fieldState.radialsByIndex.size >= Math.max(2, Math.floor(radialCount * 0.9));

  for (const radial of changedRadials) {
    const canWrap =
      allowWrap && radial.radialIndex >= 0 && radial.radialIndex < radialCount;

    for (let offset = -neighborRadius; offset <= neighborRadius; offset += 1) {
      let radialIndex = radial.radialIndex + offset;

      if (canWrap) {
        radialIndex = ((radialIndex % radialCount) + radialCount) % radialCount;
      } else if (radialIndex < 0) {
        continue;
      }

      const cached = fieldState.radialsByIndex.get(radialIndex);

      if (!cached) {
        continue;
      }

      selected.set(radialIndex, cached);
    }
  }

  return sortPolarRadials(selected.values());
}

export function buildPolarRadialsFromBins(
  sourceId: string,
  site: string,
  product: string,
  tiltIndex: number,
  bins: RadarGateBin[]
) {
  const groups = new Map<string, RadarGateBin[]>();

  for (const bin of bins) {
    const key = `${bin.azimuthStart.toFixed(3)}:${bin.azimuthEnd.toFixed(3)}`;
    const existing = groups.get(key);

    if (existing) {
      existing.push(bin);
      continue;
    }

    groups.set(key, [bin]);
  }

  return [...groups.values()]
    .sort((left, right) => left[0].azimuthStart - right[0].azimuthStart)
    .map((group, radialIndex) =>
      toPolarRadialData(
        sourceId,
        {
          site,
          product
        },
        {
          tiltIndex,
          radialIndex,
          azimuthStart: group[0].azimuthStart,
          azimuthEnd: group[0].azimuthEnd,
          gates: group.slice().sort((left, right) => left.rangeStartKm - right.rangeStartKm)
        }
      )
    );
}
