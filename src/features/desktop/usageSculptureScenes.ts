import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshPhysicalMaterial,
  CatmullRomCurve3,
  Vector3
} from 'three'
import type { Texture } from 'three'
import { brushedTexture, tokenView } from './usageEfficiencyScene'
export interface SculptureSegment {
  key: string
  count: number
  percent: number
  color: string
}
const material = (color: string, metalness = 0.65) =>
  new MeshPhysicalMaterial({
    color,
    metalness,
    roughness: 0.23,
    clearcoat: 0.7,
    clearcoatRoughness: 0.16,
    envMapIntensity: 1.5
  })
function lazyBrush() {
  let texture: Texture | undefined
  return () => (texture ??= brushedTexture())
}
function ribbonPoint(
  curve: CatmullRomCurve3,
  t: number,
  width: number,
  across: number,
  depth: number,
  side: number,
  phase = 0,
  taper = true
) {
  const center = curve.getPointAt(t),
    tangent = curve.getTangentAt(t)
  const angle = taper ? Math.sin(t * Math.PI * 2 + phase) * 1.15 : -0.5 + Math.sin(t * Math.PI) * 0.28
  const lateral = new Vector3(0, Math.cos(angle), Math.sin(angle))
  lateral.addScaledVector(tangent, -lateral.dot(tangent)).normalize()
  const normal = new Vector3().crossVectors(tangent, lateral).normalize()
  return center
    .addScaledVector(lateral, across * width * (taper ? 0.06 + 0.94 * Math.sin(Math.PI * t) ** 0.65 : 1))
    .addScaledVector(normal, (side * depth) / 2)
}
function ribbon(
  curve: CatmullRomCurve3,
  start: number,
  end: number,
  width: number,
  color: string,
  wire = false,
  phase = 0,
  depth = 0.045,
  brush?: Texture,
  taper = true
) {
  const group = new Group(),
    steps = Math.max(2, Math.ceil((end - start) * 140)),
    positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = []
  const thickness = depth
  for (let i = 0; i <= steps; i++) {
    const t = start + ((end - start) * i) / steps
    for (const [across, side] of [
      [-0.5, 1],
      [0.5, 1],
      [-0.5, -1],
      [0.5, -1]
    ]) {
      positions.push(...ribbonPoint(curve, t, width, across, thickness, side, phase, taper).toArray())
      uvs.push(t * 3, across + 0.5)
    }
    if (i) {
      const a = (i - 1) * 4,
        b = i * 4
      indices.push(
        a,
        a + 1,
        b + 1,
        a,
        b + 1,
        b,
        a + 2,
        b + 3,
        a + 3,
        a + 2,
        b + 2,
        b + 3,
        a,
        b,
        a + 2,
        a + 2,
        b,
        b + 2,
        a + 1,
        a + 3,
        b + 3,
        a + 1,
        b + 3,
        b + 1
      )
    }
  }
  indices.push(
    0,
    2,
    3,
    0,
    3,
    1,
    steps * 4,
    steps * 4 + 1,
    steps * 4 + 3,
    steps * 4,
    steps * 4 + 3,
    steps * 4 + 2
  )
  if (!wire) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    const m = material(color, 0.5),
      texture = brush ?? brushedTexture()
    m.map = texture
    m.roughnessMap = texture
    m.roughness = 0.3
    m.clearcoat = 0.5
    m.envMapIntensity = 0.9
    m.emissive.set(color)
    m.emissiveIntensity = 0.025
    const body = new Mesh(geometry, m)
    body.castShadow = true
    body.receiveShadow = true
    group.add(body)
  }
  const traces: number[] = []
  const traceCount = wire ? 8 : 16
  for (let line = 0; line < traceCount; line++)
    for (let i = 0; i < steps; i++) {
      const across = line / (traceCount - 1) - 0.5
      for (const t of [start + ((end - start) * i) / steps, start + ((end - start) * (i + 1)) / steps])
        traces.push(...ribbonPoint(curve, t, width, across, thickness + 0.003, 1, phase, taper).toArray())
    }
  if (wire)
    for (let i = 0; i <= steps; i += 3) {
      const t = start + ((end - start) * i) / steps
      for (const across of [-0.5, 0.5])
        traces.push(...ribbonPoint(curve, t, width, across, thickness + 0.003, 1, phase, taper).toArray())
    }
  if (wire)
    for (const t of [start, end])
      for (const across of [-0.5, 0.5])
        for (const side of [-1, 1])
          traces.push(...ribbonPoint(curve, t, width, across, thickness, side, phase, taper).toArray())
  if (wire) {
    for (const across of [-0.5, 0.5])
      for (let i = 0; i < steps; i++)
        for (const t of [start + ((end - start) * i) / steps, start + ((end - start) * (i + 1)) / steps])
          traces.push(...ribbonPoint(curve, t, width, across, thickness, -1, phase, taper).toArray())
    for (const t of [start, end])
      for (const across of [-0.5, 0.5])
        traces.push(...ribbonPoint(curve, t, width, across, thickness, -1, phase, taper).toArray())
  }
  const lineGeometry = new BufferGeometry()
  lineGeometry.setAttribute('position', new Float32BufferAttribute(traces, 3))
  group.add(
    new LineSegments(
      lineGeometry,
      new LineBasicMaterial({
        color: wire ? color : '#c4ffe9',
        transparent: true,
        opacity: wire ? 0.65 : 0.12
      })
    )
  )
  return group
}
export function buildTokenAllocation(rows: SculptureSegment[]) {
  const root = new Group()
  root.name = 'token-allocation'
  root.userData.anchors = { zero: [3.0, -1.3, 0], full: [3.0, 2.1, 0] }
  const depthOrder = [...rows].sort((a, b) => a.percent - b.percent).map((row) => row.key)
  const brush = lazyBrush()
  rows.forEach((row, i) => {
    const y = -1.3 + (row.percent / 100) * 3.4,
      endX = 2.65 + i * 0.18
    // Separate the three sheets in depth without changing their projected data height.
    const depth = (depthOrder.indexOf(row.key) - (rows.length - 1) / 2) * 2.2
    const lift = (depth * (tokenView.eye[1] - tokenView.target[1])) / (tokenView.eye[2] - tokenView.target[2])
    root.userData.anchors[row.key] = [endX, y + lift, depth]
    if (row.count <= 0 || row.percent <= 0) return
    const curve = new CatmullRomCurve3(
      [
        new Vector3(-4.65, -0.7 + i * 0.38, -0.2),
        new Vector3(-3.2, 0.6 - i * 0.6, 0.15 + i * 0.2),
        new Vector3(-1.65, -0.4 + i * 0.32, 0.5 - i * 0.38),
        new Vector3(0.1, 0.35 - i * 0.32, 0.4),
        new Vector3(1.6, y * 0.7 + 0.2, 0.1 + i * 0.35),
        new Vector3(endX, y, 0)
      ].map((point) => point.add(new Vector3(0, lift, depth)))
    )
    const group = ribbon(curve, 0, 1, 0.85, row.color, false, i * 1.7, 0.07, brush())
    group.name = row.key
    group.userData = { count: row.count, percent: row.percent }
    root.add(group)
  })
  return root
}
export function buildCoverageAssembly(rows: SculptureSegment[]) {
  const root = new Group()
  root.name = 'coverage-assembly'
  root.userData.anchors = {}
  const curve = new CatmullRomCurve3([
    new Vector3(-4.1, -0.5, 0),
    new Vector3(-2.9, 0.5, 0.2),
    new Vector3(-1.4, 0.7, -0.2),
    new Vector3(0.1, -0.25, 0.25),
    new Vector3(1.9, 0.2, 0.1),
    new Vector3(4.1, 0.45, 0)
  ])
  const brush = lazyBrush()
  let offset = 0
  rows.forEach((row) => {
    const start = offset,
      end = Math.min(1, offset + row.percent / 100)
    offset = end
    const point = curve.getPointAt((start + end) / 2)
    root.userData.anchors[row.key] = point.toArray()
    if (row.count <= 0 || end <= start) return
    const group = ribbon(
      curve,
      start,
      end,
      1.25,
      row.color,
      row.key === 'unknown',
      0.6,
      0.09,
      row.key === 'unknown' ? undefined : brush()
    )
    group.name = row.key
    group.userData = { count: row.count, percent: row.percent, range: [start, end] }
    root.add(group)
  })
  return root
}
export function buildEvidenceLanes(
  rows: Array<{ label: string; counts?: Record<string, number> | null; segments: SculptureSegment[] }>,
  viewportWidth = 1280
) {
  const root = new Group()
  root.name = 'evidence-lanes'
  root.userData.anchors = {}
  const brush = lazyBrush()
  rows.forEach((row, index) => {
    const y =
      ((rows.length - 1) / 2 - index) * (viewportWidth <= 480 ? 3.8 : viewportWidth <= 750 ? 2.85 : 1.85) +
      (viewportWidth <= 480 ? 1.4 : 0)
    const lane = new Group()
    lane.name = row.label
    root.userData.anchors[row.label] = [-4.8, y, 0]
    const curve = new CatmullRomCurve3([
      new Vector3(-2.8, y, -0.05),
      new Vector3(-1.5, y + 0.13, 0.2),
      new Vector3(0.1, y - 0.06, 0.5),
      new Vector3(1.7, y + 0.12, 0.15),
      new Vector3(3.3, y, 0)
    ])
    const segments = row.counts
      ? row.segments.filter((s) => s.count > 0)
      : [{ key: 'unknown', count: 0, percent: 100, color: '#708477' }]
    let start = 0
    segments.forEach((item) => {
      const end = Math.min(1, start + item.percent / 100)
      const band = ribbon(
        curve,
        start,
        end,
        viewportWidth <= 480 ? 0.7 : viewportWidth <= 750 ? 0.6 : 0.48,
        item.color,
        item.key === 'unknown',
        0,
        0.06,
        item.key === 'unknown' ? undefined : brush(),
        false
      )
      band.name = item.key
      band.userData = { count: item.count, percent: item.percent, range: [start, end] }
      lane.add(band)
      root.userData.anchors[row.label + ':' + item.key] = curve.getPointAt((start + end) / 2).toArray()
      start = end
    })
    root.add(lane)
  })
  return root
}
