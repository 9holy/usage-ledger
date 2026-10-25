<script lang="ts">
let nextCacheId = 0;
</script>
<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  buildCacheRibbonGeometry,
  pathAt,
  type Ribbon,
} from "./cacheRibbonGeometry";
import cacheMaterialUrl from "@/assets/usage/cache-ribbon-material.png";
import {
  createCacheRibbonMaterial,
  type CacheRibbonMaterialRenderer,
} from "./cacheRibbonMaterial";
const materialImage = ref<string | null>(null);
let materialRenderer: CacheRibbonMaterialRenderer | null = null;
let materialPromise: Promise<CacheRibbonMaterialRenderer | null> | undefined;
let materialVersion = 0,
  mounted = false;
const floorLights = [
  [90, 192, 4, 6, 6],
  [355, 192, 0, 0, 0],
  [660, 192, 8, 18, 18],
  [90, 215, 4, 3, 3],
  [220, 226, 4, 13, 17],
  [355, 215, 9, 34, 31],
  [500, 226, 1, 5, 7],
  [660, 226, 4, 2, 6],
  [220, 267, 4, 11, 13],
  [355, 267, 17, 24, 26],
  [500, 267, 0, 3, 3],
  [660, 267, 1, 3, 4],
];
const props = withDefaults(
  defineProps<{ ratio: number | null; motion?: boolean }>(),
  { motion: true },
);
const emit = defineEmits<{
  anchors: [Record<string, { x: number; y: number }>];
}>();
const prefix = `cache-${++nextCacheId}`;
const uid = (name: string) => `${prefix}-${name}`;
const paint = (name: string) => `url(#${uid(name)})`;
const canvas = ref<HTMLCanvasElement>(),
  rendered = ref(false);
let paintVersion = 0,
  disposed = false,
  rasterScheduled = false;
const pendingUrls = new Set<string>();
const host = ref<SVGSVGElement>(),
  width = ref(760),
  clock = ref(0),
  focused = ref<string | null>(null);
const geometry = computed(() =>
  buildCacheRibbonGeometry(props.ratio, width.value),
);
const floorColor = (light: number[], index: number) => {
  const strength = index === 5 ? Math.sqrt(geometry.value.hitShare ?? 0) : 1;
  return `rgb(${light
    .slice(2)
    .map((value) => Math.round(value * strength))
    .join(",")})`;
};
const materialDilation = computed(() =>
  Math.min(0.8, Math.max(0, 2 * (760 / width.value - 1))),
);
const rows = computed(() =>
  (["rear", "front", "miss"] as const).flatMap((kind) =>
    geometry.value[kind].map((row) => ({
      ...row,
      key: `${kind}-${row.index}`,
    })),
  ),
);
watch(
  geometry,
  (value) =>
    emit(
      "anchors",
      Object.fromEntries(
        Object.entries(value.anchors).map(([key, p]) => [
          key,
          { x: (p.x / 760) * 100, y: ((p.y - 9) / 271) * 100 },
        ]),
      ),
    ),
  { immediate: true },
);
function marker(
  row: Ribbon | undefined,
  start: number,
  group: "hit" | "miss",
  double = true,
) {
  if (!row) return null;
  const progress = ((start - 104) / 572 + clock.value / 12) % 1,
    x = 104 + progress * 572;
  const point = pathAt(row.stops, x);
  return {
    ...point,
    group,
    double,
    opacity: Math.min(1, progress / 0.04, (1 - progress) / 0.04),
  };
}
const markers = computed(() => {
  const { front, rear, miss } = geometry.value;
  const row = (list: Ribbon[], fraction: number) =>
    list[Math.round((list.length - 1) * fraction)];
  return [
    marker(row(rear, 0.5), 238, "hit", false),
    marker(row(front, 0.5), 414, "hit"),
    marker(row(rear, 0.3), 606, "hit"),
    marker(miss[0], 260, "miss"),
    marker(miss[0], 398, "miss", false),
    marker(miss[0], 588, "miss"),
  ].filter((value): value is NonNullable<typeof value> => value != null);
});
async function rasterize() {
  if (rasterScheduled) return;
  rasterScheduled = true;
  await nextTick();
  rasterScheduled = false;
  if (disposed || !host.value || !canvas.value) return;
  const box = host.value.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const version = ++paintVersion,
    dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
  const clone = host.value.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll("[data-flow]").forEach((mark) => mark.remove());
  clone.removeAttribute("class");
  clone.removeAttribute("style");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(Math.round(box.width * dpr)));
  clone.setAttribute("height", String(Math.round(box.height * dpr)));
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], {
      type: "image/svg+xml;charset=utf-8",
    }),
  );
  pendingUrls.add(url);
  const bitmap = new Image();
  bitmap.onload = () => {
    URL.revokeObjectURL(url);
    pendingUrls.delete(url);
    if (disposed || version !== paintVersion || !canvas.value) return;
    const context = canvas.value.getContext("2d");
    if (!context) return;
    canvas.value.width = Math.round(box.width * dpr);
    canvas.value.height = Math.round(box.height * dpr);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.value.width, canvas.value.height);
    rendered.value = true;
  };
  bitmap.onerror = () => {
    URL.revokeObjectURL(url);
    pendingUrls.delete(url);
    if (version === paintVersion) rendered.value = false;
  };
  bitmap.src = url;
}
async function updateMaterial() {
  const version = ++materialVersion,
    shape = geometry.value,
    panelWidth = width.value;
  materialImage.value = null;
  if (!mounted || disposed || !shape.front.length) return;
  materialPromise ??= createCacheRibbonMaterial(cacheMaterialUrl)
    .then((renderer) => {
      if (disposed) {
        renderer?.dispose();
        return null;
      }
      materialRenderer = renderer;
      return renderer;
    })
    .catch(() => null);
  const renderer = await materialPromise;
  if (!renderer || disposed || version !== materialVersion) return;
  try {
    materialImage.value = renderer.render(shape, panelWidth);
  } catch {
    materialImage.value = null;
  }
}
watch(geometry, updateMaterial, { flush: "post" });
watch([geometry, focused, materialImage], rasterize, { flush: "post" });
let frame = 0,
  previous = 0,
  last = 0,
  inView = true;
let resize: ResizeObserver | undefined,
  intersection: IntersectionObserver | undefined,
  media: MediaQueryList | undefined;
const allowed = () =>
  props.motion &&
  geometry.value.hitShare != null &&
  inView &&
  !document.hidden &&
  !media?.matches;
function tick(now: number) {
  frame = 0;
  if (!allowed()) {
    previous = 0;
    return;
  }
  if (!previous) previous = now;
  if (now - last >= 33) {
    clock.value += Math.min(0.1, (now - previous) / 1000);
    previous = now;
    last = now;
  }
  frame = requestAnimationFrame(tick);
}
function syncMotion() {
  if (allowed() && !frame) frame = requestAnimationFrame(tick);
  else if (!allowed() && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
  }
}
watch(
  () => props.motion,
  () => {
    clock.value = 0;
    syncMotion();
  },
);
watch(() => geometry.value.hitShare, syncMotion);
onMounted(() => {
  mounted = true;
  void updateMaterial();
  const measure = () => {
    if (host.value?.clientWidth) width.value = host.value.clientWidth;
    void rasterize();
  };
  measure();
  resize = new ResizeObserver(measure);
  if (host.value) resize.observe(host.value);
  media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", syncMotion);
  if (typeof IntersectionObserver !== "undefined") {
    intersection = new IntersectionObserver((entries) => {
      inView = entries[0]?.isIntersecting ?? true;
      syncMotion();
    });
    if (host.value) intersection.observe(host.value);
  }
  document.addEventListener("visibilitychange", syncMotion);
  syncMotion();
});
onBeforeUnmount(() => {
  disposed = true;
  materialVersion++;
  materialRenderer?.dispose();
  paintVersion++;
  pendingUrls.forEach((url) => URL.revokeObjectURL(url));
  pendingUrls.clear();
  if (frame) cancelAnimationFrame(frame);
  resize?.disconnect();
  intersection?.disconnect();
  media?.removeEventListener("change", syncMotion);
  document.removeEventListener("visibilitychange", syncMotion);
});
defineExpose({
  focus: (group: string | null) => {
    focused.value = group;
  },
});
</script>
<template>
  <div class="cache-illustration">
    <canvas
      ref="canvas"
      class="cache-raster"
      :class="{ ready: rendered }"
      aria-hidden="true"
    />
    <svg
      ref="host"
      v-memo="[geometry, focused, rendered, materialImage]"
      class="cache-ribbon"
      :class="{ rasterized: rendered }"
      viewBox="0 9 760 271"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      :data-hit-share="geometry.hitShare"
      :data-miss-share="geometry.missShare"
    >
      <defs>
        <filter :id="uid('blur')" x="-20%" y="-100%" width="140%" height="300%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter
          :id="uid('occlusion')"
          x="-5%"
          y="-10%"
          width="110%"
          height="120%"
        >
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <filter :id="uid('grain')">
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".75"
            numOctaves="2"
            seed="19"
          />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope=".025" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" />
          <feBlend in="SourceGraphic" mode="soft-light" />
        </filter>

        <filter
          :id="uid('material-optics')"
          x="-1%"
          y="-1%"
          width="102%"
          height="102%"
        >
          <feMorphology
            in="SourceGraphic"
            operator="dilate"
            :radius="materialDilation"
            result="thicker"
          />
          <feComposite
            in="thicker"
            in2="SourceGraphic"
            operator="arithmetic"
            k2=".65"
            k3=".35"
          />
        </filter>
        <filter
          :id="uid('profile-soften')"
          x="-5%"
          y="-5%"
          width="110%"
          height="110%"
        >
          <feGaussianBlur stdDeviation=".28" />
        </filter>
        <filter :id="uid('metal-grain')">
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".8"
            numOctaves="3"
            seed="7"
          />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope=".14" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" />
          <feBlend in="SourceGraphic" mode="soft-light" />
        </filter>
        <radialGradient
          v-for="(light, i) in floorLights"
          :id="uid(`floor-${i}`)"
          :key="i"
        >
          <stop :stop-color="floorColor(light, i)" />
          <stop
            offset=".5"
            :stop-color="floorColor(light, i)"
            stop-opacity=".368"
          />
          <stop
            offset=".75"
            :stop-color="floorColor(light, i)"
            stop-opacity=".105"
          />
          <stop
            offset="1"
            :stop-color="floorColor(light, i)"
            stop-opacity="0"
          />
        </radialGradient>
        <linearGradient
          :id="uid('reflection-strength')"
          gradientUnits="userSpaceOnUse"
          x1="0"
          x2="760"
          y1="0"
          y2="0"
        >
          <stop stop-color="white" stop-opacity=".05" />
          <stop offset=".27" stop-color="white" stop-opacity=".15" />
          <stop offset=".46" stop-color="white" stop-opacity="1" />
          <stop offset=".58" stop-color="white" stop-opacity=".15" />
          <stop offset="1" stop-color="white" stop-opacity=".05" />
        </linearGradient>
        <mask
          :id="uid('reflection-mask')"
          maskUnits="userSpaceOnUse"
          x="0"
          y="9"
          width="760"
          height="271"
        >
          <rect
            x="0"
            y="9"
            width="760"
            height="271"
            :fill="paint('reflection-strength')"
          />
        </mask>
        <linearGradient :id="uid('port-reflect')" x2="0" y2="1">
          <stop stop-color="#b4b7b2" stop-opacity=".35" />
          <stop offset=".6" stop-color="#a3a5a1" stop-opacity=".1" />
          <stop offset="1" stop-color="#1a392c" stop-opacity="0" />
        </linearGradient>
        <linearGradient
          :id="uid('direction-arrow')"
          x1="0"
          x2="0"
          y1="0"
          y2="1"
        >
          <stop stop-color="#668d80" />
          <stop offset=".42" stop-color="#e2f5ee" />
          <stop offset=".6" stop-color="#b7d9c9" />
          <stop offset="1" stop-color="#718f83" />
        </linearGradient>
        <pattern
          :id="uid('metal-brush')"
          patternUnits="userSpaceOnUse"
          width=".9"
          height="8"
        >
          <path d="M.2 0V8" stroke="#eff9ed" stroke-width=".15" opacity=".18" />
          <path d="M.65 0V8" stroke="#142a20" stroke-width=".2" opacity=".14" />
        </pattern>
        <linearGradient :id="uid('metal')" x1="0" y1="0" x2="1" y2=".3">
          <stop stop-color="#c0c6b7" />
          <stop offset=".13" stop-color="#7a8677" />
          <stop offset=".62" stop-color="#8b9485" />
          <stop offset=".93" stop-color="#697767" />
          <stop offset="1" stop-color="#c0c9b8" />
        </linearGradient>

        <template v-for="row in rows" :key="row.key">
          <linearGradient
            v-for="layer in [0, 1, 2]"
            :id="uid(`${row.key}-${layer}`)"
            :key="layer"
            gradientUnits="userSpaceOnUse"
            x1="104"
            x2="676"
            y1="0"
            y2="0"
          >
            <stop
              v-for="point in row.stops"
              :key="point.x"
              :offset="(point.x - 104) / 572"
              :stop-color="point.colors[layer]"
            />
          </linearGradient>
        </template>
      </defs>
      <g style="mix-blend-mode: screen">
        <ellipse
          v-for="(light, i) in floorLights"
          :key="i"
          :cx="light[0]"
          :cy="light[1]"
          rx="180"
          ry="46"
          :fill="paint(`floor-${i}`)"
          style="mix-blend-mode: screen"
        />
      </g>
      <path
        d="M91 154h13l8 66H86zM671 157h15l8 64h-30z"
        :fill="paint('port-reflect')"
        :filter="paint('blur')"
      />
      <g
        v-if="geometry.front.length"
        opacity=".24"
        :filter="paint('blur')"
        :mask="paint('reflection-mask')"
      >
        <g transform="matrix(1,0,0,-.24,0,263)">
          <path
            v-for="row in geometry.front"
            :key="row.index"
            :d="row.body"
            :fill="paint(`front-${row.index}-1`)"
          />
        </g>
      </g>
      <template v-if="geometry.shadow">
        <ellipse
          cx="350"
          cy="207"
          rx="83"
          ry="7"
          fill="#000b08"
          opacity=".65"
          :filter="paint('blur')"
        />
        <g opacity=".15" :filter="paint('blur')">
          <path
            :d="geometry.shadow"
            transform="matrix(.95,0,-.15,.2,35,195)"
            fill="#000804"
          />
        </g>
      </template>
      <g
        class="cache-hit-flow"
        :style="{
          filter: focused === 'hit' ? 'brightness(1.12)' : undefined,
          opacity: focused === 'miss' ? 0.75 : 1,
        }"
        :filter="paint('grain')"
      >
        <g v-for="row in [...geometry.rear].reverse()" :key="row.index">
          <path :d="row.body" :fill="paint(`rear-${row.index}-1`)" />
          <path
            :d="row.softHighlight"
            :fill="paint(`rear-${row.index}-2`)"
            opacity=".15"
          />
          <path
            :d="row.highlight"
            :fill="paint(`rear-${row.index}-2`)"
            opacity=".65"
          />
          <path
            :d="row.shade"
            :fill="paint(`rear-${row.index}-0`)"
            opacity=".9"
          />
        </g>
        <path
          v-if="geometry.shadow"
          :d="geometry.shadow"
          fill="#000d09"
          opacity=".8"
          :filter="paint('occlusion')"
        />
        <g v-for="row in [...geometry.front].reverse()" :key="row.index">
          <path :d="row.body" :fill="paint(`front-${row.index}-1`)" />
          <g :filter="paint('profile-soften')">
            <path
              :d="row.softHighlight"
              :fill="paint(`front-${row.index}-2`)"
              opacity=".3"
            />
            <path :d="row.highlight" :fill="paint(`front-${row.index}-2`)" />
            <path
              :d="row.shade"
              :fill="paint(`front-${row.index}-0`)"
              opacity=".9"
            />
          </g>
        </g>
      </g>
      <g
        v-if="materialImage"
        :style="{
          filter: focused === 'hit' ? 'brightness(1.12)' : undefined,
          opacity: focused === 'miss' ? 0.75 : 1,
        }"
      >
        <image
          :href="materialImage"
          :filter="paint('material-optics')"
          preserveAspectRatio="none"
          x="0"
          y="9"
          width="760"
          height="271"
        />
      </g>
      <g
        class="cache-miss-flow"
        :style="{
          filter: focused === 'miss' ? 'brightness(1.12)' : undefined,
          opacity: focused === 'hit' ? 0.75 : 1,
        }"
      >
        <path
          v-for="row in geometry.miss"
          :key="`shadow-${row.index}`"
          :d="row.center"
          transform="translate(0 5)"
          stroke="#000b12"
          stroke-width="9"
          fill="none"
          :filter="paint('blur')"
        />
        <g v-for="row in [...geometry.miss].reverse()" :key="row.index">
          <path
            :d="row.center"
            fill="none"
            stroke="#0f49a2"
            :stroke-width="row.strokeWidth * 1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            :d="row.center"
            fill="none"
            :stroke="paint(`miss-${row.index}-1`)"
            :stroke-width="row.strokeWidth"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            :d="row.center"
            transform="translate(0,-.7)"
            fill="none"
            :stroke="paint(`miss-${row.index}-2`)"
            :stroke-width="Math.min(1.25, row.strokeWidth * 0.3)"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </g>
      </g>

      <g :filter="paint('metal-grain')">
        <path
          d="M88 114L92 118V155L88 151Z"
          fill="#758272"
          stroke="#c9d8c5"
          stroke-width=".7"
        />
        <path d="M88 114H100L104 118H92Z" fill="#d2d7c9" />
        <path
          d="M92 118H104V155H92Z"
          :fill="paint('metal')"
          stroke="#c9d8c5"
          stroke-width=".8"
        />
        <path
          d="M665 115L671 120V160L665 155Z"
          fill="#758272"
          stroke="#c9d8c5"
          stroke-width=".7"
        />
        <path d="M665 115H680L686 120H671Z" fill="#d2d7c9" />
        <path
          d="M671 120H686V160H671Z"
          :fill="paint('metal')"
          stroke="#c9d8c5"
          stroke-width=".8"
        />
      </g>
      <path
        d="M92 118H104V155H92ZM671 120H686V160H671Z"
        :fill="paint('metal-brush')"
      />
      <path
        d="M0 135H68v-5l14 7-14 7v-5H0zM687 138h60v-5l13 7-13 7v-5h-60z"
        :fill="paint('direction-arrow')"
      />
    </svg>
    <svg
      class="cache-markers"
      viewBox="0 9 760 271"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <g
        v-for="(mark, i) in markers"
        :key="i"
        :transform="`translate(${mark.x},${mark.y}) rotate(${mark.angle}) scale(${mark.group === 'hit' ? 1.3 : 1})`"
        :opacity="mark.opacity"
        :data-flow="mark.group"
      >
        <g
          v-for="n in mark.double ? 2 : 1"
          :key="n"
          :transform="`translate(${-(n - 1) * 6},0)`"
        >
          <path
            d="M-5-4L0 0L-5 4"
            fill="none"
            stroke="#8beeda"
            stroke-width="2.2"
          />
          <path d="M-5-4L0 0" fill="none" stroke="#ddfff6" stroke-width=".7" />
        </g>
      </g>
    </svg>
  </div>
</template>
<style scoped>
.cache-illustration,
.cache-ribbon,
.cache-raster,
.cache-markers {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.cache-raster {
  display: none;
}
.cache-raster.ready {
  display: block;
}
.cache-ribbon.rasterized {
  visibility: hidden;
}
</style>
