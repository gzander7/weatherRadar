import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap
} from "maplibre-gl";
import {
  buildRadarMercatorTextureMeshData,
  sortByRadialIndex
} from "./radarGeometryBuilder";
import type { PolarRadialData } from "./radarPolarField";
import { buildReflectivityPaletteTexture } from "./reflectivityColorScale";
import type { GeoPoint } from "./radarProjection";
import type { RadarWebglDebugMode } from "./radarWebglRenderer";

export const radarCustomLayerId = "single-site-radar-field-custom-layer";

export interface RadarCustomLayerRenderOptions {
  site: GeoPoint;
  fieldKey: string;
  allRadials: Iterable<PolarRadialData>;
  radialCountHint?: number;
  radialOverlapPaddingDegrees?: number;
  forceRebuild?: boolean;
  debugMode?: RadarWebglDebugMode;
  debugBoundaryOutlines?: boolean;
}

export interface RadarCustomLayerStats {
  renderCount: number;
  dataRebuildCount: number;
  lastDataRebuildMs: number | null;
  fpsEstimate: number;
  lastFrameKind: "idle" | "camera-only" | "data-rebuild";
}

const vertexShaderSource = `
attribute vec2 a_mercator;
attribute vec2 a_polarCoord;
uniform mat4 u_matrix;
varying vec2 v_polarCoord;

void main() {
  gl_Position = u_matrix * vec4(a_mercator, 0.0, 1.0);
  v_polarCoord = a_polarCoord;
}
`;

const fragmentShaderSource = `
precision mediump float;
uniform sampler2D u_palette;
uniform sampler2D u_polarTexture;
uniform vec2 u_polarTextureSize;
uniform float u_debugMode;
varying vec2 v_polarCoord;

void main() {
  if (u_debugMode > 3.5) {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 0.58);
    return;
  }

  float radialCell = floor(v_polarCoord.x + 0.001);
  radialCell = clamp(radialCell, 0.0, u_polarTextureSize.x - 1.0);
  float rangeCell = floor(clamp(v_polarCoord.y, 0.0, 0.999999) * u_polarTextureSize.y);
  vec2 polarCell = vec2(radialCell, rangeCell);
  vec2 polarSampleCoord = (polarCell + vec2(0.5)) / u_polarTextureSize;
  vec4 dataValue = texture2D(u_polarTexture, polarSampleCoord);

  if (u_debugMode > 2.5) {
    gl_FragColor = vec4(polarSampleCoord, dataValue.a, 1.0);
    return;
  }

  if (dataValue.a <= 0.001) {
    if (u_debugMode > 1.5) {
      gl_FragColor = vec4(1.0, 0.0, 0.85, 0.22);
      return;
    }
    discard;
  }

  vec4 color;

  if (u_debugMode > 1.5) {
    float alternate = step(0.5, dataValue.g);
    color = mix(vec4(0.0, 0.78, 1.0, 1.0), vec4(1.0, 0.82, 0.0, 1.0), alternate);
  } else if (u_debugMode > 0.5) {
    color = vec4(0.15, 0.95, 0.25, 1.0);
  } else {
    color = texture2D(u_palette, vec2(clamp(dataValue.r, 0.0, 1.0), 0.5));
  }

  if (color.a <= 0.001) {
    discard;
  }
  color.a *= dataValue.a;
  gl_FragColor = color;
}
`;

export class RadarMapLibreCustomLayerRenderer implements CustomLayerInterface {
  readonly id = radarCustomLayerId;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: MapLibreMap | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private mercatorLocation = -1;
  private polarCoordLocation = -1;
  private matrixLocation: WebGLUniformLocation | null = null;
  private paletteLocation: WebGLUniformLocation | null = null;
  private polarTextureLocation: WebGLUniformLocation | null = null;
  private polarTextureSizeLocation: WebGLUniformLocation | null = null;
  private debugModeLocation: WebGLUniformLocation | null = null;
  private paletteTexture: WebGLTexture | null = null;
  private polarTexture: WebGLTexture | null = null;
  private meshBuffer: WebGLBuffer | null = null;
  private boundaryBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private unsignedIntExtension: OES_element_index_uint | null = null;
  private supportsUnsignedIntIndices = false;
  private meshVertexCount = 0;
  private meshIndexCount = 0;
  private meshIndexType = 0;
  private boundaryVertexCount = 0;
  private polarTextureSize = { radialCellCount: 0, rangeCellCount: 0 };
  private currentFieldKey: string | null = null;
  private debugMode: RadarWebglDebugMode = "reflectivity";
  private debugBoundaryOutlines = false;
  private frameTimestamps: number[] = [];
  private stats: RadarCustomLayerStats = {
    renderCount: 0,
    dataRebuildCount: 0,
    lastDataRebuildMs: null,
    fpsEstimate: 0,
    lastFrameKind: "idle"
  };

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;

    const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    this.program = vertexShader && fragmentShader
      ? this.createProgram(vertexShader, fragmentShader)
      : null;

    if (!this.program) {
      return;
    }

    this.mercatorLocation = gl.getAttribLocation(this.program, "a_mercator");
    this.polarCoordLocation = gl.getAttribLocation(this.program, "a_polarCoord");
    this.matrixLocation = gl.getUniformLocation(this.program, "u_matrix");
    this.paletteLocation = gl.getUniformLocation(this.program, "u_palette");
    this.polarTextureLocation = gl.getUniformLocation(this.program, "u_polarTexture");
    this.polarTextureSizeLocation = gl.getUniformLocation(this.program, "u_polarTextureSize");
    this.debugModeLocation = gl.getUniformLocation(this.program, "u_debugMode");
    this.paletteTexture = gl.createTexture();
    this.polarTexture = gl.createTexture();
    this.meshBuffer = gl.createBuffer();
    this.boundaryBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.unsignedIntExtension = gl.getExtension("OES_element_index_uint");
    this.supportsUnsignedIntIndices =
      typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext
        ? true
        : Boolean(this.unsignedIntExtension);
    this.configurePaletteTexture();
    this.configurePolarTexture();
  }

  onRemove() {
    this.dispose();
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput
  ) {
    if (
      !this.program ||
      !this.meshBuffer ||
      !this.indexBuffer ||
      !this.polarTexture ||
      this.meshVertexCount === 0 ||
      this.meshIndexCount === 0
    ) {
      return;
    }

    this.stats.renderCount += 1;
    this.stats.lastFrameKind = "camera-only";
    this.recordFrameTimestamp(performance.now());
    this.writeDebugState();

    gl.useProgram(this.program);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (this.matrixLocation) {
      gl.uniformMatrix4fv(this.matrixLocation, false, options.defaultProjectionData.mainMatrix);
    }

    if (this.paletteLocation && this.paletteTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      gl.uniform1i(this.paletteLocation, 0);
    }

    if (this.polarTextureLocation) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.polarTexture);
      gl.uniform1i(this.polarTextureLocation, 1);
    }

    if (this.polarTextureSizeLocation) {
      gl.uniform2f(
        this.polarTextureSizeLocation,
        Math.max(1, this.polarTextureSize.radialCellCount),
        Math.max(1, this.polarTextureSize.rangeCellCount)
      );
    }

    if (this.debugModeLocation) {
      gl.uniform1f(this.debugModeLocation, this.debugModeToUniform(this.debugMode));
    }

    gl.enableVertexAttribArray(this.mercatorLocation);
    gl.enableVertexAttribArray(this.polarCoordLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.vertexAttribPointer(this.mercatorLocation, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(this.polarCoordLocation, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.drawElements(gl.TRIANGLES, this.meshIndexCount, this.meshIndexType, 0);

    if (this.debugBoundaryOutlines && this.boundaryBuffer && this.boundaryVertexCount > 0) {
      if (this.debugModeLocation) {
        gl.uniform1f(this.debugModeLocation, 4);
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this.boundaryBuffer);
      gl.vertexAttribPointer(this.mercatorLocation, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(this.polarCoordLocation, 2, gl.FLOAT, false, 16, 8);
      gl.drawArrays(gl.LINES, 0, this.boundaryVertexCount);
    }
  }

  setData(options: RadarCustomLayerRenderOptions) {
    if (!this.gl || !this.program) {
      return;
    }

    const orderedAllRadials = sortByRadialIndex(options.allRadials);
    const rebuildAll =
      options.forceRebuild ||
      this.currentFieldKey !== options.fieldKey ||
      this.meshVertexCount === 0 ||
      this.meshIndexCount === 0;

    this.debugMode = options.debugMode ?? "reflectivity";
    this.debugBoundaryOutlines = Boolean(options.debugBoundaryOutlines);

    if (rebuildAll) {
      const rebuildStartMs = performance.now();
      this.rebuildMesh(options.site, orderedAllRadials, {
        radialCountHint: options.radialCountHint,
        radialOverlapPaddingDegrees: options.radialOverlapPaddingDegrees
      });
      this.stats.dataRebuildCount += 1;
      this.stats.lastDataRebuildMs = performance.now() - rebuildStartMs;
      this.stats.lastFrameKind = "data-rebuild";
    }

    this.currentFieldKey = options.fieldKey;
    this.writeDebugState();
    this.map?.triggerRepaint();
  }

  clear() {
    this.meshVertexCount = 0;
    this.meshIndexCount = 0;
    this.boundaryVertexCount = 0;
    this.currentFieldKey = null;
    this.stats.lastFrameKind = "idle";
    this.writeDebugState();
    this.map?.triggerRepaint();
  }

  getStats() {
    return { ...this.stats };
  }

  dispose() {
    if (!this.gl) {
      return;
    }

    if (this.meshBuffer) {
      this.gl.deleteBuffer(this.meshBuffer);
    }

    if (this.boundaryBuffer) {
      this.gl.deleteBuffer(this.boundaryBuffer);
    }

    if (this.indexBuffer) {
      this.gl.deleteBuffer(this.indexBuffer);
    }

    if (this.paletteTexture) {
      this.gl.deleteTexture(this.paletteTexture);
    }

    if (this.polarTexture) {
      this.gl.deleteTexture(this.polarTexture);
    }

    if (this.program) {
      this.gl.deleteProgram(this.program);
    }

    this.map = null;
    this.gl = null;
  }

  private createShader(type: number, source: string) {
    if (!this.gl) {
      return null;
    }

    const shader = this.gl.createShader(type);

    if (!shader) {
      return null;
    }

    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      return shader;
    }

    this.gl.deleteShader(shader);
    return null;
  }

  private createProgram(vertexShader: WebGLShader, fragmentShader: WebGLShader) {
    if (!this.gl) {
      return null;
    }

    const program = this.gl.createProgram();

    if (!program) {
      return null;
    }

    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);

    if (this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      return program;
    }

    this.gl.deleteProgram(program);
    return null;
  }

  private configurePaletteTexture() {
    if (!this.gl || !this.paletteTexture) {
      return;
    }

    const palette = buildReflectivityPaletteTexture();

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.paletteTexture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      256,
      1,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      palette
    );
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
  }

  private configurePolarTexture() {
    if (!this.gl || !this.polarTexture) {
      return;
    }

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.polarTexture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      1,
      1,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0])
    );
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
  }

  private rebuildMesh(
    site: GeoPoint,
    radials: PolarRadialData[],
    options: {
      radialCountHint?: number;
      radialOverlapPaddingDegrees?: number;
    }
  ) {
    if (!this.gl || !this.meshBuffer || !this.indexBuffer || !this.polarTexture) {
      return;
    }

    const mesh = buildRadarMercatorTextureMeshData(site, radials, options);
    const useUnsignedInt = mesh.indexData instanceof Uint32Array;

    if (useUnsignedInt && !this.supportsUnsignedIntIndices) {
      this.meshVertexCount = 0;
      this.meshIndexCount = 0;
      return;
    }

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.meshBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, mesh.vertexData, this.gl.STATIC_DRAW);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, mesh.indexData, this.gl.STATIC_DRAW);

    if (this.boundaryBuffer) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.boundaryBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, mesh.boundaryVertexData, this.gl.STATIC_DRAW);
    }

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.polarTexture);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      Math.max(1, mesh.radialCellCount),
      Math.max(1, mesh.rangeCellCount),
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      mesh.polarTexture.length > 0 ? mesh.polarTexture : new Uint8Array([0, 0, 0, 0])
    );
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.meshVertexCount = mesh.vertexData.length / 4;
    this.meshIndexCount = mesh.indexData.length;
    this.meshIndexType = useUnsignedInt ? this.gl.UNSIGNED_INT : this.gl.UNSIGNED_SHORT;
    this.boundaryVertexCount = mesh.boundaryVertexData.length / 4;
    this.polarTextureSize = {
      radialCellCount: mesh.radialCellCount,
      rangeCellCount: mesh.rangeCellCount
    };
  }

  private debugModeToUniform(debugMode: RadarWebglDebugMode) {
    switch (debugMode) {
      case "flat":
        return 1;
      case "radials":
        return 2;
      case "nodata":
        return 3;
      case "reflectivity":
      default:
        return 0;
    }
  }

  private recordFrameTimestamp(nowMs: number) {
    this.frameTimestamps.push(nowMs);
    const oldestAllowedMs = nowMs - 1000;

    while (this.frameTimestamps.length > 0 && this.frameTimestamps[0] < oldestAllowedMs) {
      this.frameTimestamps.shift();
    }

    this.stats.fpsEstimate = this.frameTimestamps.length;
  }

  private writeDebugState() {
    if (typeof window === "undefined") {
      return;
    }

    (window as any).__radarWebglRenderer = (window as any).__radarWebglRenderer || {};
    (window as any).__radarWebglRenderer.customLayer = {
      ...this.stats,
      currentFieldKey: this.currentFieldKey,
      meshVertexCount: this.meshVertexCount,
      meshIndexCount: this.meshIndexCount,
      polarTextureSize: this.polarTextureSize
    };
  }
}
