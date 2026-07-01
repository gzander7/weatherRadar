import { useEffect, useRef } from "react";
import maplibregl, {
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
import { projectRangeAzimuthToScreen, type GeoPoint } from "../lib/radarProjection";
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
  frameManifest?: LiveRadarFrameManifest;
  liveUpdate?: LiveRadarRadialBatch;
  bootstrapField?: LiveRadarRadialBatch;
  allowSyntheticFallback?: boolean;
  rotationPeriodMs?: number;
}

interface RadarSiteRenderContext {
  site: GeoPoint;
  rangeKm: number;
}

const baseStyle: StyleSpecification = {
  version: 8,
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
const defaultRadialOverlapPaddingDegrees = 0.08;

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
    rangeKm: knownSite?.rangeKm ?? 180
  } satisfies RadarSiteRenderContext;
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
    ctx.font = "600 24px Segoe UI";
    ctx.fillText(point.label, projected.x + 12, projected.y + 8);
  }
}

function drawSiteMarker(ctx: CanvasRenderingContext2D, map: MapLibreMap, site: GeoPoint) {
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

export function RadarMap({
  sourceId,
  sourceKind,
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
  const sweepControllerRef = useRef<SweepBeamController | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const frameRef = useRef<number | null>(null);
  const mrmsRefreshTimerRef = useRef<number | null>(null);
  const sweepAngleDegreesRef = useRef(0);
  const needsFullFieldRedrawRef = useRef(true);
  const fieldIdentityRef = useRef<string | null>(null);
  const polarFieldCacheRef = useRef(new Map<string, PolarFieldState>());
  const lastAppliedBootstrapRef = useRef(new Map<string, string>());
  const lastAppliedLiveUpdateRef = useRef(new Map<string, string>());
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
      scrollZoom: true,
      doubleClickZoom: true,
      touchZoomRotate: true
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    fieldRendererRef.current = new RadarWebglRenderer(fieldCanvasRef.current);
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

      if (!overlayState || !renderSite) {
        clearOverlayCanvas(sweepCanvas);
        return;
      }

      drawSweepBeam(
        overlayState.ctx,
        map,
        renderSite.site,
        renderSite.rangeKm,
        angleOverride ?? sweepAngleDegreesRef.current
      );
      drawFocusMarkers(overlayState.ctx, map, stateRef.current.sourceId);
      drawSiteMarker(overlayState.ctx, map, renderSite.site);
    };

    const redrawField = () => {
      try {
        if (!map.isStyleLoaded() || !fieldRendererRef.current) {
          return;
        }

        applyBasemapMood();

        if (stateRef.current.sourceKind === "mrms") {
          fieldRendererRef.current.clear();
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
            fieldRendererRef.current.clear();
            return;
          }

          fieldRendererRef.current.render({
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

          return;
        }

        if (stateRef.current.allowSyntheticFallback) {
          const fallbackFrames = radarFramesBySource[stateRef.current.sourceId] ?? [];
          const fallbackFrame = fallbackFrames[fallbackFrames.length - 1];
          const fallbackSite = findRadarSite(stateRef.current.sourceId);

          if (!fallbackFrame || !fallbackSite) {
            fieldRendererRef.current.clear();
            return;
          }

          const syntheticRadials = buildPolarRadialsFromBins(
            stateRef.current.sourceId,
            fallbackSite.id.toUpperCase(),
            "reflectivity",
            0,
            fallbackFrame.gates
          );

          fieldRendererRef.current.render({
            map,
            site: {
              latitude: fallbackSite.latitude,
              longitude: fallbackSite.longitude
            },
            fieldKey: `synthetic:${stateRef.current.sourceId}`,
            allRadials: syntheticRadials,
            radialCountHint: syntheticRadials.length,
            radialOverlapPaddingDegrees: defaultRadialOverlapPaddingDegrees,
            forceRebuild: true,
            debugMode: radarWebglDebugMode(),
            debugBoundaryOutlines: boundaryRadarDebugMode
          });
          return;
        }

        fieldRendererRef.current.clear();
      } catch (error) {
        console.error("Radar redraw failed", error);
      }
    };

    const scheduleFieldRedraw = () => {
      if (frameRef.current !== null) {
        return;
      }

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        redrawField();
      });
    };

    drawRef.current = scheduleFieldRedraw;

    map.on("load", () => {
      redrawField();
      redrawSweepOverlay();

      sweepControllerRef.current?.start(({ angleDegrees }) => {
        sweepAngleDegreesRef.current = angleDegrees;
        redrawSweepOverlay(angleDegrees);
      });

      const scheduleProjectedFieldRedraw = () => {
        needsFullFieldRedrawRef.current = true;
        scheduleFieldRedraw();
        redrawSweepOverlay();
      };

      const syncProjectedFieldToMapFrame = () => {
        if (
          stateRef.current.sourceKind === "mrms" ||
          (!map.isMoving() && !map.isZooming() && !map.isRotating())
        ) {
          return;
        }

        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }

        needsFullFieldRedrawRef.current = true;
        redrawField();
        redrawSweepOverlay();
      };

      map.on("render", syncProjectedFieldToMapFrame);
      map.on("resize", scheduleProjectedFieldRedraw);

      map.on("moveend", () => {
        if (stateRef.current.sourceKind === "mrms") {
          updateMrmsImage(map);
        }
        needsFullFieldRedrawRef.current = true;
        redrawField();
        redrawSweepOverlay();
      });

      map.on("zoomend", () => {
        if (stateRef.current.sourceKind === "mrms") {
          updateMrmsImage(map);
        }
        needsFullFieldRedrawRef.current = true;
        redrawField();
        redrawSweepOverlay();
      });

      mrmsRefreshTimerRef.current = window.setInterval(() => {
        if (stateRef.current.sourceKind === "mrms") {
          updateMrmsImage(map);
        }
      }, 60_000);
    });

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }

      if (mrmsRefreshTimerRef.current !== null) {
        window.clearInterval(mrmsRefreshTimerRef.current);
      }

      sweepControllerRef.current?.stop();
      sweepControllerRef.current = null;
      fieldRendererRef.current?.dispose();
      fieldRendererRef.current = null;
      map.remove();
      mapRef.current = null;
      drawRef.current = null;
    };
  }, []);

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
    sweepControllerRef.current?.reset();
    clearOverlayCanvas(sweepCanvasRef.current);

    if (sourceKind === "mrms") {
      fieldRendererRef.current?.clear();
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
  }, [sourceId, sourceKind]);

  useEffect(() => {
    drawRef.current?.();
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
