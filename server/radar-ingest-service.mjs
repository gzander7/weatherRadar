import { Level2Radar } from "nexrad-level-2-data";
import { RadarStateCache } from "./radar-state-cache.mjs";

const chunkBucket = "https://unidata-nexrad-level2-chunks.s3.amazonaws.com";
const archiveBucket = "https://noaa-nexrad-level2.s3.amazonaws.com";
const chunkPrefixRefreshMs = 5 * 60 * 1000;
const baseReflectivityRadialResolution = 720;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, responseType, errorPrefix) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "weather-radar-app/0.1" } });

      if (!response.ok) {
        throw new Error(`${errorPrefix}: ${response.status}`);
      }

      if (responseType === "text") {
        return await response.text();
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;

      if (attempt >= 3) {
        break;
      }

      await sleep(200 * attempt);
    }
  }

  throw lastError;
}

async function listBucketObjects(baseUrl, prefix, maxKeys = 25) {
  const url = `${baseUrl}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const xml = await fetchWithRetry(url, "text", `Bucket listing failed for ${prefix}`);
  const matches = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)];
  return matches.map((match) => match[1]);
}

async function listCommonPrefixes(baseUrl, prefix) {
  const url = `${baseUrl}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/`;
  const xml = await fetchWithRetry(url, "text", `Prefix listing failed for ${prefix}`);
  const matches = [...xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)];
  return matches.map((match) => match[1]).filter((candidate) => candidate !== prefix);
}

async function fetchObject(baseUrl, key) {
  return fetchWithRetry(`${baseUrl}/${key}`, "buffer", `Object fetch failed for ${key}`);
}

function utcDateParts(date = new Date()) {
  return {
    year: `${date.getUTCFullYear()}`,
    month: `${date.getUTCMonth() + 1}`.padStart(2, "0"),
    day: `${date.getUTCDate()}`.padStart(2, "0")
  };
}

function buildChunkPrefixes(site) {
  const today = utcDateParts();
  const yesterday = utcDateParts(new Date(Date.now() - 24 * 60 * 60 * 1000));

  return [
    `${site}/`,
    `${site}/${today.year}/${today.month}/${today.day}/`,
    `${today.year}/${today.month}/${today.day}/${site}/`,
    `${yesterday.year}/${yesterday.month}/${yesterday.day}/${site}/`
  ];
}

function extractKeyTimestamp(key) {
  const match = key.match(/(\d{8}-\d{6})/);

  if (!match) {
    return "";
  }

  return match[1];
}

function keyTimestampToIso(key) {
  const timestamp = extractKeyTimestamp(key);
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
  ).toISOString();
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  );

  return results;
}

function buildArchivePrefixes(site) {
  const today = utcDateParts();
  const yesterday = utcDateParts(new Date(Date.now() - 24 * 60 * 60 * 1000));

  return [
    `${today.year}/${today.month}/${today.day}/${site}/`,
    `${yesterday.year}/${yesterday.month}/${yesterday.day}/${site}/`
  ];
}

function normalizeAngle(angle) {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function julianToIso(julianDate, milliseconds, fallbackIso = null) {
  if (typeof julianDate !== "number" || typeof milliseconds !== "number") {
    return fallbackIso ?? new Date().toISOString();
  }

  const epochMs = (julianDate - 40587) * 86400000 + milliseconds;

  if (!Number.isFinite(epochMs)) {
    return fallbackIso ?? new Date().toISOString();
  }

  const parsed = new Date(epochMs);
  const now = Date.now();

  if (parsed.getTime() > now + 15 * 60 * 1000 || parsed.getTime() < now - 36 * 60 * 60 * 1000) {
    return fallbackIso ?? new Date().toISOString();
  }

  return new Date(epochMs).toISOString();
}

function reflectivityToIntensity(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const clipped = Math.max(0, Math.min(75, value + 10));
  return clipped / 85;
}

function reflectivityRadialResolution() {
  return baseReflectivityRadialResolution;
}

function radarProductFromRadial(radial) {
  return radial.product === "reflectivity" ? "REF" : String(radial.product ?? "REF").toUpperCase();
}

function radarTiltFromRadial(radial) {
  if (radial.product === "reflectivity") {
    return 0.5;
  }

  const elevation = Number(radial.elevation);
  return Number.isFinite(elevation) ? elevation : 0.5;
}

function quantizeAzimuthToRadialIndex(azimuth, radialResolution = reflectivityRadialResolution()) {
  const normalized = normalizeAngle(azimuth);
  return Math.round((normalized / 360) * radialResolution) % radialResolution;
}

function azimuthBoundsForRadialIndex(radialIndex, radialResolution = reflectivityRadialResolution()) {
  const spanDegrees = 360 / radialResolution;
  const center = radialIndex * spanDegrees;
  return {
    azimuthStart: normalizeAngle(center - spanDegrees / 2),
    azimuthEnd: normalizeAngle(center + spanDegrees / 2)
  };
}

function selectBaseReflectivityElevations(elevations) {
  const numericElevations = elevations
    .map((elevation, tiltIndex) => ({ elevation, tiltIndex }))
    .filter(({ elevation }) => typeof elevation === "number" && Number.isFinite(elevation))
    .sort((left, right) => left.elevation - right.elevation);
  const exactBaseElevation = numericElevations.find(({ elevation }) => elevation === 1);

  if (exactBaseElevation) {
    return [exactBaseElevation];
  }

  return numericElevations.length > 0 ? [numericElevations[0]] : [];
}

function sampleMomentToBins(moment, azimuth) {
  const values = moment?.moment_data ?? [];

  if (!Array.isArray(values) || values.length === 0) {
    return { bins: [], reason: "moment-data-empty" };
  }

  const stride = Math.max(1, Math.ceil(values.length / 240));
  const bins = [];
  let filteredGateCount = 0;

  for (let index = 0; index < values.length; index += stride) {
    const value = values[index];

    if (value == null || !Number.isFinite(value) || value <= -32) {
      filteredGateCount += 1;
      continue;
    }

    const intensity = reflectivityToIntensity(value);

    if (value < 0 || intensity <= 0.015) {
      filteredGateCount += 1;
      continue;
    }

    const rangeStartKm = (moment.first_gate ?? 0) + index * (moment.gate_size ?? 0.25);
    const rangeEndKm = rangeStartKm + (moment.gate_size ?? 0.25) * stride;

    bins.push({
      azimuthStart: normalizeAngle(azimuth - 0.5),
      azimuthEnd: normalizeAngle(azimuth + 0.5),
      rangeStartKm,
      rangeEndKm,
      intensity,
      reflectivityDbz: value
    });
  }

  return {
    bins,
    reason: bins.length > 0 ? "ok" : filteredGateCount > 0 ? "all-gates-filtered" : "no-sampled-gates"
  };
}

function extractSweepRadialsFromRadar(radar, site, key, ingestLane, ingestTime) {
  const radials = [];
  const diagnostics = {
    baseElevationPresent: false,
    scanCount: 0,
    reflectivityReadFailures: 0,
    emptyMomentDataScans: 0,
    filteredOutScans: 0,
    emittedScans: 0
  };
  const elevations = radar.listElevations();
  const selectedElevations = selectBaseReflectivityElevations(elevations);
  const siteLatitude = radar.header?.latitude ?? radar.data?.[1]?.[0]?.record?.volume?.latitude;
  const siteLongitude = radar.header?.longitude ?? radar.data?.[1]?.[0]?.record?.volume?.longitude;
  const volumeId = key.split("/").slice(0, 3).join("/");
  const expectedRadialCount = reflectivityRadialResolution();
  const keyScanTime = keyTimestampToIso(key);

  for (const { tiltIndex, elevation } of selectedElevations) {
    diagnostics.baseElevationPresent = true;
    radar.setElevation(elevation);

    let scanCount = 0;

    try {
      scanCount = radar.getScans();
    } catch {
      continue;
    }

    diagnostics.scanCount += scanCount;

    for (let scan = 0; scan < scanCount; scan += 1) {
      try {
        const reflectivity = radar.getHighresReflectivity(scan);
        const header = radar.getHeader(scan);
        const azimuth = radar.getAzimuth(scan);
        const { bins: gates, reason } = sampleMomentToBins(reflectivity, azimuth);
        const radialIndex = quantizeAzimuthToRadialIndex(azimuth, expectedRadialCount);
        const azimuthBounds = azimuthBoundsForRadialIndex(radialIndex, expectedRadialCount);

        if (gates.length === 0) {
          if (reason === "moment-data-empty") {
            diagnostics.emptyMomentDataScans += 1;
            continue;
          }

          if (reason !== "all-gates-filtered" && reason !== "no-sampled-gates") {
            diagnostics.filteredOutScans += 1;
            continue;
          }

          diagnostics.filteredOutScans += 1;
        }

        diagnostics.emittedScans += 1;
        radials.push({
          id: `${key}:${elevation}:${scan}`,
          sourceId: `${site.toLowerCase()}-ref`,
          site,
          siteLatitude,
          siteLongitude,
          volumeId,
          tiltIndex,
          radialIndex,
          azimuthStart: azimuthBounds.azimuthStart,
          azimuthEnd: azimuthBounds.azimuthEnd,
          sweepStartAzimuth: azimuthBounds.azimuthStart,
          sweepEndAzimuth: azimuthBounds.azimuthEnd,
          product: "reflectivity",
          elevation,
          scanTime: julianToIso(header?.julian_date, header?.mseconds, keyScanTime),
          ingestTime,
          publishTime: new Date().toISOString(),
          completionRatio: Math.min(1, (scan + 1) / Math.max(expectedRadialCount, 1)),
          ingestLane,
          renderHint: "canvas-bins",
          scanCount,
          scanSequence: scan,
          expectedRadialCount,
          gates
        });
      } catch {
        // Chunks often have incomplete elevations. Skip scans without reflectivity.
        diagnostics.reflectivityReadFailures += 1;
      }
    }
  }

  return { radials, diagnostics };
}

async function decodeArchive(buffer, site, key, ingestLane, ingestTime) {
  const radar = await new Level2Radar(buffer, { logger: false });
  return extractSweepRadialsFromRadar(radar, site, key, ingestLane, ingestTime);
}

function summarizeDiagnostics(diagnostics) {
  if (diagnostics.emittedScans > 0) {
    return `emitted=${diagnostics.emittedScans}/${diagnostics.scanCount || "?"} scans`;
  }

  if (!diagnostics.baseElevationPresent) {
    return "no base elevation data";
  }

  if (diagnostics.scanCount === 0) {
    return "elevation-1 scan count unavailable";
  }

  if (diagnostics.reflectivityReadFailures === diagnostics.scanCount) {
    return "reflectivity unavailable for all scans";
  }

  if (diagnostics.emptyMomentDataScans === diagnostics.scanCount) {
    return "moment_data empty for all scans";
  }

  if (
    diagnostics.filteredOutScans + diagnostics.emptyMomentDataScans + diagnostics.reflectivityReadFailures >=
    diagnostics.scanCount
  ) {
    return `no usable gates: filtered=${diagnostics.filteredOutScans} empty=${diagnostics.emptyMomentDataScans} reflectivity_fail=${diagnostics.reflectivityReadFailures}`;
  }

  return `emitted=0 scans=${diagnostics.scanCount} filtered=${diagnostics.filteredOutScans} empty=${diagnostics.emptyMomentDataScans} reflectivity_fail=${diagnostics.reflectivityReadFailures}`;
}

function createSweepStateKey({ site, volumeId, tiltIndex, product }) {
  return [site, volumeId ?? "live", tiltIndex, product].join(":");
}

function createRollingFieldStateKey({ sourceId, site, tiltIndex, product }) {
  return [sourceId, site, tiltIndex, product].join(":");
}

function gateKey(gate) {
  return [
    gate.azimuthStart.toFixed(3),
    gate.azimuthEnd.toFixed(3),
    gate.rangeStartKm.toFixed(3),
    gate.rangeEndKm.toFixed(3)
  ].join(":");
}

function radialSignature(radial) {
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

function toTransportRadial(radial) {
  return {
    tiltIndex: radial.tiltIndex,
    radialIndex: radial.radialIndex,
    sourceRadialIndex: radial.scanSequence ?? radial.radialIndex,
    assignedSlotIndex: radial.radialIndex,
    azimuthStart: radial.sweepStartAzimuth ?? radial.azimuthStart,
    azimuthEnd: radial.sweepEndAzimuth ?? radial.azimuthEnd,
    gates: radial.gates
  };
}

function createSweepState(radial) {
  return {
    key: createSweepStateKey(radial),
    sourceId: radial.sourceId,
    site: radial.site,
    siteLatitude: radial.siteLatitude,
    siteLongitude: radial.siteLongitude,
    volumeId: radial.volumeId,
    product: radial.product,
    elevation: radial.elevation,
    tiltIndex: radial.tiltIndex,
    ingestLane: radial.ingestLane,
    renderHint: radial.renderHint,
    radialsByIndex: new Map(),
    radialSignatures: new Map(),
    radialCount: radial.expectedRadialCount ?? reflectivityRadialResolution(),
    receivedRadialCount: 0,
    gateCount: 0,
    chunkSequence: 0,
    lastManifest: null
  };
}

function createRollingFieldState(radial) {
  return {
    key: createRollingFieldStateKey(radial),
    sourceId: radial.sourceId,
    site: radial.site,
    siteLatitude: radial.siteLatitude,
    siteLongitude: radial.siteLongitude,
    product: radial.product,
    elevation: radial.elevation,
    tiltIndex: radial.tiltIndex,
    ingestLane: radial.ingestLane,
    renderHint: radial.renderHint,
    radialsByIndex: new Map(),
    radialSignatures: new Map(),
    radialCount: radial.expectedRadialCount ?? reflectivityRadialResolution(),
    receivedRadialCount: 0,
    gateCount: 0,
    chunkSequence: 0,
    lastManifest: null,
    volumeId: radial.volumeId
  };
}

function buildFrameManifest(sweepState, changedRadials) {
  const firstRadial = changedRadials[0];
  const lastRadial = changedRadials.at(-1);
  const expectedRadialCount = Math.max(
    lastRadial?.expectedRadialCount ?? 0,
    sweepState.radialCount,
    reflectivityRadialResolution()
  );
  const completionRatio = Math.min(
    1,
    Math.max(0, sweepState.receivedRadialCount) / Math.max(expectedRadialCount, 1)
  );
  const isTiltComplete = sweepState.receivedRadialCount >= Math.floor(expectedRadialCount * 0.98);

  return {
    id: `${sweepState.volumeId}:${sweepState.tiltIndex}:${sweepState.chunkSequence}`,
    sourceId: sweepState.sourceId,
    site: sweepState.site,
    siteLatitude: sweepState.siteLatitude,
    siteLongitude: sweepState.siteLongitude,
    volumeId: sweepState.volumeId,
    tiltIndex: sweepState.tiltIndex,
    radialIndex: lastRadial?.radialIndex ?? 0,
    chunkSequence: sweepState.chunkSequence,
    isTiltComplete,
    isVolumeComplete: isTiltComplete,
    radialCount: expectedRadialCount,
    gateCount: sweepState.gateCount,
    sweepStartAzimuth: firstRadial?.sweepStartAzimuth,
    sweepEndAzimuth: lastRadial?.sweepEndAzimuth,
    product: sweepState.product,
    elevation: sweepState.elevation,
    scanTime: lastRadial?.scanTime ?? new Date().toISOString(),
    ingestTime: lastRadial?.ingestTime ?? new Date().toISOString(),
    publishTime: new Date().toISOString(),
    completionRatio,
    ingestLane: lastRadial?.ingestLane ?? sweepState.ingestLane,
    renderHint: sweepState.renderHint
  };
}

function applyRadialsToSweepState(sweepState, radials) {
  const changedRadials = [];

  for (const radial of radials.sort((left, right) => left.radialIndex - right.radialIndex)) {
    const signature = radialSignature(radial);

    if (sweepState.radialSignatures.get(radial.radialIndex) === signature) {
      continue;
    }

    const previousRadial = sweepState.radialsByIndex.get(radial.radialIndex);

    if (previousRadial) {
      sweepState.gateCount -= previousRadial.gates.length;
    }

    sweepState.radialsByIndex.set(radial.radialIndex, radial);
    sweepState.radialSignatures.set(radial.radialIndex, signature);
    sweepState.gateCount += radial.gates.length;
    changedRadials.push(radial);
  }

  if (changedRadials.length === 0) {
    return null;
  }

  sweepState.receivedRadialCount = sweepState.radialsByIndex.size;
  sweepState.radialCount = Math.max(
    sweepState.radialCount,
    ...radials.map((radial) => radial.expectedRadialCount ?? 0)
  );
  sweepState.chunkSequence += 1;
  sweepState.lastManifest = buildFrameManifest(sweepState, changedRadials);

  return {
    frame: sweepState.lastManifest,
    radials: changedRadials.map((radial) => toTransportRadial(radial))
  };
}

function buildBootstrapPayload(sweepState) {
  if (!sweepState?.lastManifest) {
    return null;
  }

  return {
    frame: sweepState.lastManifest,
    radials: [...sweepState.radialsByIndex.values()]
      .sort((left, right) => left.radialIndex - right.radialIndex)
      .map((radial) => toTransportRadial(radial))
  };
}

export class RadarIngestService {
  constructor({ sites, pollIntervalMs }) {
    this.defaultSites = [...sites];
    this.sites = [];
    this.pollIntervalMs = pollIntervalMs;
    this.subscribers = new Set();
    this.running = false;
    this.seenKeys = new Set();
    this.chunkHistory = new Map();
    this.latestManifestBySource = new Map();
    this.latestSweepKeyBySource = new Map();
    this.activeSweepStates = new Map();
    this.rollingFieldStates = new Map();
    this.latestRollingFieldKeyBySource = new Map();
    this.radarStateCache = new RadarStateCache();
    this.latestChunkPrefixBySite = new Map();
    this.latestChunkPrefixCheckedAt = new Map();
    this.currentVolumePrefixBySite = new Map();
    this.inFlightPolls = new Map();
    this.status = {
      lastPollAt: null,
      lastEmitAt: null,
      lastMessage: "idle",
      lastEmitSourceId: null,
      lastEmitGateCount: 0
    };
  }

  getConfiguredSites() {
    return [...this.defaultSites];
  }

  setRequestedSites(sites) {
    this.sites = [...new Set(sites)];
    this.setStatus(
      this.sites.length > 0 ? `active sites: ${this.sites.join(", ")}` : "active sites: none"
    );
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  emit(update) {
    this.status.lastEmitAt = new Date().toISOString();
    this.status.lastMessage = `emitted ${update.frame.id}`;
    this.status.lastEmitSourceId = update.frame.sourceId;
    this.status.lastEmitGateCount = update.frame.gateCount ?? 0;
    this.latestManifestBySource.set(update.frame.sourceId, update.frame);
    for (const listener of this.subscribers) {
      listener(update);
    }
  }

  updateRadarStateCache(update, sweepRadials) {
    const firstRadial = sweepRadials[0];

    if (!firstRadial) {
      return update;
    }

    const { patch } = this.radarStateCache.updateFromPatch({
      stationId: firstRadial.site,
      product: radarProductFromRadial(firstRadial),
      tilt: radarTiltFromRadial(firstRadial),
      frame: update.frame,
      radials: update.radials
    });

    return {
      ...update,
      type: patch.type,
      stationId: patch.stationId,
      product: patch.product,
      tilt: patch.tilt,
      sequence: patch.sequence,
      frame: {
        ...update.frame,
        product: patch.product,
        sequence: patch.sequence
      },
      radials: patch.radials
    };
  }

  getLatestManifest(sourceId) {
    return this.latestManifestBySource.get(sourceId) ?? null;
  }

  getLatestSweepState(sourceId) {
    const rollingFieldKey = this.latestRollingFieldKeyBySource.get(sourceId);

    if (!rollingFieldKey) {
      return null;
    }

    return buildBootstrapPayload(this.rollingFieldStates.get(rollingFieldKey)) ?? null;
  }

  getLatestRadarSnapshot(stationId, product = "REF", tilt = 0.5) {
    return this.radarStateCache.getSnapshot(stationId, product, tilt);
  }

  getRadarSequence(stationId, product = "REF", tilt = 0.5) {
    return this.radarStateCache.getSequence(stationId, product, tilt);
  }

  setStatus(message) {
    this.status.lastPollAt = new Date().toISOString();
    this.status.lastMessage = message;
    console.log(`[radar] ${message}`);
  }

  getStatus() {
    return { ...this.status };
  }

  async findLatestChunkPrefix(site) {
    const prefixes = await listCommonPrefixes(chunkBucket, `${site}/`);

    if (prefixes.length === 0) {
      return null;
    }

    const inspectedPrefixes = await mapWithConcurrency(prefixes, 10, async (prefix) => {
      try {
        const keys = await listBucketObjects(chunkBucket, prefix, 200);
        const latestKey = keys
          .slice()
          .sort((left, right) => extractKeyTimestamp(left).localeCompare(extractKeyTimestamp(right)))
          .at(-1);

        if (!latestKey) {
          return null;
        }

        return {
          prefix,
          latestKey,
          timestamp: extractKeyTimestamp(latestKey)
        };
      } catch {
        return null;
      }
    });

    return inspectedPrefixes
      .filter(Boolean)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .at(-1) ?? null;
  }

  async loadChunkCandidates(site) {
    const cachedPrefix = this.latestChunkPrefixBySite.get(site);
    const checkedAt = this.latestChunkPrefixCheckedAt.get(site) ?? 0;
    const now = Date.now();

    let latestPrefix = cachedPrefix;

    if (!latestPrefix || now - checkedAt > chunkPrefixRefreshMs) {
      const latestChunk = await this.findLatestChunkPrefix(site);

      if (!latestChunk) {
        this.setStatus(`${site}: no chunk volume prefixes found`);
        return [];
      }

      latestPrefix = latestChunk.prefix;
      this.latestChunkPrefixBySite.set(site, latestPrefix);
      this.latestChunkPrefixCheckedAt.set(site, now);
      this.setStatus(`${site}: selected live chunk prefix ${latestPrefix} (${latestChunk.timestamp})`);
    }

    if (!latestPrefix) {
      this.setStatus(`${site}: no chunk volume prefixes found`);
      return [];
    }

    this.setStatus(`${site}: reading chunk prefix ${latestPrefix}`);
    const keys = await listBucketObjects(chunkBucket, latestPrefix, 200);
    return keys;
  }

  async loadArchiveCandidates(site) {
    for (const prefix of buildArchivePrefixes(site)) {
      try {
        const keys = await listBucketObjects(archiveBucket, prefix, 4);

        if (keys.length > 0) {
          return keys;
        }
      } catch {
        // Try the next day fallback.
      }
    }

    return [];
  }

  async emitFromChunk(site, key) {
    const ingestTime = new Date().toISOString();
    const volumePrefix = key.split("/").slice(0, 2).join("/") + "/";

    if (this.currentVolumePrefixBySite.get(site) !== volumePrefix) {
      this.currentVolumePrefixBySite.set(site, volumePrefix);
      this.chunkHistory.set(site, []);
      this.setStatus(`${site}: switched to volume ${volumePrefix}`);
    }

    this.setStatus(`${site}: fetching chunk ${key}`);
    const buffer = await fetchObject(chunkBucket, key);
    const parsedChunk = await new Level2Radar(buffer, { logger: false });
    const history = this.chunkHistory.get(site) ?? [];
    const nextHistory = [...history, parsedChunk].slice(-12);
    this.chunkHistory.set(site, nextHistory);
    const combined = Level2Radar.combineData(...nextHistory);
    const { radials, diagnostics } = extractSweepRadialsFromRadar(
      combined,
      site,
      key,
      "chunks",
      ingestTime
    );

    this.setStatus(
      `${site}: decoded ${key} -> ${radials.length} radials (${summarizeDiagnostics(diagnostics)})`
    );

    if (radials.length === 0) {
      return;
    }

    const radialsBySweep = new Map();

    for (const radial of radials) {
      const sweepKey = createSweepStateKey(radial);

      if (!radialsBySweep.has(sweepKey)) {
        radialsBySweep.set(sweepKey, []);
      }

      radialsBySweep.get(sweepKey).push(radial);
    }

    for (const [sweepKey, sweepRadials] of radialsBySweep.entries()) {
      let sweepState = this.activeSweepStates.get(sweepKey);

      if (!sweepState) {
        sweepState = createSweepState(sweepRadials[0]);
        this.activeSweepStates.set(sweepKey, sweepState);
      }

      const update = applyRadialsToSweepState(sweepState, sweepRadials);

      if (!update) {
        continue;
      }

      const sequencedUpdate = this.updateRadarStateCache(update, sweepRadials);
      this.latestSweepKeyBySource.set(sequencedUpdate.frame.sourceId, sweepKey);
      const rollingFieldKey = createRollingFieldStateKey(sweepRadials[0]);
      let rollingFieldState = this.rollingFieldStates.get(rollingFieldKey);

      if (!rollingFieldState) {
        rollingFieldState = createRollingFieldState(sweepRadials[0]);
        this.rollingFieldStates.set(rollingFieldKey, rollingFieldState);
      }

      rollingFieldState.volumeId = sequencedUpdate.frame.volumeId;
      rollingFieldState.siteLatitude = sequencedUpdate.frame.siteLatitude;
      rollingFieldState.siteLongitude = sequencedUpdate.frame.siteLongitude;
      rollingFieldState.ingestLane = sequencedUpdate.frame.ingestLane;
      rollingFieldState.renderHint = sequencedUpdate.frame.renderHint;
      applyRadialsToSweepState(rollingFieldState, sweepRadials);
      rollingFieldState.lastManifest = {
        ...sequencedUpdate.frame,
        radialCount: rollingFieldState.radialCount,
        gateCount: rollingFieldState.gateCount
      };
      this.latestRollingFieldKeyBySource.set(sequencedUpdate.frame.sourceId, rollingFieldKey);
      this.emit(sequencedUpdate);
    }
  }

  async emitFromArchive(site, key) {
    const ingestTime = new Date().toISOString();
    this.setStatus(`${site}: fetching archive ${key}`);
    const buffer = await fetchObject(archiveBucket, key);
    const { radials, diagnostics } = await decodeArchive(buffer, site, key, "archive", ingestTime);
    this.setStatus(
      `${site}: decoded archive ${key} -> ${radials.length} radials (${summarizeDiagnostics(diagnostics)})`
    );

    if (radials.length === 0) {
      return;
    }

    const radialsBySweep = new Map();

    for (const radial of radials) {
      const sweepKey = createSweepStateKey(radial);

      if (!radialsBySweep.has(sweepKey)) {
        radialsBySweep.set(sweepKey, []);
      }

      radialsBySweep.get(sweepKey).push(radial);
    }

    for (const [sweepKey, sweepRadials] of radialsBySweep.entries()) {
      let sweepState = this.activeSweepStates.get(sweepKey);

      if (!sweepState) {
        sweepState = createSweepState(sweepRadials[0]);
        this.activeSweepStates.set(sweepKey, sweepState);
      }

      const update = applyRadialsToSweepState(sweepState, sweepRadials);

      if (!update) {
        continue;
      }

      const sequencedUpdate = this.updateRadarStateCache(update, sweepRadials);
      this.latestSweepKeyBySource.set(sequencedUpdate.frame.sourceId, sweepKey);
      const rollingFieldKey = createRollingFieldStateKey(sweepRadials[0]);
      let rollingFieldState = this.rollingFieldStates.get(rollingFieldKey);

      if (!rollingFieldState) {
        rollingFieldState = createRollingFieldState(sweepRadials[0]);
        this.rollingFieldStates.set(rollingFieldKey, rollingFieldState);
      }

      rollingFieldState.volumeId = sequencedUpdate.frame.volumeId;
      rollingFieldState.siteLatitude = sequencedUpdate.frame.siteLatitude;
      rollingFieldState.siteLongitude = sequencedUpdate.frame.siteLongitude;
      rollingFieldState.ingestLane = sequencedUpdate.frame.ingestLane;
      rollingFieldState.renderHint = sequencedUpdate.frame.renderHint;
      applyRadialsToSweepState(rollingFieldState, sweepRadials);
      rollingFieldState.lastManifest = {
        ...sequencedUpdate.frame,
        radialCount: rollingFieldState.radialCount,
        gateCount: rollingFieldState.gateCount
      };
      this.latestRollingFieldKeyBySource.set(sequencedUpdate.frame.sourceId, rollingFieldKey);
      this.emit(sequencedUpdate);
    }
  }

  async pollSite(site) {
    const sourceId = `${site.toLowerCase()}-ref`;
    const chunkCandidates = await this.loadChunkCandidates(site);
    const sortedChunkCandidates = chunkCandidates.slice().sort();
    const unseenChunks = sortedChunkCandidates.filter((key) => !this.seenKeys.has(`chunks:${key}`));
    const latestChunkKey = sortedChunkCandidates.at(-1) ?? null;
    const latestVolumeId = latestChunkKey ? latestChunkKey.split("/").slice(0, 3).join("/") : null;
    const latestManifest = this.latestManifestBySource.get(sourceId) ?? null;
    const currentVolumeBootstrapped =
      latestVolumeId != null && latestManifest?.volumeId === latestVolumeId;

    if (unseenChunks.length > 0) {
      const chunkQueue = currentVolumeBootstrapped
        ? unseenChunks.slice(-12)
        : sortedChunkCandidates
            .slice(-12)
            .filter((key) => !this.seenKeys.has(`chunks:${key}`));

      for (const chunkKey of chunkQueue) {
        this.seenKeys.add(`chunks:${chunkKey}`);
        await this.emitFromChunk(site, chunkKey);
      }
      return;
    }

    this.setStatus(`${site}: no unseen chunks in latest volume, trying archive fallback`);
    this.latestChunkPrefixCheckedAt.set(site, 0);
    const archiveCandidates = await this.loadArchiveCandidates(site);
    const newestArchive = archiveCandidates
      .filter((key) => !this.seenKeys.has(`archive:${key}`))
      .sort()
      .at(-1);

    if (!newestArchive) {
      this.setStatus(`${site}: no archive candidate available`);
      return;
    }

    this.seenKeys.add(`archive:${newestArchive}`);
    await this.emitFromArchive(site, newestArchive);
  }

  async refreshSite(site) {
    const existingPoll = this.inFlightPolls.get(site);

    if (existingPoll) {
      return existingPoll;
    }

    let task;
    task = (async () => {
      try {
        await this.pollSite(site);
        return true;
      } catch (error) {
        console.error(`Radar poll failed for ${site}:`, error);
        return false;
      } finally {
        if (this.inFlightPolls.get(site) === task) {
          this.inFlightPolls.delete(site);
        }
      }
    })();

    this.inFlightPolls.set(site, task);
    return task;
  }

  async loop() {
    while (this.running) {
      if (this.sites.length === 0) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      await Promise.all(
        this.sites.map(async (site) => this.refreshSite(site))
      );

      await sleep(this.pollIntervalMs);
    }
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loop().catch((error) => {
      console.error("Radar ingest loop stopped:", error);
      this.running = false;
    });
  }
}
