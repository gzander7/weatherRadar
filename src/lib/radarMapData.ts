import type { RadarGateBin } from "./types";
import { reflectivityDbzFromIntensity } from "./reflectivityColorScale";

export interface RadarSite {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  rangeKm: number;
}

export interface FocusPoint {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  sourceSiteId: string;
}

export type RadarGate = RadarGateBin;

export interface RadarSweepFrame {
  id: string;
  sourceId: string;
  generatedAt: string;
  completionRatio: number;
  gates: RadarGate[];
}

export const radarSites: RadarSite[] = [
  {
    id: "kdmx",
    name: "KDMX Des Moines",
    latitude: 41.7311,
    longitude: -93.7228,
    rangeKm: 230
  },
  {
    id: "ktlx",
    name: "KTLX Oklahoma City",
    latitude: 35.3331,
    longitude: -97.2775,
    rangeKm: 230
  },
  {
    id: "keax",
    name: "KEAX Kansas City",
    latitude: 38.8102,
    longitude: -94.2645,
    rangeKm: 230
  }
];

export const focusPoints: FocusPoint[] = [
  {
    id: "kmci",
    label: "KMCI",
    latitude: 39.2976,
    longitude: -94.7139,
    sourceSiteId: "keax"
  }
];

interface StormCore {
  azimuth: number;
  rangeKm: number;
  azimuthSpread: number;
  rangeSpreadKm: number;
  peak: number;
}

function angleDistance(left: number, right: number) {
  const raw = Math.abs(left - right) % 360;
  return raw > 180 ? 360 - raw : raw;
}

function gaussian(distance: number, spread: number) {
  return Math.exp(-(distance * distance) / (2 * spread * spread));
}

function buildStormField(offset: number, phase: number) {
  const cores: StormCore[] = [
    {
      azimuth: (42 + offset) % 360,
      rangeKm: 118,
      azimuthSpread: 9,
      rangeSpreadKm: 18,
      peak: 0.98
    },
    {
      azimuth: (128 + offset * 0.8) % 360,
      rangeKm: 82,
      azimuthSpread: 14,
      rangeSpreadKm: 24,
      peak: 0.73
    },
    {
      azimuth: (228 + offset * 1.2) % 360,
      rangeKm: 64,
      azimuthSpread: 11,
      rangeSpreadKm: 14,
      peak: 0.92
    },
    {
      azimuth: (264 + offset * 0.5) % 360,
      rangeKm: 134,
      azimuthSpread: 10,
      rangeSpreadKm: 20,
      peak: 0.78
    }
  ];

  const gates: RadarGate[] = [];
  const azimuthStep = 1;
  const gateDepthKm = 3;
  const maxRangeKm = 180;

  for (let azimuth = 0; azimuth < 360; azimuth += azimuthStep) {
    for (let rangeStartKm = 6; rangeStartKm < maxRangeKm; rangeStartKm += gateDepthKm) {
      const rangeCenter = rangeStartKm + gateDepthKm / 2;

      let reflectivity = 0;

      for (const core of cores) {
        const azComponent = gaussian(angleDistance(azimuth, core.azimuth), core.azimuthSpread);
        const rangeComponent = gaussian(
          Math.abs(rangeCenter - core.rangeKm),
          core.rangeSpreadKm
        );

        reflectivity += azComponent * rangeComponent * core.peak;
      }

      const banding = 0.035 * Math.sin((azimuth + phase * 17) * (Math.PI / 180));
      const radialTexture = 0.028 * Math.cos((rangeCenter + phase * 9) / 7);
      const intensity = Math.max(0, Math.min(1, reflectivity + banding + radialTexture));

      if (intensity < 0.14) {
        continue;
      }

      gates.push({
        azimuthStart: azimuth,
        azimuthEnd: azimuth + azimuthStep,
        rangeStartKm,
        rangeEndKm: rangeStartKm + gateDepthKm,
        intensity,
        reflectivityDbz: reflectivityDbzFromIntensity(intensity)
      });
    }
  }

  return gates;
}

function buildFrames(sourceId: string, offsets: number[]): RadarSweepFrame[] {
  const now = Date.now();

  return offsets.map((offset, index) => ({
    id: `${sourceId}-frame-${index + 1}`,
    sourceId,
    generatedAt: new Date(now - (offsets.length - index) * 1200).toISOString(),
    completionRatio: 0.35 + index * 0.22,
    gates: buildStormField(offset, index)
  }));
}

export const radarFramesBySource: Record<string, RadarSweepFrame[]> = {
  "kdmx-ref": buildFrames("kdmx-ref", [0, 9, 18]),
  "ktlx-ref": buildFrames("ktlx-ref", [24, 34, 44]),
  "keax-ref": buildFrames("keax-ref", [7, 16, 25])
};
