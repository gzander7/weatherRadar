import type { Map as MapLibreMap } from "maplibre-gl";
import {
  buildRadarPolarTextureMeshData,
  resolveRadialAzimuthGeometry,
  sortByRadialIndex,
  type RadarVertexBuildContext
} from "./radarGeometryBuilder";
import type { PolarRadialData } from "./radarPolarField";
import { buildReflectivityPaletteTexture } from "./reflectivityColorScale";
import { buildMapViewSignature, type GeoPoint } from "./radarProjection";

export interface RadarWebglRenderOptions {
  map: MapLibreMap;
  site: GeoPoint;
  fieldKey: string;
  allRadials: Iterable<PolarRadialData>;
  changedRadials?: Iterable<PolarRadialData>;
  radialCountHint?: number;
  radialOverlapPaddingDegrees?: number;
  forceRebuild?: boolean;
  debugMode?: RadarWebglDebugMode;
  debugFlatMode?: boolean;
  debugBoundaryOutlines?: boolean;
}

export type RadarWebglDebugMode = "reflectivity" | "flat" | "radials" | "nodata";

const vertexShaderSource = `
attribute vec2 a_position;
attribute vec2 a_polarCoord;
uniform vec2 u_resolution;
varying vec2 v_polarCoord;

void main() {
  vec2 zeroToOne = a_position / u_resolution;
  vec2 clipSpace = zeroToOne * 2.0 - 1.0;
  gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
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

  float radialCell = floor(v_polarCoord.x);
  radialCell = mod(radialCell, u_polarTextureSize.x);
  vec2 polarCell = vec2(
    radialCell,
    floor(v_polarCoord.y * u_polarTextureSize.y - 0.0001)
  );
  polarCell = clamp(polarCell, vec2(0.0), u_polarTextureSize - vec2(1.0));
  vec2 polarSampleCoord = (polarCell + vec2(0.5)) / u_polarTextureSize;
  vec4 dataValue = texture2D(u_polarTexture, polarSampleCoord);

  if (dataValue.a <= 0.001) {
    if (u_debugMode > 2.5) {
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

export class RadarWebglRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext | null;
  private readonly program: WebGLProgram | null;
  private readonly positionLocation: number;
  private readonly polarCoordLocation: number;
  private readonly resolutionLocation: WebGLUniformLocation | null;
  private readonly paletteLocation: WebGLUniformLocation | null;
  private readonly polarTextureLocation: WebGLUniformLocation | null;
  private readonly polarTextureSizeLocation: WebGLUniformLocation | null;
  private readonly debugModeLocation: WebGLUniformLocation | null;
  private readonly paletteTexture: WebGLTexture | null;
  private readonly polarTexture: WebGLTexture | null;
  private readonly meshBuffer: WebGLBuffer | null;
  private readonly boundaryBuffer: WebGLBuffer | null;
  private readonly indexBuffer: WebGLBuffer | null;
  private readonly unsignedIntExtension: OES_element_index_uint | null;
  private meshVertexCount = 0;
  private meshIndexCount = 0;
  private meshIndexType = 0;
  private boundaryVertexCount = 0;
  private polarTextureSize = { radialCellCount: 0, rangeCellCount: 0 };
  private currentFieldKey: string | null = null;
  private currentViewSignature: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    });

    this.gl = gl;

    if (!gl) {
      this.program = null;
      this.positionLocation = -1;
      this.polarCoordLocation = -1;
      this.resolutionLocation = null;
      this.paletteLocation = null;
      this.polarTextureLocation = null;
      this.polarTextureSizeLocation = null;
      this.debugModeLocation = null;
      this.paletteTexture = null;
      this.polarTexture = null;
      this.meshBuffer = null;
      this.boundaryBuffer = null;
      this.indexBuffer = null;
      this.unsignedIntExtension = null;
      return;
    }

    const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    const program = vertexShader && fragmentShader ? this.createProgram(vertexShader, fragmentShader) : null;

    if (!program) {
      this.program = null;
      this.positionLocation = -1;
      this.polarCoordLocation = -1;
      this.resolutionLocation = null;
      this.paletteLocation = null;
      this.polarTextureLocation = null;
      this.polarTextureSizeLocation = null;
      this.debugModeLocation = null;
      this.paletteTexture = null;
      this.polarTexture = null;
      this.meshBuffer = null;
      this.boundaryBuffer = null;
      this.indexBuffer = null;
      this.unsignedIntExtension = null;
      return;
    }

    this.program = program;
    this.positionLocation = gl.getAttribLocation(program, "a_position");
    this.polarCoordLocation = gl.getAttribLocation(program, "a_polarCoord");
    this.resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    this.paletteLocation = gl.getUniformLocation(program, "u_palette");
    this.polarTextureLocation = gl.getUniformLocation(program, "u_polarTexture");
    this.polarTextureSizeLocation = gl.getUniformLocation(program, "u_polarTextureSize");
    this.debugModeLocation = gl.getUniformLocation(program, "u_debugMode");
    this.paletteTexture = gl.createTexture();
    this.polarTexture = gl.createTexture();
    this.meshBuffer = gl.createBuffer();
    this.boundaryBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.unsignedIntExtension = gl.getExtension("OES_element_index_uint");
    this.configurePaletteTexture();
    this.configurePolarTexture();

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  dispose() {
    if (!this.gl) {
      return;
    }

    if (this.meshBuffer) {
      this.gl.deleteBuffer(this.meshBuffer);
    }

    if (this.paletteTexture) {
      this.gl.deleteTexture(this.paletteTexture);
    }

    if (this.polarTexture) {
      this.gl.deleteTexture(this.polarTexture);
    }

    if (this.boundaryBuffer) {
      this.gl.deleteBuffer(this.boundaryBuffer);
    }

    if (this.indexBuffer) {
      this.gl.deleteBuffer(this.indexBuffer);
    }

    if (this.program) {
      this.gl.deleteProgram(this.program);
    }
  }

  clear() {
    if (!this.gl) {
      return;
    }

    this.resizeCanvas();
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.meshVertexCount = 0;
    this.meshIndexCount = 0;
    this.boundaryVertexCount = 0;
  }

  render(options: RadarWebglRenderOptions) {
    if (!this.gl || !this.program) {
      return;
    }

    const resized = this.resizeCanvas();
    const viewSignature = buildMapViewSignature(
      options.map,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      window.devicePixelRatio || 1
    );
    const rebuildAll =
      options.forceRebuild ||
      resized ||
      this.currentFieldKey !== options.fieldKey ||
      this.currentViewSignature !== viewSignature;

    const orderedAllRadials = sortByRadialIndex(options.allRadials);
    const geometryContext: RadarVertexBuildContext = {
      azimuth: resolveRadialAzimuthGeometry(
        orderedAllRadials,
        options.radialCountHint,
        options.radialOverlapPaddingDegrees
      ),
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      radialCountHint: options.radialCountHint,
      radialOverlapPaddingDegrees: options.radialOverlapPaddingDegrees
    };

    this.rebuildMesh(
      options.map,
      options.site,
      orderedAllRadials,
      geometryContext
    );

    this.currentFieldKey = options.fieldKey;
    this.currentViewSignature = viewSignature;
    this.drawBuffers(
      options.debugMode ?? (options.debugFlatMode ? "flat" : "reflectivity"),
      Boolean(options.debugBoundaryOutlines)
    );
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

  private resizeCanvas() {
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * pixelRatio));
    const resized = this.canvas.width !== width || this.canvas.height !== height;

    if (resized) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    return resized;
  }

  private rebuildMesh(
    map: MapLibreMap,
    site: GeoPoint,
    radials: PolarRadialData[],
    geometryContext: RadarVertexBuildContext
  ) {
    if (!this.gl || !this.meshBuffer || !this.indexBuffer || !this.polarTexture) {
      return;
    }

    const mesh = buildRadarPolarTextureMeshData(map, site, radials, geometryContext);
    const useUnsignedInt = mesh.indexData instanceof Uint32Array;

    if (useUnsignedInt && !this.unsignedIntExtension) {
      // Fallback to clearing if indexed uint32 is unavailable.
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

  private drawBuffers(debugMode: RadarWebglDebugMode, debugBoundaryOutlines: boolean) {
    if (
      !this.gl ||
      !this.program ||
      !this.meshBuffer ||
      !this.indexBuffer ||
      !this.polarTexture ||
      this.meshVertexCount === 0 ||
      this.meshIndexCount === 0
    ) {
      return;
    }

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.useProgram(this.program);

    if (this.resolutionLocation) {
      this.gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height);
    }

    if (this.paletteLocation && this.paletteTexture) {
      this.gl.activeTexture(this.gl.TEXTURE0);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.paletteTexture);
      this.gl.uniform1i(this.paletteLocation, 0);
    }

    if (this.polarTextureLocation) {
      this.gl.activeTexture(this.gl.TEXTURE1);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.polarTexture);
      this.gl.uniform1i(this.polarTextureLocation, 1);
    }

    if (this.polarTextureSizeLocation) {
      this.gl.uniform2f(
        this.polarTextureSizeLocation,
        Math.max(1, this.polarTextureSize.radialCellCount),
        Math.max(1, this.polarTextureSize.rangeCellCount)
      );
    }

    if (this.debugModeLocation) {
      this.gl.uniform1f(this.debugModeLocation, this.debugModeToUniform(debugMode));
    }

    this.gl.enableVertexAttribArray(this.positionLocation);
    this.gl.enableVertexAttribArray(this.polarCoordLocation);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.meshBuffer);
    this.gl.vertexAttribPointer(this.positionLocation, 2, this.gl.FLOAT, false, 16, 0);
    this.gl.vertexAttribPointer(this.polarCoordLocation, 2, this.gl.FLOAT, false, 16, 8);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    this.gl.drawElements(this.gl.TRIANGLES, this.meshIndexCount, this.meshIndexType, 0);

    if (debugBoundaryOutlines && this.boundaryBuffer && this.boundaryVertexCount > 0) {
      if (this.debugModeLocation) {
        this.gl.uniform1f(this.debugModeLocation, 4);
      }

      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.boundaryBuffer);
      this.gl.vertexAttribPointer(this.positionLocation, 2, this.gl.FLOAT, false, 16, 0);
      this.gl.vertexAttribPointer(this.polarCoordLocation, 2, this.gl.FLOAT, false, 16, 8);
      this.gl.drawArrays(this.gl.LINES, 0, this.boundaryVertexCount);
    }
  }
}
