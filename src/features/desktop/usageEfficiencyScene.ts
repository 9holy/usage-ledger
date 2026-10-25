import {
  ACESFilmicToneMapping, AmbientLight, BufferGeometry, Color, DataTexture,
  DirectionalLight, Group, HemisphereLight, LineBasicMaterial,
  LinearFilter, LinearMipmapLinearFilter, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, OrthographicCamera,
  VSMShadowMap, PlaneGeometry, PMREMGenerator, RepeatWrapping, RGBAFormat, Scene, ShadowMaterial,
  SRGBColorSpace, ShaderMaterial, Texture, Vector3, WebGLRenderer,
} from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'
import { usageColors, usageCoverageColors } from './usageChartPalette'
import i18n from '@/i18n'

export const efficiencyColors = { hit: usageColors.cache, miss: usageColors.input, ...usageCoverageColors } as const
export type CoverageState = 'known' | 'unknown' | 'missing'
export interface CoveragePart { state: CoverageState; count: number; percent: number }
type Point = [number, number, number]
export const tokenView = { eye:[0,1.1,16] as Point, target:[0,.25,0] as Point, floor:-1.85, width:5.5 }

export function brushedTexture() {
  const size = 256, data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const across = x + y * .62
    const random = Math.sin(Math.floor(across * .7) * 78.233) * 43758.5453
    const hairline = random - Math.floor(random)
    const bandNoise = Math.sin(Math.floor(across * .13) * 41.327) * 35216.23
    const band = bandNoise - Math.floor(bandNoise)
    const grain = 180 + Math.round(hairline * 55 + band * 20)
    const offset = (y * size + x) * 4
    data.set([grain, grain, grain, 255], offset)
  }
  const texture = new DataTexture(data, size, size, RGBAFormat)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.repeat.set(2, 1)
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}
function release(root: Object3D) {
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>(), textures = new Set<Texture>()
  root.traverse(object => {
    const item = object as Mesh
    if (item.geometry) geometries.add(item.geometry)
    if (item.material) for (const material of Array.isArray(item.material) ? item.material : [item.material]) {
      materials.add(material)
      if (material instanceof MeshStandardMaterial && material.roughnessMap) textures.add(material.roughnessMap)
      if (material instanceof MeshStandardMaterial && material.map) textures.add(material.map)
    }
  })
  geometries.forEach(geometry => geometry.dispose())
  materials.forEach(material => material.dispose())
  textures.forEach(texture => texture.dispose())
}

export type SculptureKind = 'token' | 'coverage' | 'evidence'
export function createEfficiencyStage(host: HTMLElement, kind: SculptureKind, failed: (message: string) => void) {
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  let renderer: WebGLRenderer
  try { renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' }) }
  catch { failed(i18n.global.t('usageMonitor.format.sceneUnavailable')); return null }
  // Fine round strands need supersampling even on a 1x display to avoid moire.
  renderer.setPixelRatio(Math.min(2, Math.max(window.devicePixelRatio || 1, 1.75)))
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = VSMShadowMap
  renderer.shadowMap.autoUpdate = false
  renderer.shadowMap.needsUpdate = true
  renderer.setClearColor(0x000000, 0)
  host.append(canvas)
  const scene = new Scene()
  const camera = new OrthographicCamera(-5, 5, 2.5, -2.5, .1, 80)
  const settings = { token: tokenView, coverage: { eye:[0,1.4,14], target:[0,0,0], floor:-1.4, width:4.8 }, evidence: { eye:[0,1.2,16], target:[0,0,0], floor:-3.4, width:5.5 } }[kind]
  const cameraTarget = new Vector3(...settings.target as Point)
  camera.position.set(...settings.eye as Point)
  camera.lookAt(cameraTarget)
  // Dark studio with large strip lights: broad white room reflections flatten
  // polished cables into a pale sheet instead of showing their round sections.
  const room = new Scene(), pmrem = new PMREMGenerator(renderer)
  room.background = new Color('#020906')
  for (const [width, height, position, color, intensity] of [
    [8, 2, [-3, 6, 5], '#d7fff1', 3.0],
    [2, 6, [5, 2, -4], '#64e9ce', 2.2],
    [9, 3, [-1, -2, 7], '#b7f3dc', 1.3],
    [10, 4, [0, 4, -7], '#b8ffe0', 2.5],
    [2, 4, [-6, 1, 3], '#e5fff6', 1.4],
  ] as [number, number, Point, string, number][]) {
    const panel = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity), toneMapped: false }))
    panel.position.set(...position)
    panel.lookAt(0, 0, 0)
    room.add(panel)
  }
  const environment = pmrem.fromScene(room, .04)
  scene.environment = environment.texture
  scene.environmentIntensity = .48
  release(room); pmrem.dispose()
  scene.add(new AmbientLight('#c9e1d2', .1), new HemisphereLight('#e5fff7', '#18221c', .3))
  const key = new DirectionalLight('#ebfff7', 1.35)
  key.position.set(-3, 6, 4)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.radius = 12
  key.shadow.blurSamples = 12
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 4, bottom: -4, near: .1, far: 30 })
  key.shadow.bias = -.0005
  key.shadow.normalBias = .01
  const edge = new DirectionalLight('#80ffe0', 2.6)
  edge.position.set(4, 3, -3)
  const front = new DirectionalLight('#effff7', .8)
  front.position.set(-1, 1, 8)
  scene.add(key, edge, front)
  const floor = new Mesh(new PlaneGeometry(30, 20), new ShadowMaterial({ opacity: .18, depthWrite: false }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = settings.floor
  floor.receiveShadow = true
  floor.renderOrder = 2
  scene.add(floor)
  const ground = new Mesh(new PlaneGeometry(13, 8), new ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 groundUv; void main(){ groundUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `varying vec2 groundUv;
      void main(){
        vec2 p=(groundUv-.5)*vec2(2.0,2.8);
        float fade=exp(-3.0*dot(p,p));
        float grain=fract(sin(dot(groundUv*1800.0,vec2(12.9898,78.233)))*43758.5453);
        gl_FragColor=vec4(vec3(.07,.22,.17)*(0.7+grain*.45),fade*.4);
      }`,
  }))
  ground.renderOrder = 1
  ground.rotation.x = -Math.PI / 2
  ground.position.y = floor.position.y - .002
  scene.add(ground)
  const reflection = new Reflector(new PlaneGeometry(30, 20), { color: '#93a89b', textureWidth: 768, textureHeight: 384, multisample: 0 })
  const mirrorMaterial = reflection.material as ShaderMaterial
  mirrorMaterial.vertexShader = 'varying float reflectedFloorZ;\n' + mirrorMaterial.vertexShader.replace('vUv = textureMatrix * vec4( position, 1.0 );', 'vUv = textureMatrix * vec4( position, 1.0 ); reflectedFloorZ = (modelMatrix * vec4(position, 1.0)).z;')
  mirrorMaterial.fragmentShader = 'varying float reflectedFloorZ;\n' + mirrorMaterial.fragmentShader.replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );', `float fade = pow(clamp(1.0 - max(0.0, reflectedFloorZ - 0.7) / 2.0, 0.0, 1.0), 3.0); gl_FragColor = vec4(blendOverlay(base.rgb, color), .12 * fade * base.a);`)
  mirrorMaterial.fragmentShader = mirrorMaterial.fragmentShader.replace('vec4 base = texture2DProj( tDiffuse, vUv );', `
    vec2 uv = vUv.xy / vUv.w;
    float spread = 0.001 + max(0.0, reflectedFloorZ - 0.7) * 0.0015;
    vec2 blur = vec2(spread, spread * 2.0);
    vec4 base = texture2D(tDiffuse, uv) * 0.4;
    base += texture2D(tDiffuse, uv + vec2(blur.x, 0.0)) * 0.15;
    base += texture2D(tDiffuse, uv - vec2(blur.x, 0.0)) * 0.15;
    base += texture2D(tDiffuse, uv + vec2(0.0, blur.y)) * 0.15;
    base += texture2D(tDiffuse, uv - vec2(0.0, blur.y)) * 0.15;
  `)
  mirrorMaterial.transparent = true
  mirrorMaterial.depthWrite = false
  reflection.rotation.x = -Math.PI / 2
  reflection.position.y = floor.position.y - .004
  scene.add(reflection)

  let content = new Group(), frame = 0, lost = false, disposed = false
  scene.add(content)
  const draw = () => {
    frame = 0
    if (!disposed && !lost) renderer.render(scene, camera)
  }
  const invalidate = () => { if (!frame && !disposed) frame = requestAnimationFrame(draw) }
  const stopFrame = () => { if (frame) cancelAnimationFrame(frame); frame = 0 }
  const visibility = () => { if (document.hidden) stopFrame(); else invalidate() }
  document.addEventListener('visibilitychange', visibility)
  host.dataset.materialReady = 'true'
  const resize = () => {
    const { width, height } = host.getBoundingClientRect()
    if (!width || !height) return
    const halfWidth = settings.width
    camera.left = -halfWidth; camera.right = halfWidth
    camera.top = halfWidth * height / width; camera.bottom = -camera.top
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    renderer.shadowMap.needsUpdate = true
    invalidate()
  }
  const contextLost = (event: Event) => { event.preventDefault(); lost = true; failed(i18n.global.t('usageMonitor.format.sceneInterrupted')) }
  const contextRestored = () => { lost = false; failed(''); invalidate() }
  canvas.addEventListener('webglcontextlost', contextLost)
  canvas.addEventListener('webglcontextrestored', contextRestored)
  resize()
  const project = (point: Point) => {
    camera.updateMatrixWorld()
    const projected = new Vector3(...point).project(camera)
    return { x: (projected.x + 1) * 50, y: (1 - projected.y) * 50 }
  }
  return {
    resize,
    anchors(): Record<string, { x: number; y: number }> {
      return Object.fromEntries(Object.entries(content.userData.anchors ?? {}).map(([key, point]) => [key, project(point as Point)]))
    },
    replace(next: Group) {
      scene.remove(content); release(content); content = next
      scene.add(content); invalidate()
      renderer.shadowMap.needsUpdate = true
    },
    focus(name: string | null) {
      content.children.forEach(group => {
        group.traverse(object => {
          const material = (object as Mesh).material
          for (const item of material ? Array.isArray(material) ? material : [material] : []) {
            if (item instanceof MeshStandardMaterial) {
              item.userData.restEmissive ??= item.emissive.clone()
              item.emissive.copy(item.userData.restEmissive as Color)
              if (name === group.name) item.emissive.add(item.color.clone().multiplyScalar(.18))
            }
            if (item instanceof MeshBasicMaterial) {
              item.userData.restColor ??= item.color.clone()
              item.color.copy(item.userData.restColor as Color).multiplyScalar(name === group.name ? 1.08 : 1)
            }
            if (item instanceof LineBasicMaterial) {
              item.userData.restColor ??= item.color.clone()
              item.userData.restOpacity ??= item.opacity
              item.color.copy(item.userData.restColor as Color)
              item.opacity = item.userData.restOpacity as number
              if (name === group.name) { item.color.lerp(new Color('#e7fff4'), .2); item.opacity = Math.min(1, item.opacity + .2) }
            }
          }
        })
      })
      invalidate()
    },
    dispose() {
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('webglcontextlost', contextLost)
      canvas.removeEventListener('webglcontextrestored', contextRestored)
      release(scene)
      environment.dispose()
      reflection.getRenderTarget().dispose()
      key.shadow.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}


