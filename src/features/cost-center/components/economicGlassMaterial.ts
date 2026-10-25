import filmArtworkUrl from './assets/normalized-silk-atlas.webp';
import type { Chart, LineElement, Plugin } from 'chart.js';
import { filmMesh, loadFilmArtwork, glassGeneration, renderFilms, retainGlassRenderer, type FilmMesh } from './glassChartRenderer';
interface Cached {
  canvas: HTMLCanvasElement;
  key: string;
  generation: number;
  release: () => void;
  restore: () => void;
  visible: boolean;
  observer?: IntersectionObserver;
}
/** The Chart.js quantitative contour stays fixed and is painted last, over the
 * decorative signed optical skin. The skin may lie on either screen-space side
 * of that contour; neither decorative edge is a measured value. Null gaps and
 * true zero crossings split the material. */
export function economicGlassMaterial(enabled: () => boolean, formatPeak: (value: number) => string): Plugin<'line'> {
  const cache = new WeakMap<Chart, Cached>();
  return {
    id: 'economic-webgl-film',
    beforeDatasetsDraw(chart) {
      if (!enabled() || document.hidden || !chart.chartArea) return;
      loadFilmArtwork(filmArtworkUrl);
      const a = chart.chartArea,
        w = a.right - a.left,
        h = a.bottom - a.top;
      if (w < 2 || h < 2) return;
      const first = chart.data.datasets.findIndex((_d, i) => chart.isDatasetVisible(i));
      if (first < 0) return;
      const meta = chart.getDatasetMeta(first),
        line = meta.dataset as LineElement;
      if (!line) return;
      let entry = cache.get(chart);
      if (!entry) {
        const restore = () => chart.draw();
        entry = {
          canvas: document.createElement('canvas'),
          key: '',
          generation: -1,
          release: retainGlassRenderer(),
          restore,
          visible: true
        };
        cache.set(chart, entry);
        if (typeof IntersectionObserver !== 'undefined') {
          const retained = entry;
          retained.observer = new IntersectionObserver(items => {
            const wasVisible = retained.visible;
            retained.visible = items.some(item => item.isIntersecting);
            if (!wasVisible && retained.visible) chart.draw();
          });
          retained.observer.observe(chart.canvas);
        }
        window.addEventListener('cost-gl-restored', restore);
        document.addEventListener('visibilitychange', restore);
      }
      if (!entry.visible) return;
      const ratio = Math.min(2, chart.currentDevicePixelRatio || 1),
        zero = chart.scales.y.getPixelForValue(0);
      const key = JSON.stringify([w, h, zero, ratio, first, meta.data.map(p => [p.x, p.y]), chart.data.datasets[first].data]);
      if (entry.key !== key || entry.generation !== glassGeneration()) {
        line.updateControlPoints(a, 'x');
        const meshes: FilmMesh[] = [];
        for (const segment of line.segments) {
          const p0 = meta.data[segment.start],
            p1 = meta.data[segment.end];
          if (!p0 || !p1 || p1.x <= p0.x) continue;
          const at = (x: number) => {
            const p = line.interpolate({
              x,
              y: 0
            }, 'x');
            return (Array.isArray(p) ? p[0] : p)?.y ?? zero;
          };
          // Separate true zero crossings rather than draw a decorative bridge across them.
          const count = Math.max(2, Math.ceil((p1.x - p0.x) / 4)),
            samples = Array.from({
              length: count + 1
            }, (_, i) => {
              const x = p0.x + (p1.x - p0.x) * i / count;
              return {
                x,
                y: at(x)
              };
            });
          const runs: Array<typeof samples> = [];
          let run: typeof samples = [];
          for (let i = 0; i < samples.length; i++) {
            const p = samples[i],
              prev = samples[i - 1];
            if (prev && (prev.y - zero) * (p.y - zero) < 0) {
              let lo = prev.x,
                hi = p.x;
              for (let j = 0; j < 16; j++) {
                const mid = (lo + hi) / 2;
                if ((at(mid) - zero) * (prev.y - zero) > 0) lo = mid;else hi = mid;
              }
              const cross = {
                x: (lo + hi) / 2,
                y: zero
              };
              run.push(cross);
              if (run.length > 1) runs.push(run);
              run = [cross];
            }
            run.push(p);
          }
          if (run.length > 1) runs.push(run);
          for (const points of runs) {
            const start = points[0].x,
              end = points.at(-1)!.x,
              span = end - start;
            if (span < 1) continue;
            // Authored optical cross sections follow the real Chart.js contour.
            // The atlas contains material only, not data, labels or chart geometry.
            const surfaceAt = (x: number, v: number) => {
              const y = at(x);
              const room = Math.abs(zero - y);
              const delayed = at(Math.min(end, x + w * .065)) - y;
              const width = 10 + Math.min(30, Math.abs(delayed));
              const pinch = Math.min(Math.tanh(room / 10), room / (width * .75));
              const direction = y <= zero ? 1 : -1;
              return {
                x: x - a.left,
                y: y + direction * (v - .25) * width * pinch - a.top,
                z: 0
              };
            };
            const mesh = filmMesh(Math.max(24, Math.ceil(span / 2)), 1,
              (u, v) => surfaceAt(start + span * u, v),
              first === 0 ? '#f4ca70' : typeof chart.data.datasets[first].borderColor === 'string' ? chart.data.datasets[first].borderColor as string : '#79bdff', 1);
            // Keep the material U continuous across null gaps and zero-split runs.
            for (let i = 6; i < mesh.data.length; i += 9) mesh.data[i] = (start - a.left + mesh.data[i] * span) / w;
            meshes.push(mesh);
          }
        }
        if (renderFilms(entry.canvas, w, h, meshes, ratio)) {
          entry.key = key;
          entry.generation = glassGeneration();
        } else {
          entry.key = '';
          return;
        }
      }
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(a.left, a.top, w, h);
      ctx.clip();
      // Very low-energy volume reaches zero; native gradient, not a raster pixel pass.
      const grad = ctx.createLinearGradient(0, a.top, 0, Math.min(a.bottom, zero));
      grad.addColorStop(0, 'rgba(224,180,79,.19)');
      grad.addColorStop(1, 'rgba(224,180,79,.018)');
      ctx.fillStyle = grad;
      for (const segment of line.segments) {
        const p0 = meta.data[segment.start],
          p1 = meta.data[segment.end];
        if (!p0 || !p1 || p1.x <= p0.x) continue;
        ctx.beginPath();
        ctx.moveTo(p0.x, zero);
        for (let x = p0.x; x < p1.x; x += 2) {
          const p = line.interpolate({
            x,
            y: 0
          }, 'x');
          const q = Array.isArray(p) ? p[0] : p;
          if (q && q.y != null) ctx.lineTo(x, q.y);
        }
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p1.x, zero);
        ctx.closePath();
        ctx.fill();
      }
      ctx.drawImage(entry.canvas, a.left, a.top, w, h);
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      if (!enabled()) return;
      const first = chart.data.datasets.findIndex((_d, i) => chart.isDatasetVisible(i));
      if (first < 0) return;
      let peak = -Infinity,
        index = -1;
      chart.data.datasets[first].data.forEach((value, i) => {
        if (typeof value === 'number' && Number.isFinite(value) && value > peak) {
          peak = value;
          index = i;
        }
      });
      if (index < 0) return;
      const point = chart.getDatasetMeta(first).data[index],
        a = chart.chartArea,
        ctx = chart.ctx;
      const text = formatPeak(peak);
      ctx.save();
      ctx.font = '10px Georgia, serif';
      const textWidth = ctx.measureText(text).width;
      const x = Math.min(a.right - textWidth - 2, Math.max(a.left + 2, point.x + 8)),
        y = Math.max(a.top - 3, point.y - 13);
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 221, 154, .45)';
      ctx.lineWidth = .7;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x, chart.scales.y.getPixelForValue(0));
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#ffe8ad';
      ctx.strokeStyle = '#f4d79888';
      ctx.lineWidth = .7;
      ctx.beginPath();
      ctx.moveTo(point.x, point.y - 3);
      ctx.lineTo(point.x, y + 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(text, x, y);
      ctx.restore();
    },
    afterDestroy(chart) {
      const entry = cache.get(chart);
      if (entry) {
        entry.observer?.disconnect();
        entry.release();
        entry.canvas.width = entry.canvas.height = 0;
        window.removeEventListener('cost-gl-restored', entry.restore);
        document.removeEventListener('visibilitychange', entry.restore);
        cache.delete(chart);
      }
    }
  };
}
