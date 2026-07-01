import type { LatencyProfile, RadarFrame, RadarSource, SweepMode } from "./types";

export const radarSources: RadarSource[] = [
  {
    id: "kdmx-ref",
    name: "KDMX Base Reflectivity",
    kind: "single-site",
    cadenceSeconds: 18,
    ingestDelaySeconds: 4,
    transport: "l2",
    notes: "Direct Level II ingest with per-elevation partial sweep publishing."
  },
  {
    id: "ktlx-ref",
    name: "KTLX Base Reflectivity",
    kind: "single-site",
    cadenceSeconds: 18,
    ingestDelaySeconds: 5,
    transport: "l2",
    notes: "Second live single-site path for validating per-radar ingest and fanout."
  },
  {
    id: "mrms-qpe",
    name: "MRMS QPE + Merged Reflectivity",
    kind: "mrms",
    cadenceSeconds: 120,
    ingestDelaySeconds: 45,
    transport: "grib2",
    notes: "MRMS is slower but provides national context and gap filling."
  },
  {
    id: "keax-ref",
    name: "KEAX Base Reflectivity",
    kind: "single-site",
    cadenceSeconds: 18,
    ingestDelaySeconds: 4,
    transport: "l2",
    notes: "Kansas City area radar path. Pair with KMCI focus marker for airport-area situational view."
  }
];

export const recentFrames: RadarFrame[] = [
  {
    id: "frame-001",
    sourceId: "kdmx-ref",
    product: "0.5 deg reflectivity",
    scanTime: "2026-03-06T23:59:18Z",
    availableTime: "2026-03-06T23:59:22Z",
    renderTime: "2026-03-06T23:59:23Z",
    ageSeconds: 9,
    sweepCount: 14,
    completionRatio: 0.86,
    latencyBudgetMs: 5200
  },
  {
    id: "frame-002",
    sourceId: "ktlx-ref",
    product: "0.5 deg reflectivity",
    scanTime: "2026-03-06T23:59:08Z",
    availableTime: "2026-03-06T23:59:13Z",
    renderTime: "2026-03-06T23:59:14Z",
    ageSeconds: 18,
    sweepCount: 14,
    completionRatio: 0.79,
    latencyBudgetMs: 6100
  },
  {
    id: "frame-003",
    sourceId: "mrms-qpe",
    product: "merged reflectivity",
    scanTime: "2026-03-06T23:57:00Z",
    availableTime: "2026-03-06T23:57:42Z",
    renderTime: "2026-03-06T23:57:44Z",
    ageSeconds: 108,
    sweepCount: 1,
    completionRatio: 1,
    latencyBudgetMs: 44000
  },
  {
    id: "frame-004",
    sourceId: "keax-ref",
    product: "0.5 deg reflectivity",
    scanTime: "2026-03-06T23:59:28Z",
    availableTime: "2026-03-06T23:59:31Z",
    renderTime: "2026-03-06T23:59:32Z",
    ageSeconds: 7,
    sweepCount: 14,
    completionRatio: 0.83,
    latencyBudgetMs: 5000
  }
];

export const sweepModes: SweepMode[] = [
  {
    id: "rapid",
    name: "RapidSweep",
    description: "Publishes partial sweeps immediately and advances every 250 ms.",
    frameStepMs: 250
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "Smooth playback while preserving near-live progression.",
    frameStepMs: 400
  },
  {
    id: "archive",
    name: "Archive",
    description: "Traditional radar loop pacing for analysis and comparison.",
    frameStepMs: 700
  }
];

export const latencyProfiles: LatencyProfile[] = [
  {
    sourceId: "kdmx-ref",
    targetMs: 6000,
    currentMs: 5200,
    segments: [
      { label: "NOAA ingest", milliseconds: 2800 },
      { label: "decode + tile build", milliseconds: 1600 },
      { label: "edge fanout", milliseconds: 500 },
      { label: "client render", milliseconds: 300 }
    ]
  },
  {
    sourceId: "ktlx-ref",
    targetMs: 6500,
    currentMs: 6100,
    segments: [
      { label: "NOAA ingest", milliseconds: 3100 },
      { label: "moment decode", milliseconds: 1900 },
      { label: "edge fanout", milliseconds: 700 },
      { label: "client render", milliseconds: 400 }
    ]
  },
  {
    sourceId: "mrms-qpe",
    targetMs: 50000,
    currentMs: 44000,
    segments: [
      { label: "upstream generation", milliseconds: 30000 },
      { label: "mosaic conversion", milliseconds: 9000 },
      { label: "distribution", milliseconds: 3000 },
      { label: "client render", milliseconds: 2000 }
    ]
  },
  {
    sourceId: "keax-ref",
    targetMs: 6000,
    currentMs: 5000,
    segments: [
      { label: "NOAA ingest", milliseconds: 2600 },
      { label: "decode + merge", milliseconds: 1500 },
      { label: "edge fanout", milliseconds: 600 },
      { label: "client render", milliseconds: 300 }
    ]
  }
];
