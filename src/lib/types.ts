export type RadarSourceKind = "single-site" | "mrms";

export interface RadarSource {
  id: string;
  name: string;
  kind: RadarSourceKind;
  cadenceSeconds: number;
  ingestDelaySeconds: number;
  transport: "l2" | "grib2" | "tiles" | "mesh";
  notes: string;
}

export interface RadarFrame {
  id: string;
  sourceId: string;
  product: string;
  scanTime: string;
  availableTime: string;
  renderTime: string;
  ageSeconds: number;
  sweepCount: number;
  completionRatio: number;
  latencyBudgetMs: number;
}

export interface LatencySegment {
  label: string;
  milliseconds: number;
}

export interface LatencyProfile {
  sourceId: string;
  targetMs: number;
  currentMs: number;
  segments: LatencySegment[];
}

export interface SweepMode {
  id: string;
  name: string;
  description: string;
  frameStepMs: number;
}

export interface RadarGateBin {
  azimuthStart: number;
  azimuthEnd: number;
  rangeStartKm: number;
  rangeEndKm: number;
  intensity: number;
  reflectivityDbz?: number;
}

export interface LiveRadarFrameManifest {
  id: string;
  sourceId: string;
  site: string;
  siteLatitude?: number;
  siteLongitude?: number;
  volumeId?: string;
  tiltIndex: number;
  radialIndex: number;
  chunkSequence: number;
  sequence?: number;
  isTiltComplete: boolean;
  isVolumeComplete: boolean;
  radialCount?: number;
  gateCount?: number;
  sweepStartAzimuth?: number;
  sweepEndAzimuth?: number;
  product: string;
  elevation: number;
  scanTime: string;
  ingestTime: string;
  publishTime: string;
  completionRatio: number;
  ingestLane: "chunks" | "archive";
  renderHint: string;
}

export interface LiveRadarRadial {
  tiltIndex: number;
  radialIndex: number;
  sourceRadialIndex?: number;
  assignedSlotIndex?: number;
  sweepId?: string;
  receivedAtMs?: number;
  isCurrentSweep?: boolean;
  displayOpacity?: number;
  azimuthStart: number;
  azimuthEnd: number;
  gates: RadarGateBin[];
}

export interface LiveRadarRadialBatch {
  type?: "radial_batch";
  stationId?: string;
  product?: string;
  tilt?: number;
  sequence?: number;
  frame: LiveRadarFrameManifest;
  radials: LiveRadarRadial[];
}

export interface RadarSweepBuffer {
  sweepId: string;
  frame: LiveRadarFrameManifest;
  radials: LiveRadarRadial[];
  radialCount: number;
  gateCount: number;
}

export interface RadarSnapshot {
  stationId: string;
  product: string;
  tilt: number;
  sequence: number;
  newestRadarTime?: string;
  oldestVisibleRadarTime?: string;
  updatedAt: string;
  currentSweep: RadarSweepBuffer;
  previousSweep?: RadarSweepBuffer;
  frame: LiveRadarFrameManifest;
  radials: LiveRadarRadial[];
}

export type RadarPatch = LiveRadarRadialBatch & {
  type: "radial_batch";
  stationId: string;
  product: string;
  tilt: number;
  sequence: number;
};

export interface LiveRadarRenderFrame extends LiveRadarFrameManifest {
  radials: LiveRadarRadial[];
  gates?: RadarGateBin[];
}
