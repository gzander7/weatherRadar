import { memo, useEffect, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type ImageSource,
  type LngLatLike,
  type Map as MapLibreMap,
  type StyleSpecification
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { focusPoints, radarFramesBySource, radarSites } from "../lib/radarMapData";
import {
  buildPolarRadialsFromBins,
  collectPatchPolarRadials,
  createPolarFieldState,
  patchPolarFieldState,
  sortPolarRadials,
  type PolarFieldState
} from "../lib/radarPolarField";
import {
  normalizeAngleDegrees,
  projectRangeAzimuthToScreen,
  type GeoPoint
} from "../lib/radarProjection";
import {
  RadarMapLibreCustomLayerRenderer,
  radarCustomLayerId
} from "../lib/radarMapLibreCustomLayerRenderer";
import { RadarWebglRenderer, type RadarWebglDebugMode } from "../lib/radarWebglRenderer";
import { SweepBeamController } from "../lib/sweepBeamController";
import type {
  LiveRadarFrameManifest,
  LiveRadarRadialBatch,
  RadarSourceKind
} from "../lib/types";

interface RadarMapProps {
  sourceId: string;
  sourceKind: RadarSourceKind;
  selectableSites?: SelectableRadarSite[];
  activeSourceId?: string;
  onSourceSelect?: (sourceId: string) => void;
  frameManifest?: LiveRadarFrameManifest;
  liveUpdate?: LiveRadarRadialBatch;
  bootstrapField?: LiveRadarRadialBatch;
  allowSyntheticFallback?: boolean;
  rotationPeriodMs?: number;
}

export interface SelectableRadarSite {
  sourceId: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
}

interface RadarSiteRenderContext {
  site: GeoPoint;
  rangeKm: number;
  label: string;
}

interface InteractionTransformState {
  site: GeoPoint;
  startZoom: number;
  startPoint: { x: number; y: number };
}

const baseStyle: StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors"
    }
  },
  layers: [
    {
      id: "osm",
      type: "raster",
      source: "osm"
    }
  ]
};

const defaultSweepRotationPeriodMs = 4500;
const defaultSweepTrailDegrees = 24;
const defaultSweepHeadWidthDegrees = 6;
const radarDebugModes = (() => {
  if (typeof window === "undefined") {
    return new Set<string>();
  }

  const raw = new URLSearchParams(window.location.search).get("radarDebug") ?? "";
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
})();
const flatRadarDebugMode = radarDebugModes.has("flat");
const slotRadarDebugMode = radarDebugModes.has("slots");
const radialGeometryDebugMode = radarDebugModes.has("radials");
const noDataRadarDebugMode = radarDebugModes.has("nodata");
const boundaryRadarDebugMode = radarDebugModes.has("bounds");
const interactionRadarDebugMode = radarDebugModes.has("interaction");
const screenSpaceRadarFallbackMode = radarDebugModes.has("screen");
const defaultRadialOverlapPaddingDegrees = 0.08;
const selectableRadarSitesSourceId = "radar-sites-selectable";
const selectableRadarSitesCircleLayerId = "radar-sites-selectable-circle";
const selectableRadarSitesLabelLayerId = "radar-sites-selectable-label";

function radarWebglDebugMode(): RadarWebglDebugMode {
  if (noDataRadarDebugMode) {
    return "nodata";
  }

  if (radialGeometryDebugMode) {
    return "radials";
  }

  if (flatRadarDebugMode) {
    return "flat";
  }

  return "reflectivity";
}

function buildSelectableRadarSitesGeoJson(
  sites: SelectableRadarSite[],
  activeSourceId: string
) {
  return {
    type: "FeatureCollection" as const,
    features: sites.map((site) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [site.longitude, site.latitude] as [number, number]
      },
      properties: {
        sourceId: site.sourceId,
        code: site.code,
        name: site.name,
        active: site.sourceId === activeSourceId
      }
    }))
  };
}

function updateSelectableRadarSitesSource(
  map: MapLibreMap,
  sites: SelectableRadarSite[],
  activeSourceId: string
) {
  const data = buildSelectableRadarSitesGeoJson(sites, activeSourceId);
  const source = map.getSource(selectableRadarSitesSourceId) as GeoJSONSource | undefined;

  if (source) {
    source.setData(data);
  }
}

function ensureSelectableRadarSiteLayers(
  map: MapLibreMap,
  sites: SelectableRadarSite[],
  activeSourceId: string
) {
  const data = buildSelectableRadarSitesGeoJson(sites, activeSourceId);

  if (!map.getSource(selectableRadarSitesSourceId)) {
    map.addSource(selectableRadarSitesSourceId, {
      type: "geojson",
      data
    });
  } else {
    updateSelectableRadarSitesSource(map, sites, activeSourceId);
  }

  if (!map.getLayer(selectableRadarSitesCircleLayerId)) {
    map.addLayer({
      id: selectableRadarSitesCircleLayerId,
      type: "circle",
      source: selectableRadarSitesSourceId,
      paint: {
        "circle-radius": ["case", ["boolean", ["get", "active"], false], 10, 7],
        "circle-color": ["case", ["boolean", ["get", "active"], false], "#dff6ff", "#6dbdff"],
        "circle-opacity": ["case", ["boolean", ["get", "active"], false], 0.98, 0.72],
        "circle-stroke-color": ["case", ["boolean", ["get", "active"], false], "#122942", "#07111f"],
        "circle-stroke-width": ["case", ["boolean", ["get", "active"], false], 3, 2]
      }
    });
  }

  if (!map.getLayer(selectableRadarSitesLabelLayerId)) {
    map.addLayer({
      id: selectableRadarSitesLabelLayerId,
      type: "symbol",
      source: selectableRadarSitesSourceId,
      layout: {
        "text-field": ["get", "code"],
        "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
        "text-size": ["case", ["boolean", ["get", "active"], false], 13, 11],
        "text-anchor": "left",
        "text-offset": [1.1, 0],
        "text-allow-overlap": true
      },
      paint: {
        "text-color": ["case", ["boolean", ["get", "active"], false], "#ffffff", "#c9e6ff"],
        "text-halo-color": "rgba(5, 14, 26, 0.92)",
        "text-halo-width": 1.4
      }
    });
  }
}

function rollingFieldKey(
  sourceId: string,
  frame: Pick<LiveRadarFrameManifest, "site" | "tiltIndex" | "product"> | undefined
) {
  return [
    sourceId,
    frame?.site ?? siteIdFromSourceId(sourceId).toUpperCase(),
    frame?.tiltIndex ?? 0,
    frame?.product ?? "reflectivity"
  ].join(":");
}

function batchUpdateKey(batch: LiveRadarRadialBatch | undefined) {
  if (!batch) {
    return null;
  }

  return [
    rollingFieldKey(batch.frame.sourceId, batch.frame),
    batch.frame.volumeId ?? batch.frame.id,
    batch.frame.chunkSequence
  ].join(":");
}

function fieldIdentity(
  sourceId: string,
  frame: Pick<LiveRadarFrameManifest, "site" | "tiltIndex" | "product"> | undefined,
  useFallback: boolean
) {
  return `${rollingFieldKey(sourceId, frame)}:${useFallback ? "fallback" : "live"}`;
}

function siteIdFromSourceId(sourceId: string) {
  return sourceId.split("-")[0].toLowerCase();
}

function findRadarSite(sourceId: string, liveFrame?: LiveRadarFrameManifest) {
  const siteId = liveFrame?.site?.toLowerCase() ?? siteIdFromSourceId(sourceId);
  return radarSites.find((entry) => entry.id === siteId) ?? null;
}

function resolveRadarRenderSite(sourceId: string, liveFrame?: LiveRadarFrameManifest) {
  const knownSite = findRadarSite(sourceId, liveFrame);
  const siteId = liveFrame?.site ?? knownSite?.id ?? siteIdFromSourceId(sourceId);
  const site =
    liveFrame?.siteLatitude != null && liveFrame?.siteLongitude != null
      ? {
          latitude: liveFrame.siteLatitude,
          longitude: liveFrame.siteLongitude
        }
      : knownSite
        ? {
            latitude: knownSite.latitude,
            longitude: knownSite.longitude
          }
        : null;

  if (!site) {
    return null;
  }

  return {
    site,
    rangeKm: knownSite?.rangeKm ?? 180,
    label: siteId.toUpperCase()
  } satisfies RadarSiteRenderContext;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function radarMapPropsSignature(props: Pick<RadarMapProps, "sourceId" | "sourceKind" | "frameManifest" | "liveUpdate" | "bootstrapField" | "allowSyntheticFallback">) {
  const frame = props.frameManifest ?? props.liveUpdate?.frame ?? props.bootstrapField?.frame;
  const frameKey = frame
    ? `${frame.sourceId ?? "none"}:${frame.sequence ?? 0}:${frame.tiltIndex ?? 0}:${frame.chunkSequence ?? 0}`
    : "none";
  const liveKey = props.liveUpdate
    ? `${props.liveUpdate.frame.sourceId}:${props.liveUpdate.sequence ?? 0}:${props.liveUpdate.radials.length}`
    : "none";
  const bootstrapKey = props.bootstrapField
    ? `${props.bootstrapField.frame.sourceId}:${props.bootstrapField.sequence ?? 0}:${props.bootstrapField.radials.length}`
    : "none";

  return `${props.sourceId}:${props.sourceKind}:${frameKey}:${liveKey}:${bootstrapKey}:${props.allowSyntheticFallback ? 1 : 0}`;
}

function latestBatchSweepAngle(batch?: LiveRadarRadialBatch) {
  const latestRadial = batch?.radials.at(-1);

  if (!latestRadial) {
    return null;
  }

  if (finiteNumber(latestRadial.azimuthEnd)) {
    return normalizeAngleDegrees(latestRadial.azimuthEnd);
  }

  if (finiteNumber(latestRadial.azimuthStart)) {
    return normalizeAngleDegrees(latestRadial.azimuthStart);
  }

  return null;
}

function frameSweepAngle(frame?: LiveRadarFrameManifest) {
  if (!frame) {
    return null;
  }

  if (finiteNumber(frame.sweepEndAzimuth)) {
    return normalizeAngleDegrees(frame.sweepEndAzimuth);
  }

  if (finiteNumber(frame.sweepStartAzimuth)) {
    return normalizeAngleDegrees(frame.sweepStartAzimuth);
  }

  return null;
}

function resolveDataSweepAngle(state: {
  frameManifest?: LiveRadarFrameManifest;
  liveUpdate?: LiveRadarRadialBatch;
  bootstrapField?: LiveRadarRadialBatch;
}) {
  return (
    latestBatchSweepAngle(state.liveUpdate) ??
    frameSweepAngle(state.frameManifest) ??
    latestBatchSweepAngle(state.bootstrapField) ??
    frameSweepAngle(state.bootstrapField?.frame)
  );
}

function webMercatorMeters(lng: number, lat: number) {
  const originShift = 20037508.34;
  const boundedLat = Math.max(-85, Math.min(85, lat));
  const x = (lng * originShift) / 180;
  const y =
    Math.log(Math.tan(((90 + boundedLat) * Math.PI) / 360)) / (Math.PI / 180);

  return {
    x,
    y: (y * originShift) / 180
  };
}

function buildMrmsExportUrl(map: MapLibreMap, bounds: maplibregl.LngLatBounds, pixelRatio: number) {
  const northWest = webMercatorMeters(bounds.getWest(), bounds.getNorth());
  const southEast = webMercatorMeters(bounds.getEast(), bounds.getSouth());
  const canvas = map.getCanvas();
  const width = Math.min(1600, Math.max(512, Math.round(canvas.clientWidth * pixelRatio)));
  const height = Math.min(1600, Math.max(512, Math.round(canvas.clientHeight * pixelRatio)));

  const params = new URLSearchParams({
    bbox: `${northWest.x},${southEast.y},${southEast.x},${northWest.y}`,
    bboxSR: "102100",
    imageSR: "102100",
    size: `${width},${height}`,
    dpi: pixelRatio > 1 ? "144" : "96",
    format: "png32",
    transparent: "true",
    layers: "show:3",
    f: "image"
  });

  return `https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer/export?${params.toString()}`;
}

function updateMrmsImage(map: MapLibreMap) {
  const bounds = map.getBounds();
  const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
    [bounds.getWest(), bounds.getNorth()],
    [bounds.getEast(), bounds.getNorth()],
    [bounds.getEast(), bounds.getSouth()],
    [bounds.getWest(), bounds.getSouth()]
  ];
  const url = buildMrmsExportUrl(map, bounds, window.devicePixelRatio || 1);
  const source = map.getSource("mrms-live") as ImageSource | undefined;

  if (source) {
    source.updateImage({ url, coordinates });
    return;
  }

  map.addSource("mrms-live", {
    type: "image",
    url,
    coordinates
  });

  map.addLayer({
    id: "mrms-live-layer",
    type: "raster",
    source: "mrms-live",
    paint: {
      "raster-opacity": 0.72,
      "raster-resampling": "nearest"
    }
  });
}

function removeMrmsLayer(map: MapLibreMap) {
  if (map.getLayer("mrms-live-layer")) {
    map.removeLayer("mrms-live-layer");
  }

  if (map.getSource("mrms-live")) {
    map.removeSource("mrms-live");
  }
}

function prepareOverlayCanvas(canvas: HTMLCanvasElement, clearAll = true) {
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return null;
  }

  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  const resized = canvas.width !== width || canvas.height !== height;

  if (resized) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  if (clearAll || resized) {
    ctx.clearRect(0, 0, bounds.width, bounds.height);
  }

  return {
    ctx,
    width: bounds.width,
    height: bounds.height
  };
}

function clearOverlayCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return;
  }

  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, bounds.width, bounds.height);
}

function drawFocusMarkers(
  ctx: CanvasRenderingContext2D,
  map: MapLibreMap,
  sourceId: string
) {
  const siteId = siteIdFromSourceId(sourceId);
  const points = focusPoints.filter((point) => point.sourceSiteId === siteId);

  for (const point of points) {
    const projected = map.project([point.longitude, point.latitude] as LngLatLike);

    ctx.beginPath();
    ctx.arc(projected.x, projected.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#112a4a";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 18px Segoe UI";
    ctx.fillText(point.label, projected.x + 12, projected.y - 2);
    ctx.fillStyle = "rgba(235, 248, 255, 0.82)";
    ctx.font = "600 11px Segoe UI";
    ctx.fillText("focus", projected.x + 13, projected.y + 12);
  }
}

function drawSiteMarker(
  ctx: CanvasRenderingContext2D,
  map: MapLibreMap,
  site: GeoPoint
) {
  const projected = map.project([site.longitude, site.latitude] as LngLatLike);
  ctx.beginPath();
  ctx.arc(projected.x, projected.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#dff6ff";
  ctx.fill();
  ctx.strokeStyle = "rgba(10, 18, 28, 0.85)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawSweepBeam(
  ctx: CanvasRenderingContext2D,
  map: MapLibreMap,
  site: GeoPoint,
  rangeKm: number,
  sweepAngleDegrees: number
) {
  const center = map.project([site.longitude, site.latitude] as LngLatLike);
  const trailSegments = 9;

  for (let index = 0; index < trailSegments; index += 1) {
    const startAngle =
      sweepAngleDegrees -
      defaultSweepTrailDegrees +
      (defaultSweepTrailDegrees * index) / trailSegments;
    const endAngle =
      sweepAngleDegrees -
      defaultSweepTrailDegrees +
      (defaultSweepTrailDegrees * (index + 1)) / trailSegments;
    const left = projectRangeAzimuthToScreen(map, site, startAngle, rangeKm);
    const right = projectRangeAzimuthToScreen(map, site, endAngle, rangeKm);
    const progress = (index + 1) / trailSegments;
    const alpha = 0.02 + progress * progress * 0.12;

    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fillStyle = `rgba(126, 224, 255, ${alpha.toFixed(3)})`;
    ctx.fill();
  }

  const headLeft = projectRangeAzimuthToScreen(
    map,
    site,
    sweepAngleDegrees - defaultSweepHeadWidthDegrees,
    rangeKm
  );
  const headRight = projectRangeAzimuthToScreen(
    map,
    site,
    sweepAngleDegrees + defaultSweepHeadWidthDegrees,
    rangeKm
  );
  const beamTip = projectRangeAzimuthToScreen(map, site, sweepAngleDegrees, rangeKm);

  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(headLeft.x, headLeft.y);
  ctx.lineTo(headRight.x, headRight.y);
  ctx.closePath();
  ctx.fillStyle = "rgba(126, 224, 255, 0.2)";
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(beamTip.x, beamTip.y);
  ctx.strokeStyle = "rgba(126, 224, 255, 0.35)";
  ctx.lineWidth = 6;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(beamTip.x, beamTip.y);
  ctx.strokeStyle = "rgba(214, 247, 255, 0.98)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function RadarMapInner({
  sourceId,
  sourceKind,
  selectableSites = [],
  activeSourceId = sourceId,
  onSourceSelect,
  frameManifest,
  liveUpdate,
  bootstrapField,
  allowSyntheticFallback = false,
  rotationPeriodMs = defaultSweepRotationPeriodMs
}: RadarMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fieldCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sweepCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const fieldRendererRef = useRef<RadarWebglRenderer | null>(null);
  const customFieldRendererRef = useRef<RadarMapLibreCustomLayerRenderer | null>(null);
  const sweepControllerRef = useRef<SweepBeamController | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const drawSweepRef = useRef<(() => void) | null>(null);
  const frameRef = useRef<number | null>(null);
  const sweepFrameRef = useRef<number | null>(null);
  const transformFrameRef = useRef<number | null>(null);
  const mrmsRefreshTimerRef = useRef<number | null>(null);
  const sweepAngleDegreesRef = useRef(0);
  const needsFullFieldRedrawRef = useRef(true);
  const fieldIdentityRef = useRef<string | null>(null);
  const interactionActiveRef = useRef(false);
  const interactionTransformRef = useRef<InteractionTransformState | null>(null);
  const interactionRenderCountRef = useRef(0);
  const lastFullRedrawMsRef = useRef<number | null>(null);
  const [interactionDebugActive, setInteractionDebugActive] = useState(false);
  const [interactionDebugStats, setInteractionDebugStats] = useState({
    transformActive: false,
    renderCount: 0,
    lastFullRedrawMs: null as number | null,
    customLayerRenderCount: 0,
    customLayerDataRebuildCount: 0,
    customLayerFps: 0
  });
  const polarFieldCacheRef = useRef(new Map<string, PolarFieldState>());
  const lastRenderSignatureRef = useRef<string | null>(null);
  const lastAppliedBootstrapRef = useRef(new Map<string, string>());
  const lastAppliedLiveUpdateRef = useRef(new Map<string, string>());
  const selectionRef = useRef({
    activeSourceId,
    selectableSites,
    onSourceSelect
  });
  const stateRef = useRef({
    sourceId,
    sourceKind,
    frameManifest,
    liveUpdate,
    bootstrapField,
    allowSyntheticFallback
  });

  const debugBatch = liveUpdate ?? bootstrapField;
  const debugLines = slotRadarDebugMode && debugBatch
    ? debugBatch.radials.slice(0, 8).map((radial) => {
        const assignedSlot = radial.assignedSlotIndex ?? radial.radialIndex;
        const sourceRadial = radial.sourceRadialIndex ?? radial.radialIndex;
        return `src ${sourceRadial} -> slot ${assignedSlot} az ${radial.azimuthStart.toFixed(2)}-${radial.azimuthEnd.toFixed(2)} vol ${(debugBatch.frame.volumeId ?? "none").slice(-12)} tilt ${debugBatch.frame.tiltIndex}`;
      })
    : [];

  const debugInteraction = (...values: unknown[]) => {
    if (!interactionRadarDebugMode) {
      return;
    }

    console.debug("[RadarInteraction]", ...values);
  };

  const customLayerStats = () => (
    customFieldRendererRef.current?.getStats() ?? {
      renderCount: 0,
      dataRebuildCount: 0,
      lastDataRebuildMs: null,
      fpsEstimate: 0,
      lastFrameKind: "idle" as const
    }
  );

  const refreshInteractionDebugStats = () => {
    if (!interactionRadarDebugMode) {
      return;
    }

    const stats = customLayerStats();
    setInteractionDebugStats({
      transformActive: Boolean(interactionTransformRef.current),
      renderCount: interactionRenderCountRef.current,
      lastFullRedrawMs: stats.lastDataRebuildMs ?? lastFullRedrawMsRef.current,
      customLayerRenderCount: stats.renderCount,
      customLayerDataRebuildCount: stats.dataRebuildCount,
      customLayerFps: stats.fpsEstimate
    });
  };

  selectionRef.current = {
    activeSourceId,
    selectableSites,
    onSourceSelect
  };

  stateRef.current = {
    sourceId,
    sourceKind,
    frameManifest,
    liveUpdate,
    bootstrapField,
    allowSyntheticFallback
  };

  useEffect(() => {
    if (!containerRef.current || !fieldCanvasRef.current || !sweepCanvasRef.current || mapRef.current) {
      return;
    }

    const site = findRadarSite(sourceId);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: baseStyle,
      center: [site?.longitude ?? -93.7228, site?.latitude ?? 41.7311],
      zoom: sourceKind === "mrms" ? 4 : 6,
      attributionControl: false,
      interactive: true,
      dragPan: true,
      dragRotate: false,
      scrollZoom: true,
      doubleClickZoom: true,
      touchZoomRotate: true,
      pitchWithRotate: false
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    fieldRendererRef.current = screenSpaceRadarFallbackMode
      ? new RadarWebglRenderer(fieldCanvasRef.current)
      : null;
    customFieldRendererRef.current = screenSpaceRadarFallbackMode
      ? null
      : new RadarMapLibreCustomLayerRenderer();
    sweepControllerRef.current = new SweepBeamController(rotationPeriodMs);

    const applyBasemapMood = () => {
      if (!map.getLayer("osm")) {
        return;
      }

      if (stateRef.current.sourceKind === "mrms") {
        map.setPaintProperty("osm", "raster-opacity", 1);
        map.setPaintProperty("osm", "raster-saturation", 0);
        map.setPaintProperty("osm", "raster-contrast", 0);
        return;
      }

      map.setPaintProperty("osm", "raster-opacity", 0.56);
      map.setPaintProperty("osm", "raster-saturation", -0.88);
      map.setPaintProperty("osm", "raster-contrast", -0.28);
    };

    const clearFieldInteractionTransform = () => {
      const fieldCanvas = fieldCanvasRef.current;

      if (!fieldCanvas) {
        return;
      }

      fieldCanvas.style.transform = "";
      fieldCanvas.style.transformOrigin = "";
      fieldCanvas.style.willChange = "";
    };

    const applyFieldInteractionTransform = () => {
      const fieldCanvas = fieldCanvasRef.current;
      const transformState = interactionTransformRef.current;

      if (
        customFieldRendererRef.current ||
        !fieldCanvas ||
        !transformState ||
        stateRef.current.sourceKind === "mrms"
      ) {
        return;
      }

      const currentPoint = map.project([
        transformState.site.longitude,
        transformState.site.latitude
      ] as LngLatLike);
      const scale = 2 ** (map.getZoom() - transformState.startZoom);
      const translateX = currentPoint.x - transformState.startPoint.x * scale;
      const translateY = currentPoint.y - transformState.startPoint.y * scale;

      fieldCanvas.style.transformOrigin = "0 0";
      fieldCanvas.style.willChange = "transform";
      fieldCanvas.style.transform = `translate(${translateX.toFixed(2)}px, ${translateY.toFixed(2)}px) scale(${scale.toFixed(5)})`;
    };

    const scheduleFieldInteractionTransform = () => {
      if (transformFrameRef.current !== null) {
        return;
      }

      transformFrameRef.current = window.requestAnimationFrame(() => {
        transformFrameRef.current = null;
        applyFieldInteractionTransform();
      });
    };

    const redrawSweepOverlay = (angleOverride?: number) => {
      const sweepCanvas = sweepCanvasRef.current;

      if (!sweepCanvas) {
        return;
      }

      if (!map.isStyleLoaded() || stateRef.current.sourceKind === "mrms" || flatRadarDebugMode) {
        clearOverlayCanvas(sweepCanvas);
        return;
      }

      const liveFrame =
        stateRef.current.frameManifest ??
        stateRef.current.liveUpdate?.frame ??
        stateRef.current.bootstrapField?.frame;
      const renderSite = resolveRadarRenderSite(stateRef.current.sourceId, liveFrame);
      const overlayState = prepareOverlayCanvas(sweepCanvas, true);
      const sweepAngleDegrees =
        resolveDataSweepAngle(stateRef.current) ??
        angleOverride ??
        sweepAngleDegreesRef.current;

      if (!overlayState || !renderSite) {
        clearOverlayCanvas(sweepCanvas);
        return;
      }

      drawSweepBeam(
        overlayState.ctx,
        map,
        renderSite.site,
        renderSite.rangeKm,
        sweepAngleDegrees
      );
      drawFocusMarkers(overlayState.ctx, map, stateRef.current.sourceId);
      drawSiteMarker(overlayState.ctx, map, renderSite.site);
    };

    const scheduleSweepOverlayRedraw = (angleOverride?: number) => {
      if (typeof angleOverride === "number") {
        sweepAngleDegreesRef.current = angleOverride;
      }

      if (sweepFrameRef.current !== null) {
        return;
      }

      sweepFrameRef.current = window.requestAnimationFrame(() => {
        sweepFrameRef.current = null;
        redrawSweepOverlay();
      });
    };

    const redrawField = () => {
      try {
        const screenRenderer = fieldRendererRef.current;
        const customRenderer = customFieldRendererRef.current;

        if (!map.isStyleLoaded() || (!screenRenderer && !customRenderer)) {
          return;
        }

        const redrawStartMs = performance.now();

        applyBasemapMood();

        if (stateRef.current.sourceKind === "mrms") {
          screenRenderer?.clear();
          customRenderer?.clear();
          removeMrmsLayer(map);
          updateMrmsImage(map);
          return;
        }

        removeMrmsLayer(map);

        const liveFrame =
          stateRef.current.frameManifest ??
          stateRef.current.liveUpdate?.frame ??
          stateRef.current.bootstrapField?.frame;
        const renderSite = resolveRadarRenderSite(stateRef.current.sourceId, liveFrame);
        const fieldSignature = fieldIdentity(
          stateRef.current.sourceId,
          liveFrame,
          stateRef.current.allowSyntheticFallback
        );
        let forceFullRedraw = needsFullFieldRedrawRef.current;
        needsFullFieldRedrawRef.current = false;

        if (fieldIdentityRef.current !== fieldSignature) {
          fieldIdentityRef.current = fieldSignature;
          forceFullRedraw = true;
        }

        if (liveFrame && renderSite) {
          const currentFieldKey = rollingFieldKey(stateRef.current.sourceId, liveFrame);
          let fieldCache = polarFieldCacheRef.current.get(currentFieldKey);

          if (!fieldCache) {
            fieldCache = createPolarFieldState(liveFrame);
            polarFieldCacheRef.current.set(currentFieldKey, fieldCache);
          }

          const bootstrapMatchesField =
            stateRef.current.bootstrapField &&
            rollingFieldKey(
              stateRef.current.bootstrapField.frame.sourceId,
              stateRef.current.bootstrapField.frame
            ) === currentFieldKey;
          const bootstrapKey = bootstrapMatchesField
            ? batchUpdateKey(stateRef.current.bootstrapField)
            : null;

          if (
            bootstrapMatchesField &&
            stateRef.current.bootstrapField &&
            bootstrapKey &&
            lastAppliedBootstrapRef.current.get(currentFieldKey) !== bootstrapKey
          ) {
            patchPolarFieldState(
              fieldCache,
              stateRef.current.sourceId,
              stateRef.current.bootstrapField.frame,
              stateRef.current.bootstrapField.radials
            );
            lastAppliedBootstrapRef.current.set(currentFieldKey, bootstrapKey);
            forceFullRedraw = true;
          }

          const liveMatchesField =
            stateRef.current.liveUpdate &&
            rollingFieldKey(
              stateRef.current.liveUpdate.frame.sourceId,
              stateRef.current.liveUpdate.frame
            ) === currentFieldKey;
          const liveUpdateKey = liveMatchesField ? batchUpdateKey(stateRef.current.liveUpdate) : null;

          let patchRadials: ReturnType<typeof collectPatchPolarRadials> | undefined;

          if (
            liveMatchesField &&
            stateRef.current.liveUpdate &&
            liveUpdateKey &&
            lastAppliedLiveUpdateRef.current.get(currentFieldKey) !== liveUpdateKey
          ) {
            const changedRadials = patchPolarFieldState(
              fieldCache,
              stateRef.current.sourceId,
              stateRef.current.liveUpdate.frame,
              stateRef.current.liveUpdate.radials
            );

            if (!forceFullRedraw && changedRadials.length > 0) {
              patchRadials = collectPatchPolarRadials(
                fieldCache,
                changedRadials,
                liveFrame.radialCount ?? fieldCache.radialsByIndex.size,
                1
              );
            }

            lastAppliedLiveUpdateRef.current.set(currentFieldKey, liveUpdateKey);
          }

          const allRadials = sortPolarRadials(fieldCache.radialsByIndex.values());

          if (allRadials.length === 0) {
            screenRenderer?.clear();
            customRenderer?.clear();
            return;
          }

          debugInteraction("render field", {
            currentFieldKey,
            forceFullRedraw,
            changedRadialCount: patchRadials?.length ?? 0,
            interactionActive: interactionActiveRef.current
          });

          if (customRenderer) {
            customRenderer.setData({
              site: renderSite.site,
              fieldKey: currentFieldKey,
              allRadials,
              radialCountHint: liveFrame.radialCount ?? fieldCache.radialsByIndex.size,
              radialOverlapPaddingDegrees: defaultRadialOverlapPaddingDegrees,
              forceRebuild: forceFullRedraw || Boolean(patchRadials?.length),
              debugMode: radarWebglDebugMode(),
              debugBoundaryOutlines: boundaryRadarDebugMode
            });
          } else {
            screenRenderer?.render({
              map,
              site: renderSite.site,
              fieldKey: currentFieldKey,
              allRadials,
              changedRadials: patchRadials,
              radialCountHint: liveFrame.radialCount ?? fieldCache.radialsByIndex.size,
              radialOverlapPaddingDegrees: defaultRadialOverlapPaddingDegrees,
              forceRebuild: forceFullRedraw,
              debugMode: radarWebglDebugMode(),
              debugBoundaryOutlines: boundaryRadarDebugMode
            });
          }

          lastFullRedrawMsRef.current = performance.now() - redrawStartMs;
          refreshInteractionDebugStats();

          return;
        }

        if (stateRef.current.allowSyntheticFallback) {
          const fallbackFrames = radarFramesBySource[stateRef.current.sourceId] ?? [];
          const fallbackFrame = fallbackFrames[fallbackFrames.length - 1];
          const fallbackSite = findRadarSite(stateRef.current.sourceId);

          if (!fallbackFrame || !fallbackSite) {
            screenRenderer?.clear();
            customRenderer?.clear();
            return;
          }

          const syntheticRadials = buildPolarRadialsFromBins(
            stateRef.current.sourceId,
            fallbackSite.id.toUpperCase(),
            "reflectivity",
            0,
            fallbackFrame.gates
          );

          const fallbackRenderSite = {
            latitude: fallbackSite.latitude,
            longitude: fallbackSite.longitude
          };

          if (customRenderer) {
            customRenderer.setData({
              site: fallbackRenderSite,
              fieldKey: `synthetic:${stateRef.current.sourceId}`,
              allRadials: syntheticRadials,
              radialCountHint: syntheticRadials.length,
              radialOverlapPaddingDegrees: defaultRadialOverlapPaddingDegrees,
              forceRebuild: true,
              debugMode: radarWebglDebugMode(),
              debugBoundaryOutlines: boundaryRadarDebugMode
            });
          } else {
            screenRenderer?.render({
              map,
              site: fallbackRenderSite,
              fieldKey: `synthetic:${stateRef.current.sourceId}`,
              allRadials: syntheticRadials,
              radialCountHint: syntheticRadials.length,
              radialOverlapPaddingDegrees: defaultRadialOverlapPaddingDegrees,
              forceRebuild: true,
              debugMode: radarWebglDebugMode(),
              debugBoundaryOutlines: boundaryRadarDebugMode
            });
          }
          lastFullRedrawMsRef.current = performance.now() - redrawStartMs;
          refreshInteractionDebugStats();
          return;
        }

        screenRenderer?.clear();
        customRenderer?.clear();
      } catch (error) {
        console.error("Radar redraw failed", error);
      }
    };

    const scheduleFieldRedraw = () => {
      if (interactionActiveRef.current) {
        needsFullFieldRedrawRef.current = true;
        debugInteraction("field redraw deferred during interaction");
        return;
      }

      if (frameRef.current !== null) {
        debugInteraction("scheduleFieldRedraw queued", {
          queuedFrame: frameRef.current,
          interactionActive: interactionActiveRef.current
        });
        return;
      }

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        redrawField();
      });
    };

    drawRef.current = scheduleFieldRedraw;
    drawSweepRef.current = scheduleSweepOverlayRedraw;

    map.on("load", () => {
      if (customFieldRendererRef.current && !map.getLayer(radarCustomLayerId)) {
        map.addLayer(customFieldRendererRef.current);
      }

      ensureSelectableRadarSiteLayers(
        map,
        selectionRef.current.selectableSites,
        selectionRef.current.activeSourceId
      );
      redrawField();
      redrawSweepOverlay();

      sweepControllerRef.current?.start(({ angleDegrees }) => {
        scheduleSweepOverlayRedraw(angleDegrees);
      });

      const scheduleProjectedFieldRedraw = () => {
        if (interactionActiveRef.current) {
          scheduleSweepOverlayRedraw();
          if (!customFieldRendererRef.current) {
            scheduleFieldInteractionTransform();
          }
          return;
        }

        if (!customFieldRendererRef.current) {
          needsFullFieldRedrawRef.current = true;
        }
        scheduleSweepOverlayRedraw();
        scheduleFieldRedraw();
      };

      const beginInteraction = () => {
        if (interactionActiveRef.current) {
          return;
        }

        const liveFrame =
          stateRef.current.frameManifest ??
          stateRef.current.liveUpdate?.frame ??
          stateRef.current.bootstrapField?.frame;
        const renderSite = resolveRadarRenderSite(stateRef.current.sourceId, liveFrame);

        interactionActiveRef.current = true;
        interactionRenderCountRef.current = 0;
        interactionTransformRef.current =
          customFieldRendererRef.current || stateRef.current.sourceKind === "mrms" || !renderSite
            ? null
            : {
                site: renderSite.site,
                startZoom: map.getZoom(),
                startPoint: map.project([
                  renderSite.site.longitude,
                  renderSite.site.latitude
                ] as LngLatLike)
              };
        if (!customFieldRendererRef.current) {
          scheduleFieldInteractionTransform();
        }

        if (interactionRadarDebugMode) {
          setInteractionDebugActive(true);
          refreshInteractionDebugStats();
        }
      };

      const endInteraction = () => {
        if (!interactionActiveRef.current) {
          return;
        }

        interactionActiveRef.current = false;
        interactionTransformRef.current = null;
        clearFieldInteractionTransform();

        if (interactionRadarDebugMode) {
          setInteractionDebugActive(false);
          refreshInteractionDebugStats();
        }

        if (!customFieldRendererRef.current) {
          needsFullFieldRedrawRef.current = true;
        }

        if (needsFullFieldRedrawRef.current) {
          redrawField();
        }
        redrawSweepOverlay();
      };

      const syncProjectedFieldToMapFrame = () => {
        if (stateRef.current.sourceKind === "mrms") {
          return;
        }

        if (!customFieldRendererRef.current) {
          scheduleFieldInteractionTransform();
        }
        scheduleSweepOverlayRedraw();
      };

      map.on("move", syncProjectedFieldToMapFrame);
      map.on("zoom", syncProjectedFieldToMapFrame);
      map.on("resize", scheduleProjectedFieldRedraw);

      map.on("movestart", beginInteraction);
      map.on("zoomstart", beginInteraction);

      map.on("moveend", () => {
        if (stateRef.current.sourceKind === "mrms") {
          updateMrmsImage(map);
        }
        endInteraction();
      });

      map.on("zoomend", () => {
        if (stateRef.current.sourceKind === "mrms") {
          updateMrmsImage(map);
        }
        endInteraction();
      });

      mrmsRefreshTimerRef.current = window.setInterval(() => {
        if (stateRef.current.sourceKind === "mrms") {
          updateMrmsImage(map);
        }
      }, 60_000);

      map.on("click", selectableRadarSitesCircleLayerId, (event) => {
        const selectedSourceId = String(event.features?.[0]?.properties?.sourceId ?? "");

        if (!selectedSourceId || selectedSourceId === selectionRef.current.activeSourceId) {
          return;
        }

        selectionRef.current.onSourceSelect?.(selectedSourceId);
      });

      map.on("click", selectableRadarSitesLabelLayerId, (event) => {
        const selectedSourceId = String(event.features?.[0]?.properties?.sourceId ?? "");

        if (!selectedSourceId || selectedSourceId === selectionRef.current.activeSourceId) {
          return;
        }

        selectionRef.current.onSourceSelect?.(selectedSourceId);
      });

      map.on("mouseenter", selectableRadarSitesCircleLayerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", selectableRadarSitesCircleLayerId, () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("mouseenter", selectableRadarSitesLabelLayerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", selectableRadarSitesLabelLayerId, () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }

      if (sweepFrameRef.current !== null) {
        window.cancelAnimationFrame(sweepFrameRef.current);
      }

      if (transformFrameRef.current !== null) {
        window.cancelAnimationFrame(transformFrameRef.current);
      }

      if (mrmsRefreshTimerRef.current !== null) {
        window.clearInterval(mrmsRefreshTimerRef.current);
      }

      sweepControllerRef.current?.stop();
      sweepControllerRef.current = null;
      fieldRendererRef.current?.dispose();
      fieldRendererRef.current = null;
      if (map.getLayer(radarCustomLayerId)) {
        map.removeLayer(radarCustomLayerId);
      }
      customFieldRendererRef.current = null;
      clearFieldInteractionTransform();
      map.remove();
      mapRef.current = null;
      drawRef.current = null;
      drawSweepRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !map.isStyleLoaded()) {
      return;
    }

    ensureSelectableRadarSiteLayers(map, selectableSites, activeSourceId);
  }, [selectableSites, activeSourceId]);

  useEffect(() => {
    sweepControllerRef.current?.setRotationPeriodMs(rotationPeriodMs);
  }, [rotationPeriodMs]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    needsFullFieldRedrawRef.current = true;
    fieldIdentityRef.current = null;
    interactionActiveRef.current = false;
    interactionTransformRef.current = null;
    sweepControllerRef.current?.reset();
    clearOverlayCanvas(sweepCanvasRef.current);
    const fieldCanvas = fieldCanvasRef.current;

    if (fieldCanvas) {
      fieldCanvas.style.transform = "";
      fieldCanvas.style.transformOrigin = "";
      fieldCanvas.style.willChange = "";
    }

    if (sourceKind === "mrms") {
      fieldRendererRef.current?.clear();
      customFieldRendererRef.current?.clear();
      map.easeTo({
        center: [-96.5, 38.5],
        duration: 700,
        zoom: 4
      });
      drawRef.current?.();
      return;
    }

    const site = findRadarSite(sourceId);

    if (!site) {
      return;
    }

    map.stop();
    map.jumpTo({
      center: [site.longitude, site.latitude],
      zoom: 6
    });
    drawRef.current?.();
    drawSweepRef.current?.();
  }, [sourceId, sourceKind]);

  useEffect(() => {
    const redrawSignature = radarMapPropsSignature({
      sourceId,
      sourceKind,
      frameManifest,
      liveUpdate,
      bootstrapField,
      allowSyntheticFallback
    });

    if (lastRenderSignatureRef.current === redrawSignature && !needsFullFieldRedrawRef.current) {
      return;
    }

    lastRenderSignatureRef.current = redrawSignature;
    drawRef.current?.();
    drawSweepRef.current?.();
  }, [sourceId, sourceKind, frameManifest, liveUpdate, bootstrapField, allowSyntheticFallback]);

  return (
    <div className="radar-map-shell">
      <div className="map-container" ref={containerRef} />
      <canvas aria-hidden="true" className="radar-field-overlay" ref={fieldCanvasRef} />
      <canvas aria-hidden="true" className="radar-sweep-overlay" ref={sweepCanvasRef} />
      <div className="map-overlay-meta">
        <span>Basemap: OpenStreetMap raster</span>
        <span>
          Radar render:{" "}
          {sourceKind === "mrms"
            ? "live NOAA MRMS reflectivity"
            : frameManifest || bootstrapField
              ? "WebGL polar texture field"
              : allowSyntheticFallback
                ? "synthetic rapid sweep"
                : "waiting for live Level II frame"}
        </span>
      </div>
      {interactionRadarDebugMode ? (
        <div className="radar-debug-interaction">
          <strong>Radar interaction</strong>
          <span>
            {interactionDebugActive
              ? customFieldRendererRef.current
                ? "active - custom layer camera"
                : "active - transform mode"
              : "idle"}
          </span>
          <span>{`renderer ${customFieldRendererRef.current ? "maplibre custom layer" : "screen canvas"}`}</span>
          <span>{`transform ${interactionDebugStats.transformActive ? "on" : "off"}`}</span>
          <span>{`renders during interaction ${interactionDebugStats.renderCount}`}</span>
          <span>{`custom frames ${interactionDebugStats.customLayerRenderCount}`}</span>
          <span>{`data rebuilds ${interactionDebugStats.customLayerDataRebuildCount}`}</span>
          <span>{`fps est ${interactionDebugStats.customLayerFps}`}</span>
          <span>
            {`last full redraw ${
              interactionDebugStats.lastFullRedrawMs == null
                ? "-"
                : `${interactionDebugStats.lastFullRedrawMs.toFixed(1)} ms`
            }`}
          </span>
        </div>
      ) : null}
      {slotRadarDebugMode ? (
        <div className="radar-debug-overlay">
          <strong>slot debug</strong>
          <span>{`vol ${(debugBatch?.frame.volumeId ?? "none").slice(-12)} tilt ${debugBatch?.frame.tiltIndex ?? "-"} gates ${debugBatch?.frame.gateCount ?? 0}`}</span>
          {debugLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function areRadarMapPropsEqual(prevProps: RadarMapProps, nextProps: RadarMapProps) {
  const prevSelectableSites = prevProps.selectableSites ?? [];
  const nextSelectableSites = nextProps.selectableSites ?? [];
  const selectableSitesEqual =
    prevSelectableSites.length === nextSelectableSites.length &&
    prevSelectableSites.every((site, index) => {
      const nextSite = nextSelectableSites[index];
      if (!nextSite) {
        return false;
      }

      return (
        site.sourceId === nextSite.sourceId &&
        site.latitude === nextSite.latitude &&
        site.longitude === nextSite.longitude
      );
    });

  return (
    prevProps.sourceId === nextProps.sourceId &&
    prevProps.sourceKind === nextProps.sourceKind &&
    prevProps.activeSourceId === nextProps.activeSourceId &&
    selectableSitesEqual &&
    prevProps.allowSyntheticFallback === nextProps.allowSyntheticFallback &&
    prevProps.rotationPeriodMs === nextProps.rotationPeriodMs &&
    prevProps.frameManifest?.id === nextProps.frameManifest?.id &&
    prevProps.frameManifest?.sequence === nextProps.frameManifest?.sequence &&
    prevProps.frameManifest?.chunkSequence === nextProps.frameManifest?.chunkSequence &&
    prevProps.liveUpdate?.sequence === nextProps.liveUpdate?.sequence &&
    prevProps.liveUpdate?.frame?.sequence === nextProps.liveUpdate?.frame?.sequence &&
    prevProps.liveUpdate?.frame?.chunkSequence === nextProps.liveUpdate?.frame?.chunkSequence &&
    prevProps.bootstrapField?.sequence === nextProps.bootstrapField?.sequence &&
    prevProps.bootstrapField?.frame?.sequence === nextProps.bootstrapField?.frame?.sequence &&
    prevProps.bootstrapField?.frame?.chunkSequence === nextProps.bootstrapField?.frame?.chunkSequence
  );
}

export const RadarMap = memo(RadarMapInner, areRadarMapPropsEqual);
