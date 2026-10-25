import qualityArtworkUrl from './assets/quality-glass-split.webp';
/** Shared, on-demand WebGL film renderer. Geometry is in CSS pixels; no animation loop,
 * animation or framework dependency. Charts own their small 2D snapshots. */
export interface FilmPoint {
  x: number;
  y: number;
  z: number;
}
export interface FilmMesh {
  data: Float32Array;
  color: string;
  opacity: number;
}
interface State {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  lost: boolean;
  artworkProgram?: WebGLProgram;
  artworkTexture?: WebGLTexture;
  filmTexture?: WebGLTexture;
}
let state: State | null = null;
let users = 0;
let unavailable = false;
let generation = 0;
export const glassDiagnostics = {
  contexts: 0,
  renders: 0,
  vertices: 0,
  lastCpuMs: 0,
  totalCpuMs: 0,
  maxCpuMs: 0,
  drawingBufferBytes: 0,
  bufferBytes: 0,
  textureBytes: 0,
  artworkLoads: 0,
  textureUploads: 0,
  failures: 0
};
const vertex = `
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec2 uv;
  attribute float sectionWidth;
  uniform vec2 size;
  varying vec3 N;
  varying vec2 V;
  varying float W;
  void main(){
  N=normal;
  V=uv;
  W=sectionWidth;
  gl_Position=vec4(position.x/size.x*2.-1.,1.-position.y/size.y*2.,0.,1.);
  }
`;
const fragment = `
precision mediump float;
varying vec3 N;
varying vec2 V;
varying float W;
uniform vec3 tint;
uniform float opacity;
uniform sampler2D film;
uniform float hasFilm;
void main() {
  if (hasFilm > .5) {
    // Precomputed reference-derived optical cross sections: no baked data shape.
    // Straight RGB/alpha is blended once into the premultiplied shared canvas.
    vec4 tex = texture2D(film, V);
    float edge = smoothstep(0., .08, V.y) * (1. - smoothstep(.82, 1., V.y));
    vec3 materialColor = tex.rgb * min(vec3(1.25), tint / vec3(.957, .792, .439));
    gl_FragColor = vec4(materialColor, tex.a * edge * .63 * opacity);
    return;
  }
  vec3 n = normalize(N);
  if (n.z < 0.) n = -n;
  vec3 reflection = reflect(vec3(0., 0., -1.), n);
  float key = exp(-pow((reflection.y + .46) / .075, 2.) - pow(reflection.x / .85, 2.));
  float shoulder = exp(-pow((reflection.y + .46) / .24, 2.) - pow(reflection.x / .95, 2.));
  float reverse = .20 * exp(-pow((reflection.y - .42) / .20, 2.));
  float caustic = min(1., key + reverse);
  float edge = exp(-V.y * 110.) + .55 * exp(-(1. - V.y) * 100.);
  vec3 color = mix(tint, vec3(1., .975, .86), smoothstep(.48, .92, caustic));
  float alpha = (.025 + .78 * caustic + .10 * shoulder + .16 * edge) * opacity;
  alpha *= 1. - .60 * smoothstep(.84, 1., V.y);
  gl_FragColor = vec4(color, clamp(alpha, 0., .95));
}`;
function compile(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader {
  const shader = gl.createShader(kind)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(reason || 'Shader compile failed');
  }
  return shader;
}
function getState(): State | null {
  if (unavailable) return null;
  if (state) return state.lost ? null : state;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    depth: false,
    stencil: false,
    powerPreference: 'low-power'
  });
  if (!gl) {
    glassDiagnostics.failures++;
    unavailable = true;
    return null;
  }
  try {
    const program = gl.createProgram()!,
      vs = compile(gl, gl.VERTEX_SHADER, vertex),
      fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Film link failed');
    state = {
      canvas,
      gl,
      program,
      buffer: gl.createBuffer()!,
      lost: false
    };
    glassDiagnostics.contexts++;
    glassDiagnostics.textureBytes = 0;
    generation++;
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      if (state?.canvas === canvas) {
        state.lost = true;
        generation++;
      }
    });
    canvas.addEventListener('webglcontextrestored', () => {
      if (state?.canvas === canvas) {
        state = null;
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.width = canvas.height = 0;
        generation++;
        window.dispatchEvent(new Event('cost-gl-restored'));
      }
    });
    return state;
  } catch {
    glassDiagnostics.failures++;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }
}
export function retainGlassRenderer(): () => void {
  users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users--;
    if (users <= 0 && state) {
      const {
        gl,
        buffer,
        program,
        canvas,
        artworkProgram,
        artworkTexture,
        filmTexture
      } = state;
      state = null;
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      if (artworkProgram) gl.deleteProgram(artworkProgram);
      if (artworkTexture) gl.deleteTexture(artworkTexture);
      if (filmTexture) gl.deleteTexture(filmTexture);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.width = canvas.height = 0;
      glassDiagnostics.drawingBufferBytes = glassDiagnostics.bufferBytes = 0;
      glassDiagnostics.textureBytes = 0;
      generation++;
    }
  };
}
export function glassGeneration(): number {
  return generation;
}
export function filmMesh(columns: number, rows: number, point: (u: number, v: number) => FilmPoint, color: string, opacity = 1): FilmMesh {
  const values: number[] = [];
  const positions: FilmPoint[][] = [];
  for (let i = 0; i <= columns; i++) {
    positions[i] = [];
    for (let j = 0; j <= rows; j++) positions[i][j] = point(i / columns, j / rows);
  }
  const emit = (i: number, j: number) => {
    const p = positions[i][j],
      a = positions[Math.max(0, i - 1)][j],
      b = positions[Math.min(columns, i + 1)][j],
      c = positions[i][Math.max(0, j - 1)],
      d = positions[i][Math.min(rows, j + 1)];
    const ux = b.x - a.x,
      uy = b.y - a.y,
      uz = b.z - a.z,
      vx = d.x - c.x,
      vy = d.y - c.y,
      vz = d.z - c.z;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const sectionWidth = Math.hypot(d.x - c.x, d.y - c.y) * rows / (j === 0 || j === rows ? 1 : 2);
    values.push(p.x, p.y, p.z, nx, ny, nz, i / columns, j / rows, sectionWidth);
  };
  for (let i = 0; i < columns; i++) for (let j = 0; j < rows; j++) {
    emit(i, j);
    emit(i + 1, j);
    emit(i, j + 1);
    emit(i, j + 1);
    emit(i + 1, j);
    emit(i + 1, j + 1);
  }
  return {
    data: new Float32Array(values),
    color,
    opacity
  };
}
function rgb(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}
let filmArtwork: HTMLImageElement | null = null;
let filmArtworkLoading = false;
/** Load a data-independent optical atlas once; URL is supplied by the owning chart. */
export function loadFilmArtwork(url: string): void {
  if (filmArtwork || filmArtworkLoading || typeof Image === 'undefined') return;
  filmArtworkLoading = true;
  const image = new Image();
  image.onload = () => {
    filmArtwork = image;
    filmArtworkLoading = false;
    generation++;
    window.dispatchEvent(new Event('cost-gl-restored'));
  };
  image.onerror = () => {
    filmArtworkLoading = false;
  };
  image.src = url;
}
export function renderFilms(output: HTMLCanvasElement, width: number, height: number, meshes: FilmMesh[], dpr = Math.min(2, window.devicePixelRatio || 1)): boolean {
  if (document.hidden || !filmArtwork) return false;
  const s = getState();
  if (!s) return false;
  const start = performance.now();
  const {
    gl,
    canvas,
    program,
    buffer
  } = s;
  canvas.width = Math.max(1, Math.ceil(width * dpr));
  canvas.height = Math.max(1, Math.ceil(height * dpr));
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const [name, count, offset] of [['position', 3, 0], ['normal', 3, 12], ['uv', 2, 24], ['sectionWidth', 1, 32]] as const) {
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, count, gl.FLOAT, false, 36, offset);
  }
  gl.uniform2f(gl.getUniformLocation(program, 'size'), width, height);
  if (filmArtwork && !s.filmTexture) {
    s.filmTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, s.filmTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, filmArtwork);
    // The POT optical atlas is strongly minified across the thin CSS-pixel face.
    // Upload its mip chain once; trilinear sampling suppresses filament aliasing.
    const width = filmArtwork.naturalWidth, height = filmArtwork.naturalHeight;
    const powerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0;
    const mipmapped = powerOfTwo(width) && powerOfTwo(height);
    if (mipmapped) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    glassDiagnostics.textureUploads++;
    let levelWidth = width, levelHeight = height;
    glassDiagnostics.textureBytes += levelWidth * levelHeight * 4;
    while (mipmapped && (levelWidth > 1 || levelHeight > 1)) {
      levelWidth = Math.max(1, levelWidth >> 1);
      levelHeight = Math.max(1, levelHeight >> 1);
      glassDiagnostics.textureBytes += levelWidth * levelHeight * 4;
    }
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.filmTexture || null);
  gl.uniform1i(gl.getUniformLocation(program, 'film'), 0);
  gl.uniform1f(gl.getUniformLocation(program, 'hasFilm'), s.filmTexture ? 1 : 0);
  let vertices = 0;
  for (const mesh of meshes) {
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.DYNAMIC_DRAW);
    glassDiagnostics.bufferBytes = Math.max(glassDiagnostics.bufferBytes, mesh.data.byteLength);
    gl.uniform3fv(gl.getUniformLocation(program, 'tint'), rgb(mesh.color));
    gl.uniform1f(gl.getUniformLocation(program, 'opacity'), mesh.opacity);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.data.length / 9);
    vertices += mesh.data.length / 9;
  }
  output.width = canvas.width;
  output.height = canvas.height;
  output.getContext('2d')?.drawImage(canvas, 0, 0);
  glassDiagnostics.renders++;
  glassDiagnostics.vertices = vertices;
  glassDiagnostics.lastCpuMs = performance.now() - start;
  glassDiagnostics.totalCpuMs += glassDiagnostics.lastCpuMs;
  glassDiagnostics.maxCpuMs = Math.max(glassDiagnostics.maxCpuMs, glassDiagnostics.lastCpuMs);
  glassDiagnostics.drawingBufferBytes = canvas.width * canvas.height * 4;
  return true;
}
// The split is a fixed decorative topology, not a Sankey measure. Its baked
// light field is independent of all counts, which remain live accessible HTML.
let artwork: HTMLImageElement | null = null;
let artworkLoading = false;
export function loadQualityArtwork(): void {
  if (artwork || artworkLoading || typeof Image === 'undefined') return;
  artworkLoading = true;
  const image = new Image();
  image.onload = () => {
    artwork = image;
    artworkLoading = false;
    glassDiagnostics.artworkLoads++;
    window.dispatchEvent(new Event('cost-gl-artwork-ready'));
  };
  image.onerror = () => {
    artworkLoading = false;
  };
  image.src = qualityArtworkUrl;
}
const artworkVertex = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = position;
  gl_Position = vec4(position.x * 2. - 1., 1. - position.y * 2., 0., 1.);
}`;
const artworkFragment = `
precision mediump float;
uniform sampler2D material;
uniform vec2 channels;
varying vec2 uv;
void main() {
  vec4 tex = texture2D(material, uv);
  // Texture is uploaded premultiplied, avoiding white RGB from transparent edges.
  float coverage = smoothstep(.004, .035, tex.a);
  float branch = smoothstep(.44, .56, uv.x);
  float separator = .59 + .08 * smoothstep(.5, .95, uv.x);
  float lower = smoothstep(separator - .018, separator + .018, uv.y);
  float selected = mix(channels.x, channels.y, lower);
  float shared = max(channels.x, channels.y);
  float mask = mix(shared, selected, branch);
  float inletTransmission = mix(.24, 1., smoothstep(.015, .40, uv.x));
  float inletEdge = smoothstep(.015, .055, uv.x);
  gl_FragColor = tex * (coverage * mask * inletTransmission * inletEdge);
}`;
/** One cached image, one reused texture/program, no animation or repeated decode. */
export function drawGlassSplit(canvas: HTMLCanvasElement, colors: string[], visible: boolean[]): boolean {
  loadQualityArtwork();
  if (!artwork || document.hidden) return false;
  const shared = getState();
  if (!shared) return false;
  const start = performance.now();
  const {
    gl,
    canvas: bufferCanvas,
    buffer
  } = shared;
  if (!shared.artworkProgram) {
    const program = gl.createProgram()!;
    const vs = compile(gl, gl.VERTEX_SHADER, artworkVertex);
    const fs = compile(gl, gl.FRAGMENT_SHADER, artworkFragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return false;
    }
    shared.artworkProgram = program;
    shared.artworkTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, shared.artworkTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, artwork);
    glassDiagnostics.textureUploads++;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    glassDiagnostics.textureBytes += artwork.naturalWidth * artwork.naturalHeight * 4;
  }
  const width = canvas.clientWidth || 640,
    height = canvas.clientHeight || 140;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  bufferCanvas.width = Math.ceil(width * ratio);
  bufferCanvas.height = Math.ceil(height * ratio);
  gl.viewport(0, 0, bufferCanvas.width, bufferCanvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(shared.artworkProgram);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  for (let index = 0; index < gl.getParameter(gl.MAX_VERTEX_ATTRIBS); index++) gl.disableVertexAttribArray(index);
  const position = gl.getAttribLocation(shared.artworkProgram, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, shared.artworkTexture!);
  gl.uniform1i(gl.getUniformLocation(shared.artworkProgram, 'material'), 0);
  gl.uniform2f(gl.getUniformLocation(shared.artworkProgram, 'channels'), visible[0] ? 1 : 0, visible[1] ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  canvas.width = bufferCanvas.width;
  canvas.height = bufferCanvas.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bufferCanvas, 0, 0);
  if (visible[2]) {
    ctx.save();
    ctx.scale(ratio, ratio);
    ctx.strokeStyle = colors[2] || '#79bdff';
    ctx.globalAlpha = .70;
    ctx.lineWidth = .7;
    ctx.beginPath();
    ctx.moveTo(width * .43, height * .62);
    ctx.bezierCurveTo(width * .61, height * .76, width * .80, height * .68, width * .96, height * .69);
    ctx.stroke();
    ctx.restore();
  }
  glassDiagnostics.renders++;
  glassDiagnostics.vertices = 6;
  glassDiagnostics.lastCpuMs = performance.now() - start;
  glassDiagnostics.totalCpuMs += glassDiagnostics.lastCpuMs;
  glassDiagnostics.maxCpuMs = Math.max(glassDiagnostics.maxCpuMs, glassDiagnostics.lastCpuMs);
  glassDiagnostics.drawingBufferBytes = canvas.width * canvas.height * 4;
  return true;
}
