import type { RadarGateBin } from "./types";

export interface ReflectivityColorStop {
  minDbz: number;
  color: string;
}

export interface ReflectivityColorTable {
  id: string;
  minDbz: number;
  maxDbz: number;
  underColor: string;
  overColor: string;
  stops: ReflectivityColorStop[];
}

const defaultMinDbz = -10;
const defaultMaxDbz = 75;

export const baseReflectivityColorTable: ReflectivityColorTable = {
  id: "base-reflectivity-radarscope-style",
  minDbz: defaultMinDbz,
  maxDbz: defaultMaxDbz,
  underColor: "#08141c00",
  overColor: "#ffffff",
  stops: [
    { minDbz: -10, color: "#08141c00" },
    { minDbz: -5, color: "#0e243210" },
    { minDbz: 0, color: "#10424a28" },
    { minDbz: 5, color: "#0f67496e" },
    { minDbz: 10, color: "#178b43d8" },
    { minDbz: 15, color: "#30b146" },
    { minDbz: 20, color: "#6cc53a" },
    { minDbz: 25, color: "#bfd334" },
    { minDbz: 30, color: "#f0df2e" },
    { minDbz: 35, color: "#f6bd28" },
    { minDbz: 40, color: "#f28d21" },
    { minDbz: 45, color: "#ea5922" },
    { minDbz: 50, color: "#db2e22" },
    { minDbz: 55, color: "#c01f4d" },
    { minDbz: 60, color: "#c93b8a" },
    { minDbz: 65, color: "#ea76c8" },
    { minDbz: 70, color: "#f7eaf3" },
    { minDbz: 75, color: "#ffffff" }
  ]
};

export const reflectivityColorTables = {
  baseReflectivity: baseReflectivityColorTable
} as const;

export function clampReflectivityDbz(
  dbz: number,
  table: ReflectivityColorTable = baseReflectivityColorTable
) {
  if (!Number.isFinite(dbz)) {
    return table.minDbz;
  }

  return Math.max(table.minDbz, Math.min(table.maxDbz, dbz));
}

export function normalizeReflectivityDbz(
  dbz: number,
  table: ReflectivityColorTable = baseReflectivityColorTable
) {
  const clamped = clampReflectivityDbz(dbz, table);
  return (clamped - table.minDbz) / (table.maxDbz - table.minDbz);
}

export function reflectivityDbzFromIntensity(
  intensity: number,
  table: ReflectivityColorTable = baseReflectivityColorTable
) {
  const normalized = Math.max(0, Math.min(1, intensity));
  return table.minDbz + normalized * (table.maxDbz - table.minDbz);
}

export function gateReflectivityDbz(
  gate: Pick<RadarGateBin, "intensity" | "reflectivityDbz">,
  table: ReflectivityColorTable = baseReflectivityColorTable
) {
  const dbz =
    typeof gate.reflectivityDbz === "number"
      ? gate.reflectivityDbz
      : reflectivityDbzFromIntensity(gate.intensity, table);

  return clampReflectivityDbz(dbz, table);
}

export function reflectivityColorForDbz(
  dbz: number,
  table: ReflectivityColorTable = baseReflectivityColorTable
) {
  const clamped = clampReflectivityDbz(dbz, table);

  if (clamped <= table.minDbz) {
    return table.underColor;
  }

  if (clamped >= table.maxDbz) {
    return table.overColor;
  }

  let color = table.underColor;

  for (const stop of table.stops) {
    if (clamped >= stop.minDbz) {
      color = stop.color;
      continue;
    }

    break;
  }

  return color;
}

export function reflectivityFillForGate(
  gate: Pick<RadarGateBin, "intensity" | "reflectivityDbz">,
  table: ReflectivityColorTable = baseReflectivityColorTable
) {
  return reflectivityColorForDbz(gateReflectivityDbz(gate, table), table);
}

export function reflectivityFillForValues(
  intensity: number,
  reflectivityDbz: number | undefined,
  table: ReflectivityColorTable = baseReflectivityColorTable
) {
  const dbz =
    typeof reflectivityDbz === "number" && Number.isFinite(reflectivityDbz)
      ? reflectivityDbz
      : reflectivityDbzFromIntensity(intensity, table);

  return reflectivityColorForDbz(dbz, table);
}

export function normalizeReflectivityValue(
  intensity: number,
  reflectivityDbz: number | undefined,
  table: ReflectivityColorTable = baseReflectivityColorTable
) {
  const dbz =
    typeof reflectivityDbz === "number" && Number.isFinite(reflectivityDbz)
      ? reflectivityDbz
      : reflectivityDbzFromIntensity(intensity, table);

  return normalizeReflectivityDbz(dbz, table);
}

function hexChannelPairToInt(pair: string) {
  return Number.parseInt(pair, 16);
}

function colorToRgbaBytes(color: string) {
  const normalized = color.trim().toLowerCase();

  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);

    if (hex.length === 6) {
      return [
        hexChannelPairToInt(hex.slice(0, 2)),
        hexChannelPairToInt(hex.slice(2, 4)),
        hexChannelPairToInt(hex.slice(4, 6)),
        255
      ];
    }

    if (hex.length === 8) {
      return [
        hexChannelPairToInt(hex.slice(0, 2)),
        hexChannelPairToInt(hex.slice(2, 4)),
        hexChannelPairToInt(hex.slice(4, 6)),
        hexChannelPairToInt(hex.slice(6, 8))
      ];
    }
  }

  return [255, 255, 255, 255];
}

export function buildReflectivityPaletteTexture(
  table: ReflectivityColorTable = baseReflectivityColorTable,
  size = 256
) {
  const data = new Uint8Array(size * 4);

  for (let index = 0; index < size; index += 1) {
    const normalized = size <= 1 ? 0 : index / (size - 1);
    const dbz = table.minDbz + normalized * (table.maxDbz - table.minDbz);
    const [red, green, blue, alpha] = colorToRgbaBytes(reflectivityColorForDbz(dbz, table));
    const pixelOffset = index * 4;
    data[pixelOffset] = red;
    data[pixelOffset + 1] = green;
    data[pixelOffset + 2] = blue;
    data[pixelOffset + 3] = alpha;
  }

  return data;
}
