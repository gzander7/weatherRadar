import type { LngLatLike, Map as MapLibreMap } from "maplibre-gl";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

export function normalizeAngleDegrees(angle: number) {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function positiveAngleDelta(start: number, end: number) {
  const normalizedStart = normalizeAngleDegrees(start);
  const normalizedEnd = normalizeAngleDegrees(end);
  const delta = normalizedEnd - normalizedStart;

  if (delta >= 0) {
    return delta;
  }

  return normalizedEnd + 360 - normalizedStart;
}

export function angularMidpointDegrees(start: number, end: number) {
  return normalizeAngleDegrees(start + positiveAngleDelta(start, end) / 2);
}

export function destinationPoint(
  latitude: number,
  longitude: number,
  bearingDegrees: number,
  distanceKm: number
) {
  const earthRadiusKm = 6371;
  const angularDistance = distanceKm / earthRadiusKm;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const startLat = (latitude * Math.PI) / 180;
  const startLon = (longitude * Math.PI) / 180;

  const endLat = Math.asin(
    Math.sin(startLat) * Math.cos(angularDistance) +
      Math.cos(startLat) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const endLon =
    startLon +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(startLat),
      Math.cos(angularDistance) - Math.sin(startLat) * Math.sin(endLat)
    );

  return {
    latitude: (endLat * 180) / Math.PI,
    longitude: (endLon * 180) / Math.PI
  };
}

export function projectRangeAzimuthToScreen(
  map: MapLibreMap,
  site: GeoPoint,
  azimuthDegrees: number,
  rangeKm: number
) {
  const coordinate = destinationPoint(
    site.latitude,
    site.longitude,
    normalizeAngleDegrees(azimuthDegrees),
    rangeKm
  );

  return map.project([coordinate.longitude, coordinate.latitude] as LngLatLike);
}

export function buildMapViewSignature(
  map: MapLibreMap,
  width: number,
  height: number,
  devicePixelRatio: number
) {
  const center = map.getCenter();

  return [
    center.lng.toFixed(5),
    center.lat.toFixed(5),
    map.getZoom().toFixed(4),
    map.getBearing().toFixed(3),
    map.getPitch().toFixed(3),
    width,
    height,
    devicePixelRatio.toFixed(2)
  ].join(":");
}
