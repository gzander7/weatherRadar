import type { Map as MapLibreMap } from "maplibre-gl";
import type { PolarRadialData } from "./radarPolarField";
import { normalizeReflectivityValue } from "./reflectivityColorScale";
import {
  angularMidpointDegrees,
  normalizeAngleDegrees,
  projectRangeAzimuthToScreen,
  type GeoPoint
} from "./radarProjection";

const defaultRadialOverlapPaddingDegrees = 0.08;
const maxRadialOverlapPaddingDegrees = 0.25;

export interface RadialAzimuthGeometry {
  overlapPaddingDegrees: number;
  sharedBoundsByRadialIndex: Map<number, { azimuthStart: number; azimuthEnd: number }>;
}

export interface RadarVertexBuildContext {
  azimuth: RadialAzimuthGeometry;
  width: number;
  height: number;
  devicePixelRatio: number;
  radialCountHint?: number;
  radialOverlapPaddingDegrees?: number;
}

export interface RadarPolarTextureMeshData {
  vertexData: Float32Array;
  indexData: Uint32Array | Uint16Array;
  polarTexture: Uint8Array;
  boundaryVertexData: Float32Array;
  radialCellCount: number;
  rangeCellCount: number;
}

export function sortByRadialIndex<T extends { radialIndex: number }>(radials: Iterable<T>) {
  return [...radials].sort((left, right) => left.radialIndex - right.radialIndex);
}

export function shortestAngleDeltaDegrees(from: number, to: number) {
  let delta = normalizeAngleDegrees(to) - normalizeAngleDegrees(from);

  if (delta > 180) {
    delta -= 360;
  }

  if (delta < -180) {
    delta += 360;
  }

  return delta;
}

export function midpointAngleDegrees(left: number, right: number) {
  return normalizeAngleDegrees(left + shortestAngleDeltaDegrees(left, right) / 2);
}

function sortByRadialAzimuth<T extends { azimuthStart: number; azimuthEnd: number }>(radials: Iterable<T>) {
  return [...radials].sort(
    (left, right) =>
      angularMidpointDegrees(left.azimuthStart, left.azimuthEnd) -
      angularMidpointDegrees(right.azimuthStart, right.azimuthEnd)
  );
}

function positiveAngleDelta(start: number, end: number) {
  const delta = normalizeAngleDegrees(end) - normalizeAngleDegrees(start);
  return delta >= 0 ? delta : delta + 360;
}

function clampRadialOverlapPaddingDegrees(paddingDegrees: number | undefined) {
  if (typeof paddingDegrees !== "number" || !Number.isFinite(paddingDegrees)) {
    return defaultRadialOverlapPaddingDegrees;
  }

  return Math.max(0, Math.min(maxRadialOverlapPaddingDegrees, paddingDegrees));
}

function radialCenterDegrees(radial: Pick<PolarRadialData, "azimuthStart" | "azimuthEnd">) {
  return angularMidpointDegrees(radial.azimuthStart, radial.azimuthEnd);
}

function resolveSharedRadialEdgeAngles(
  orderedRadials: Pick<PolarRadialData, "azimuthStart" | "azimuthEnd">[]
) {
  const radialCellCount = orderedRadials.length;
  const edgeAngles = new Array<number>(radialCellCount + 1);

  if (radialCellCount === 0) {
    return edgeAngles;
  }

  if (radialCellCount === 1) {
    const center = radialCenterDegrees(orderedRadials[0]);
    const halfSpan = Math.max(
      0.1,
      positiveAngleDelta(orderedRadials[0].azimuthStart, orderedRadials[0].azimuthEnd) / 2
    );
    edgeAngles[0] = normalizeAngleDegrees(center - halfSpan);
    edgeAngles[1] = normalizeAngleDegrees(center + halfSpan);
    return edgeAngles;
  }

  for (let edgeIndex = 0; edgeIndex < radialCellCount; edgeIndex += 1) {
    const previous = orderedRadials[(edgeIndex - 1 + radialCellCount) % radialCellCount];
    const current = orderedRadials[edgeIndex];
    edgeAngles[edgeIndex] = midpointAngleDegrees(
      radialCenterDegrees(previous),
      radialCenterDegrees(current)
    );
  }

  edgeAngles[radialCellCount] = edgeAngles[0];
  return edgeAngles;
}

export function resolveRadialAzimuthGeometry(
  radials: Iterable<Pick<PolarRadialData, "radialIndex" | "azimuthStart" | "azimuthEnd">>,
  radialCountHint: number | undefined,
  radialOverlapPaddingDegrees = defaultRadialOverlapPaddingDegrees
): RadialAzimuthGeometry {
  const orderedRadials = sortByRadialAzimuth(radials);
  const sharedBoundsByRadialIndex = new Map<number, { azimuthStart: number; azimuthEnd: number }>();
  const overlapPaddingDegrees = clampRadialOverlapPaddingDegrees(radialOverlapPaddingDegrees);
  const fallbackSpan = Math.max(
    0.6,
    radialCountHint && radialCountHint > 0 ? 360 / radialCountHint : 0,
    ...orderedRadials.map((radial) => positiveAngleDelta(radial.azimuthStart, radial.azimuthEnd))
  );

  if (orderedRadials.length === 0) {
    return {
      overlapPaddingDegrees,
      sharedBoundsByRadialIndex
    };
  }

  if (orderedRadials.length === 1) {
    const radial = orderedRadials[0];
    const center = angularMidpointDegrees(radial.azimuthStart, radial.azimuthEnd);
    const halfSpan = Math.max(0.1, fallbackSpan / 2) + overlapPaddingDegrees;

    sharedBoundsByRadialIndex.set(radial.radialIndex, {
      azimuthStart: normalizeAngleDegrees(center - halfSpan),
      azimuthEnd: normalizeAngleDegrees(center + halfSpan)
    });

    return {
      overlapPaddingDegrees,
      sharedBoundsByRadialIndex
    };
  }

  for (let index = 0; index < orderedRadials.length; index += 1) {
    const radial = orderedRadials[index];
    const previous = orderedRadials[index - 1] ?? orderedRadials.at(-1);
    const next = orderedRadials[index + 1] ?? orderedRadials[0];
    const center = angularMidpointDegrees(radial.azimuthStart, radial.azimuthEnd);
    const previousCenter = angularMidpointDegrees(previous.azimuthStart, previous.azimuthEnd);
    const nextCenter = angularMidpointDegrees(next.azimuthStart, next.azimuthEnd);
    const leftEdge = midpointAngleDegrees(previousCenter, center);
    const rightEdge = midpointAngleDegrees(center, nextCenter);

    // Move each edge away from the radial center by a tiny amount to cover GPU raster cracks.
    sharedBoundsByRadialIndex.set(radial.radialIndex, {
      azimuthStart: normalizeAngleDegrees(
        center + shortestAngleDeltaDegrees(center, leftEdge) - overlapPaddingDegrees
      ),
      azimuthEnd: normalizeAngleDegrees(
        center + shortestAngleDeltaDegrees(center, rightEdge) + overlapPaddingDegrees
      )
    });
  }

  return {
    overlapPaddingDegrees,
    sharedBoundsByRadialIndex
  };
}

export function radialAzimuthBounds(
  radial: Pick<PolarRadialData, "radialIndex" | "azimuthStart" | "azimuthEnd">,
  azimuth: RadialAzimuthGeometry
) {
  const sharedBounds = azimuth.sharedBoundsByRadialIndex.get(radial.radialIndex);

  if (sharedBounds) {
    return {
      azimuthStart: sharedBounds.azimuthStart,
      azimuthEnd: sharedBounds.azimuthEnd
    };
  }

  const actualCenter = angularMidpointDegrees(radial.azimuthStart, radial.azimuthEnd);
  const actualSpan = Math.max(0.2, positiveAngleDelta(radial.azimuthStart, radial.azimuthEnd));
  const spanDegrees = actualSpan + azimuth.overlapPaddingDegrees * 2;

  return {
    azimuthStart: normalizeAngleDegrees(actualCenter - spanDegrees / 2),
    azimuthEnd: normalizeAngleDegrees(actualCenter + spanDegrees / 2)
  };
}

function writeVertex(
  target: Float32Array,
  cursor: number,
  x: number,
  y: number,
  value: number
) {
  target[cursor] = x;
  target[cursor + 1] = y;
  target[cursor + 2] = value;
  return cursor + 3;
}

export function buildRadialVertexData(
  map: MapLibreMap,
  site: GeoPoint,
  radial: PolarRadialData,
  context: RadarVertexBuildContext
) {
  const bounds = radialAzimuthBounds(radial, context.azimuth);
  const vertexData = new Float32Array(radial.gateCount * 18);
  let cursor = 0;
  const width = context.width * context.devicePixelRatio;
  const height = context.height * context.devicePixelRatio;
  const margin = 24 * context.devicePixelRatio;
  const azimuthStart = bounds.azimuthStart;
  const azimuthEnd = bounds.azimuthEnd;
  const boundaryCache = new Map<number, {
    leftX: number;
    leftY: number;
    rightX: number;
    rightY: number;
  }>();

  const getBoundary = (rangeKm: number) => {
    const key = Number(rangeKm.toFixed(4));
    const cached = boundaryCache.get(key);

    if (cached) {
      return cached;
    }

    const left = projectRangeAzimuthToScreen(map, site, azimuthStart, rangeKm);
    const right = projectRangeAzimuthToScreen(map, site, azimuthEnd, rangeKm);
    const boundary = {
      leftX: left.x * context.devicePixelRatio,
      leftY: left.y * context.devicePixelRatio,
      rightX: right.x * context.devicePixelRatio,
      rightY: right.y * context.devicePixelRatio
    };

    boundaryCache.set(key, boundary);
    return boundary;
  };

  for (let gateIndex = 0; gateIndex < radial.gateCount; gateIndex += 1) {
    const rawRangeStartKm = radial.rangeStartKm[gateIndex];
    const rawRangeEndKm = radial.rangeEndKm[gateIndex];
    const rangeStartKm = Math.max(0, rawRangeStartKm);
    const rangeEndKm = Math.max(rangeStartKm + 0.01, rawRangeEndKm);
    const value = normalizeReflectivityValue(
      radial.intensity[gateIndex],
      Number.isFinite(radial.reflectivityDbz[gateIndex])
        ? radial.reflectivityDbz[gateIndex]
        : undefined
    );

    const innerBoundary = getBoundary(rangeStartKm);
    const outerBoundary = getBoundary(rangeEndKm);

    const minX = Math.min(
      innerBoundary.leftX,
      innerBoundary.rightX,
      outerBoundary.leftX,
      outerBoundary.rightX
    );
    const maxX = Math.max(
      innerBoundary.leftX,
      innerBoundary.rightX,
      outerBoundary.leftX,
      outerBoundary.rightX
    );
    const minY = Math.min(
      innerBoundary.leftY,
      innerBoundary.rightY,
      outerBoundary.leftY,
      outerBoundary.rightY
    );
    const maxY = Math.max(
      innerBoundary.leftY,
      innerBoundary.rightY,
      outerBoundary.leftY,
      outerBoundary.rightY
    );

    if (maxX < -margin || minX > width + margin || maxY < -margin || minY > height + margin) {
      continue;
    }

    cursor = writeVertex(vertexData, cursor, innerBoundary.leftX, innerBoundary.leftY, value);
    cursor = writeVertex(vertexData, cursor, innerBoundary.rightX, innerBoundary.rightY, value);
    cursor = writeVertex(vertexData, cursor, outerBoundary.rightX, outerBoundary.rightY, value);
    cursor = writeVertex(vertexData, cursor, innerBoundary.leftX, innerBoundary.leftY, value);
    cursor = writeVertex(vertexData, cursor, outerBoundary.rightX, outerBoundary.rightY, value);
    cursor = writeVertex(vertexData, cursor, outerBoundary.leftX, outerBoundary.leftY, value);
  }

  return cursor === vertexData.length ? vertexData : vertexData.subarray(0, cursor);
}

export function buildRadarMeshVertexData(
  map: MapLibreMap,
  site: GeoPoint,
  radials: PolarRadialData[],
  context: RadarVertexBuildContext
) {
  const sortedRadials = sortByRadialIndex(radials);
  const totalGateCount = sortedRadials.reduce((count, radial) => count + radial.gateCount, 0);
  const vertexData = new Float32Array(totalGateCount * 18);
  const pointCache = new Map<string, { x: number; y: number }>();
  const width = context.width * context.devicePixelRatio;
  const height = context.height * context.devicePixelRatio;
  const margin = 24 * context.devicePixelRatio;
  let cursor = 0;

  const getProjectedPoint = (azimuthDegrees: number, rangeKm: number) => {
    const cacheKey = `${azimuthDegrees.toFixed(6)}:${rangeKm.toFixed(4)}`;
    const cached = pointCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const projected = projectRangeAzimuthToScreen(map, site, azimuthDegrees, rangeKm);
    const point = {
      x: projected.x * context.devicePixelRatio,
      y: projected.y * context.devicePixelRatio
    };

    pointCache.set(cacheKey, point);
    return point;
  };

  for (const radial of sortedRadials) {
    const bounds = radialAzimuthBounds(radial, context.azimuth);

    for (let gateIndex = 0; gateIndex < radial.gateCount; gateIndex += 1) {
      const rangeStartKm = Math.max(0, radial.rangeStartKm[gateIndex]);
      const rangeEndKm = Math.max(rangeStartKm + 0.01, radial.rangeEndKm[gateIndex]);
      const value = normalizeReflectivityValue(
        radial.intensity[gateIndex],
        Number.isFinite(radial.reflectivityDbz[gateIndex])
          ? radial.reflectivityDbz[gateIndex]
          : undefined
      );
      const innerLeft = getProjectedPoint(bounds.azimuthStart, rangeStartKm);
      const innerRight = getProjectedPoint(bounds.azimuthEnd, rangeStartKm);
      const outerLeft = getProjectedPoint(bounds.azimuthStart, rangeEndKm);
      const outerRight = getProjectedPoint(bounds.azimuthEnd, rangeEndKm);

      const minX = Math.min(innerLeft.x, innerRight.x, outerLeft.x, outerRight.x);
      const maxX = Math.max(innerLeft.x, innerRight.x, outerLeft.x, outerRight.x);
      const minY = Math.min(innerLeft.y, innerRight.y, outerLeft.y, outerRight.y);
      const maxY = Math.max(innerLeft.y, innerRight.y, outerLeft.y, outerRight.y);

      if (maxX < -margin || minX > width + margin || maxY < -margin || minY > height + margin) {
        continue;
      }

      cursor = writeVertex(vertexData, cursor, innerLeft.x, innerLeft.y, value);
      cursor = writeVertex(vertexData, cursor, innerRight.x, innerRight.y, value);
      cursor = writeVertex(vertexData, cursor, outerRight.x, outerRight.y, value);
      cursor = writeVertex(vertexData, cursor, innerLeft.x, innerLeft.y, value);
      cursor = writeVertex(vertexData, cursor, outerRight.x, outerRight.y, value);
      cursor = writeVertex(vertexData, cursor, outerLeft.x, outerLeft.y, value);
    }
  }

  return cursor === vertexData.length ? vertexData : vertexData.subarray(0, cursor);
}

export function buildRadarPolarTextureMeshData(
  map: MapLibreMap,
  site: GeoPoint,
  radials: PolarRadialData[],
  context: RadarVertexBuildContext
): RadarPolarTextureMeshData {
  const sortedRadials = sortByRadialAzimuth(radials);
  const radialCellCount = sortedRadials.length;

  if (radialCellCount === 0) {
    return {
      vertexData: new Float32Array(0),
      indexData: new Uint16Array(0),
      polarTexture: new Uint8Array(0),
      boundaryVertexData: new Float32Array(0),
      radialCellCount: 0,
      rangeCellCount: 0
    };
  }

  const rangeEdgeKeys = new Map<string, number>();
  const rangeEdges: number[] = [0];

  for (const radial of sortedRadials) {
    for (let gateIndex = 0; gateIndex < radial.gateCount; gateIndex += 1) {
      const start = Math.max(0, radial.rangeStartKm[gateIndex]);
      const end = Math.max(start + 0.01, radial.rangeEndKm[gateIndex]);

      for (const value of [start, end]) {
        const key = value.toFixed(4);

        if (!rangeEdgeKeys.has(key)) {
          rangeEdgeKeys.set(key, value);
          rangeEdges.push(value);
        }
      }
    }
  }

  rangeEdges.sort((left, right) => left - right);
  const rangeEdgeIndex = new Map<string, number>();

  for (let index = 0; index < rangeEdges.length; index += 1) {
    rangeEdgeIndex.set(rangeEdges[index].toFixed(4), index);
  }

  const rangeCellCount = Math.max(0, rangeEdges.length - 1);

  if (rangeCellCount === 0) {
    return {
      vertexData: new Float32Array(0),
      indexData: new Uint16Array(0),
      polarTexture: new Uint8Array(0),
      boundaryVertexData: new Float32Array(0),
      radialCellCount,
      rangeCellCount
    };
  }

  const radialEdgeCount = radialCellCount + 1;
  const verticesPerRadial = (rangeCellCount + 1) * 2;
  const vertexCount = radialCellCount * verticesPerRadial;
  const vertexData = new Float32Array(vertexCount * 4);
  const boundaryVertexData = new Float32Array(radialEdgeCount * 2 * 4);
  const radialEdgeAngles = resolveSharedRadialEdgeAngles(sortedRadials);
  const pointCache = new Map<string, { x: number; y: number }>();
  let vertexCursor = 0;
  let boundaryCursor = 0;

  const getProjectedPoint = (azimuthDegrees: number, rangeKm: number) => {
    const cacheKey = `${azimuthDegrees.toFixed(6)}:${rangeKm.toFixed(4)}`;
    const cached = pointCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const projected = projectRangeAzimuthToScreen(map, site, azimuthDegrees, rangeKm);
    const point = {
      x: projected.x * context.devicePixelRatio,
      y: projected.y * context.devicePixelRatio
    };

    pointCache.set(cacheKey, point);
    return point;
  };

  for (let radialColumn = 0; radialColumn < radialCellCount; radialColumn += 1) {
    const leftAzimuthDegrees = radialEdgeAngles[radialColumn];
    const rightAzimuthDegrees = radialEdgeAngles[radialColumn + 1];
    const polarCellX = radialColumn + 0.5;

    for (let rangeEdgeIndexValue = 0; rangeEdgeIndexValue <= rangeCellCount; rangeEdgeIndexValue += 1) {
      const rangeKm = rangeEdges[rangeEdgeIndexValue];
      const left = getProjectedPoint(leftAzimuthDegrees, rangeKm);
      const right = getProjectedPoint(rightAzimuthDegrees, rangeKm);
      const textureY = rangeCellCount <= 0 ? 0 : rangeEdgeIndexValue / rangeCellCount;

      vertexData[vertexCursor] = left.x;
      vertexData[vertexCursor + 1] = left.y;
      vertexData[vertexCursor + 2] = polarCellX;
      vertexData[vertexCursor + 3] = textureY;
      vertexData[vertexCursor + 4] = right.x;
      vertexData[vertexCursor + 5] = right.y;
      vertexData[vertexCursor + 6] = polarCellX;
      vertexData[vertexCursor + 7] = textureY;
      vertexCursor += 8;
    }
  }

  for (let edgeIndex = 0; edgeIndex <= radialCellCount; edgeIndex += 1) {
    const azimuthDegrees = radialEdgeAngles[edgeIndex];
    const polarCellX = edgeIndex;

    const inner = getProjectedPoint(azimuthDegrees, rangeEdges[0]);
    const outer = getProjectedPoint(azimuthDegrees, rangeEdges[rangeEdges.length - 1]);

    boundaryVertexData[boundaryCursor] = inner.x;
    boundaryVertexData[boundaryCursor + 1] = inner.y;
    boundaryVertexData[boundaryCursor + 2] = polarCellX;
    boundaryVertexData[boundaryCursor + 3] = 0;
    boundaryVertexData[boundaryCursor + 4] = outer.x;
    boundaryVertexData[boundaryCursor + 5] = outer.y;
    boundaryVertexData[boundaryCursor + 6] = polarCellX;
    boundaryVertexData[boundaryCursor + 7] = 1;
    boundaryCursor += 8;
  }

  const cellCount = radialCellCount * rangeCellCount;
  const indexCount = cellCount * 6;
  const useUint32 = vertexCount > 65535;
  const indexData = useUint32 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const polarTexture = new Uint8Array(radialCellCount * rangeCellCount * 4);
  let indexCursor = 0;

  for (let radialColumn = 0; radialColumn < sortedRadials.length; radialColumn += 1) {
    const radial = sortedRadials[radialColumn];
    const alternationValue = radialColumn % 2 === 0 ? 64 : 192;

    for (let gateIndex = 0; gateIndex < radial.gateCount; gateIndex += 1) {
      const startIndex =
        rangeEdgeIndex.get(Math.max(0, radial.rangeStartKm[gateIndex]).toFixed(4)) ?? -1;
      const endIndex =
        rangeEdgeIndex.get(
          Math.max(Math.max(0, radial.rangeStartKm[gateIndex]) + 0.01, radial.rangeEndKm[gateIndex]).toFixed(4)
        ) ?? -1;

      if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
        continue;
      }

      const normalizedValue = normalizeReflectivityValue(
        radial.intensity[gateIndex],
        Number.isFinite(radial.reflectivityDbz[gateIndex])
          ? radial.reflectivityDbz[gateIndex]
          : undefined
      );
      const encodedValue = Math.round(Math.max(0, Math.min(1, normalizedValue)) * 255);
      const encodedOpacity = Math.round(Math.max(0, Math.min(1, radial.displayOpacity)) * 255);

      for (let rangeIndex = startIndex; rangeIndex < endIndex; rangeIndex += 1) {
        const textureOffset = (rangeIndex * radialCellCount + radialColumn) * 4;
        polarTexture[textureOffset] = encodedValue;
        polarTexture[textureOffset + 1] = alternationValue;
        polarTexture[textureOffset + 2] = encodedValue;
        polarTexture[textureOffset + 3] = encodedOpacity;
      }
    }
  }

  for (let radialColumn = 0; radialColumn < radialCellCount; radialColumn += 1) {
    const radialVertexOffset = radialColumn * verticesPerRadial;

    for (let rangeIndex = 0; rangeIndex < rangeCellCount; rangeIndex += 1) {
      const topLeft = radialVertexOffset + rangeIndex * 2;
      const topRight = topLeft + 1;
      const bottomLeft = radialVertexOffset + (rangeIndex + 1) * 2;
      const bottomRight = bottomLeft + 1;

      indexData[indexCursor] = topLeft;
      indexData[indexCursor + 1] = topRight;
      indexData[indexCursor + 2] = bottomRight;
      indexData[indexCursor + 3] = topLeft;
      indexData[indexCursor + 4] = bottomRight;
      indexData[indexCursor + 5] = bottomLeft;
      indexCursor += 6;
    }
  }

  return {
    vertexData,
    indexData,
    polarTexture,
    boundaryVertexData,
    radialCellCount,
    rangeCellCount
  };
}
