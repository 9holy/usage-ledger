import {
  frontSurface,
  rearSurface,
  type RibbonStop,
} from "./cacheRibbonSurface";

export type Point = { x: number; y: number };
export type Ribbon = {
  body: string;
  highlight: string;
  softHighlight: string;
  shade: string;
  center: string;
  stops: RibbonStop[];
  index: number;
  strokeWidth: number;
};
export type CacheRibbonGeometry = {
  front: Ribbon[];
  rear: Ribbon[];
  miss: Ribbon[];
  shadow: string;
  anchors: Record<string, Point>;
  hitShare: number | null;
  missShare: number | null;
};
const left = 104,
  right = 676;
export function curveHeight(points: Point[], x: number) {
  x = Math.max(points[0].x, Math.min(points[points.length - 1].x, x));
  let i = 0;
  while (i < points.length - 2 && points[i + 1].x < x) i++;
  const p0 = points[Math.max(0, i - 1)],
    p1 = points[i],
    p2 = points[i + 1],
    p3 = points[Math.min(points.length - 1, i + 2)];
  const h = p2.x - p1.x,
    t = (x - p1.x) / h;
  const m1 = (p2.y - p0.y) / (p2.x - p0.x),
    m2 = (p3.y - p1.y) / (p3.x - p1.x);
  return (
    (2 * t ** 3 - 3 * t * t + 1) * p1.y +
    (t ** 3 - 2 * t * t + t) * h * m1 +
    (-2 * t ** 3 + 3 * t * t) * p2.y +
    (t ** 3 - t * t) * h * m2
  );
}
export function pathAt(points: Point[], x: number): Point & { angle: number } {
  const before = Math.max(left, x - 0.5),
    after = Math.min(right, x + 0.5);
  return {
    x,
    y: curveHeight(points, x),
    angle:
      (Math.atan2(
        curveHeight(points, after) - curveHeight(points, before),
        after - before,
      ) *
        180) /
      Math.PI,
  };
}
const path = (points: Point[]) =>
  "M" + points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join("L");
const samples = Array.from({ length: 287 }, (_, i) => left + i * 2);
function makeRibbon(
  stops: RibbonStop[],
  index: number,
  width: (x: number, normal: number) => number,
): Ribbon {
  const top: Point[] = [],
    bottom: Point[] = [],
    highlightTop: Point[] = [],
    highlightBottom: Point[] = [],
    softTop: Point[] = [],
    softBottom: Point[] = [],
    shadeTop: Point[] = [],
    shadeBottom: Point[] = [],
    center: Point[] = [];
  for (const x of samples) {
    const y = curveHeight(stops, x),
      before = Math.max(left, x - 0.5),
      after = Math.min(right, x + 0.5);
    const dy =
      (curveHeight(stops, after) - curveHeight(stops, before)) /
      (after - before);
    const n = Math.hypot(1, dy),
      w = width(x, n);
    const offset = (distance: number) => ({
      x: x - (dy / n) * distance,
      y: y + distance / n,
    });
    top.push(offset(-w / 2));
    bottom.unshift(offset(w / 2));
    const roll =
      0.12 * Math.exp(-(((x - 250) / 65) ** 2)) -
      0.05 * Math.exp(-(((x - 520) / 70) ** 2));
    const face = (fraction: number) =>
      offset(w * Math.max(-0.5, Math.min(0.5, fraction)));
    highlightTop.push(face(-0.38 + roll));
    highlightBottom.unshift(face(-0.2 + roll));
    softTop.push(face(-0.48 + roll));
    softBottom.unshift(face(0.04 + roll));
    shadeTop.push(face(0.12 + roll * 0.4));
    shadeBottom.unshift(face(0.49));
    center.push({ x, y });
  }
  return {
    body: path(top.concat(bottom)) + "Z",
    highlight: path(highlightTop.concat(highlightBottom)) + "Z",
    softHighlight: path(softTop.concat(softBottom)) + "Z",
    shade: path(shadeTop.concat(shadeBottom)) + "Z",
    center: path(center),
    stops,
    index,
    strokeWidth: width(390, 1),
  };
}
const blueGuide: Point[] = [
  [104, 145],
  [150, 154],
  [190, 189],
  [220, 213],
  [280, 239],
  [340, 253],
  [420, 261],
  [500, 262],
  [550, 251],
  [590, 227],
  [620, 190],
  [650, 157],
  [676, 144],
].map(([x, y]) => ({ x, y }));
export function buildCacheRibbonGeometry(
  value: number | null,
  viewportWidth = 760,
): CacheRibbonGeometry {
  const ratio =
    value != null && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : null;
  const result: CacheRibbonGeometry = {
    front: [],
    rear: [],
    miss: [],
    shadow: "",
    anchors: {},
    hitShare: ratio,
    missShare: ratio == null ? null : 1 - ratio,
  };
  if (ratio == null) return result;
  const optical = Math.min(1.8, Math.sqrt(760 / Math.max(200, viewportWidth)));
  if (ratio > 0) {
    const scale = Math.sqrt(ratio / 0.975);
    const frontCount = Math.max(
      9,
      Math.min(frontSurface.length, Math.round(viewportWidth / 45)),
    );
    const rearCount = Math.max(5, Math.min(11, Math.round(viewportWidth / 65)));
    const select = (rows: RibbonStop[][], count: number) =>
      Array.from({ length: count }, (_, i) => {
        const position = (i * (rows.length - 1)) / Math.max(1, count - 1);
        const lower = Math.floor(position),
          upper = Math.ceil(position),
          blend = position - lower;
        return rows[lower].map((point, j) => ({
          ...point,
          y:
            140 +
            (point.y * (1 - blend) + rows[upper][j].y * blend - 140) * scale,
        }));
      });
    const front = select(frontSurface, frontCount),
      rear = select(rearSurface, rearCount);
    result.front = front.map((stops, i) =>
      makeRibbon(stops, i, (x, n) => {
        const lower = Math.max(0, i - 1),
          upper = Math.min(front.length - 1, i + 1);
        const gap =
          Math.abs(
            curveHeight(front[upper], x) - curveHeight(front[lower], x),
          ) /
          (upper - lower) /
          n;
        const compression =
          1 +
          0.3 * Math.exp(-(((x - 245) / 45) ** 2)) +
          0.12 * Math.exp(-(((x - 500) / 55) ** 2));
        return (
          1.1 *
          compression *
          Math.min(
            7 * optical * scale,
            Math.max(
              1.6 * optical * scale,
              1.5 * scale * Math.max(0, Math.min(1, (260 - x) / 70)) +
                0.8 * gap,
            ),
          )
        );
      }),
    );
    result.rear = rear.map((stops, i) =>
      makeRibbon(stops, i, (x, n) => {
        const lower = Math.max(0, i - 1),
          upper = Math.min(rear.length - 1, i + 1);
        const gap =
          Math.abs(curveHeight(rear[upper], x) - curveHeight(rear[lower], x)) /
          (upper - lower) /
          n;
        return Math.max(
          (1.7 + 1.4 * Math.max(0, Math.min(1, (400 - x) / 100))) *
            optical *
            scale,
          0.84 * gap,
        );
      }),
    );
    const shadowDepth = (x: number) =>
      (3 + 9 * Math.exp(-(((x - 250) / 25) ** 2))) * scale;
    const upper = samples.map((x) => ({
        x,
        y: curveHeight(front[0], x) + shadowDepth(x),
      })),
      lower = [...samples]
        .reverse()
        .map((x) => ({
          x,
          y: curveHeight(front[front.length - 1], x) + shadowDepth(x),
        }));
    result.shadow = path(upper.concat(lower)) + "Z";
    result.anchors.hit = pathAt(front[Math.min(2, front.length - 1)], 200);
  }
  const miss = 1 - ratio;
  if (miss > 0) {
    const count = miss <= 0.08 ? 1 : Math.ceil(miss * 12);
    result.miss = Array.from({ length: count }, (_, i) => {
      const spread = count === 1 ? 0 : (i / (count - 1)) * 34 * Math.sqrt(miss);
      const stops = blueGuide.map((p) => ({
        ...p,
        y: p.y - spread * Math.sin((Math.PI * (p.x - left)) / (right - left)),
        colors: ["#074399", "#0d8dff", "#bdedff"] as [string, string, string],
      }));
      return makeRibbon(
        stops,
        i,
        () => 4.8 * Math.sqrt(miss / count / 0.025) * optical,
      );
    });
    result.anchors.miss = pathAt(result.miss[0].stops, 412);
  }
  return result;
}
