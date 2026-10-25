<script lang="ts">
let nextRibbonId = 0
</script>
<script setup lang="ts">
import { computed } from 'vue'
import material from '@/assets/usage/scenes/mode-ribbon.webp'
import { modeRibbonRanges } from './modeRibbonGeometry'
const props = defineProps<{
  parts: { count: number; color: string }[]
  variant?: number
  total: number
  label: string
}>()
const uid = 'mode-ribbon-' + ++nextRibbonId
const ranges = computed(() =>
  modeRibbonRanges(
    props.parts.map((part) => part.count),
    props.total,
  ),
)
// Sequential cross-fades retain a fully covered base, avoiding dark alpha seams.
function transition(index: number) {
  const current = ranges.value[index]
  const previous = ranges.value
    .slice(0, index)
    .reverse()
    .find((r) => r.end > r.start)
  if (!previous) return null
  const half = Math.min(
    0.012,
    (previous.end - previous.start) * 0.2,
    (current.end - current.start) * 0.2,
  )
  return {
    start: 51 + (current.start - half) * 1946,
    end: 51 + (current.start + half) * 1946,
  }
}
// Only a neutral, unsegmented optical material is rasterized. Every category
// boundary and tint is calculated from current data; no counts are in the asset.
function tint(color: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  const channels = match
    ? [0, 2, 4].map((i) =>
        Math.pow(parseInt(match[1].slice(i, i + 2), 16) / 255, 1.26),
      )
    : [0.6, 0.65, 0.7]
  return (
    channels.map((c) => `${0.24 * c} ${0.72 * c} ${0.08 * c} 0 0`).join(' ') +
    ' 0 0 0 1 0'
  )
}
</script>
<template>
  <div class="mode-ribbon" role="img" :aria-label="label">
    <svg viewBox="0 255 2048 270" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath :id="uid + '-used'">
          <rect
            x="51"
            y="0"
            :width="1946 * (ranges[ranges.length - 1]?.end ?? 0)"
            height="768"
          />
        </clipPath>
        <template v-for="(part, i) in parts" :key="i">
          <linearGradient
            v-if="transition(i)"
            :id="uid + '-blend-' + i"
            gradientUnits="userSpaceOnUse"
            :x1="transition(i)!.start"
            :x2="transition(i)!.end"
            y1="0"
            y2="0"
          >
            <stop offset="0" stop-color="black" />
            <stop offset="1" stop-color="white" />
          </linearGradient>
          <mask
            :id="uid + '-mask-' + i"
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="2048"
            height="768"
            style="mask-type: luminance"
          >
            <rect
              width="2048"
              height="768"
              :fill="transition(i) ? `url(#${uid}-blend-${i})` : 'white'"
            />
          </mask>
          <filter :id="uid + '-tint-' + i" color-interpolation-filters="sRGB">
            <feColorMatrix type="matrix" :values="tint(part.color)" />
            <feComponentTransfer>
              <feFuncR type="linear" slope="1.14" intercept="0.018" />
              <feFuncG type="linear" slope="1.14" intercept="0.018" />
              <feFuncB type="linear" slope="1.14" intercept="0.018" />
            </feComponentTransfer>
          </filter>
        </template>
        <!-- One continuous specular layer keeps highlights joined across live colour cuts. -->
        <filter :id="uid + '-sheen'" color-interpolation-filters="sRGB">
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 .2126 .7152 .0722 0 0"
          />
          <feComponentTransfer>
            <feFuncA type="gamma" amplitude="0.24" exponent="4" offset="0" />
          </feComponentTransfer>
          <feComposite in2="SourceAlpha" operator="in" />
        </filter>
      </defs>
      <image
        v-for="(range, i) in ranges"
        v-show="range.end > range.start"
        :key="i"
        :href="material"
        width="2048"
        height="768"
        :clip-path="`url(#${uid}-used)`"
        :mask="`url(#${uid}-mask-${i})`"
        :filter="`url(#${uid}-tint-${i})`"
        :data-start="range.start"
        :data-end="range.end"
      />
      <image
        v-if="total > 0 && parts.some((part) => part.count > 0)"
        :href="material"
        width="2048"
        height="768"
        :filter="`url(#${uid}-sheen)`"
        class="ribbon-sheen"
        :clip-path="`url(#${uid}-used)`"
      />
    </svg>
  </div>
</template>
<style scoped>
.mode-ribbon {
  height: auto;
  max-height: 100px;
  aspect-ratio: 9.2;
  min-height: 0;
  width: 100%;
  position: relative;
  min-width: 0;
}
.mode-ribbon > svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
</style>
<style scoped>
@container (max-width:480px) {
  .mode-ribbon {
    height: 48px;
    aspect-ratio: auto;
  }
}
</style>
