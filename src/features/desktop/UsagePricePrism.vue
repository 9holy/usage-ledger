<script lang="ts">
let nextPrismId = 0
</script>
<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CoveragePart } from './usageEfficiencyScene'
import emeraldTexture from '@/assets/usage/emerald-brushed.png'
import emeraldTopTexture from '@/assets/usage/emerald-top.png'
import emeraldCoreTexture from '@/assets/usage/emerald-core.png'
import champagneTopTexture from '@/assets/usage/champagne-top.png'
import champagneSideTexture from '@/assets/usage/champagne-side.png'
import { usagePercentLabel } from './usageChartPalette'

const { t } = useI18n()
const props = defineProps<{ parts: CoveragePart[]; total?: number; compact?: boolean }>()
const host = ref<HTMLElement>()
const width = ref(760)
const uid = `price-prism-${++nextPrismId}`
const id = (name: string) => `${uid}-${name}`
const url = (name: string) => `url(#${id(name)})`
const focused = ref<string | null>(null)
const labels = computed(() => ({ known: t('usageMonitor.text.estimable2'), unknown: t('usageMonitor.text.modeNotRecorded3'), missing: t('usageMonitor.text.priceMissing') }))
const colors = { known: '#e9fff4', unknown: '#f1cd84', missing: '#f1a290' }
const number = (value: number) => value.toLocaleString(usageLocale())
// Art-directed perspective, shared by surfaces, cuts, frames and reflections.
// The silhouette is schematic; the accompanying counts and percentages are exact.
function point(u: number, v: number, z = 0): [number, number] {
  return [
    21 + 719 * u + (55 - 5 * u + 20 * u * (1 - u)) * z,
    87 + 54 * u + (111 + 46 * u) * v - (32 + 13 * u + 4 * v + 11 * u * v + 8 * u * (1 - u)) * z
  ]
}
const xy = (p: number[]) => p.join(',')
const quad = (
  a: number,
  b: number,
  face: 'front' | 'top' | 'side',
  reflected = false,
  reflectionDepth = 0.25
) => {
  const p = (u: number, v: number, z: number) => point(u, reflected ? 1 + (1 - v) * reflectionDepth : v, z)
  return (
    face === 'front'
      ? [p(a, 0, 0), p(b, 0, 0), p(b, 1, 0), p(a, 1, 0)]
      : face === 'top'
        ? [p(a, 0, 0), p(a, 0, 1), p(b, 0, 1), p(b, 0, 0)]
        : [p(b, 0, 0), p(b, 0, 1), p(b, 1, 1), p(b, 1, 0)]
  )
    .map(xy)
    .join(' ')
}
const positive = computed(() => props.parts.filter((part) => part.count > 0))
const parts = computed(() => {
  const totalWeight = positive.value.reduce((sum, part) => sum + part.percent ** 0.63, 0)
  let start = 0
  return positive.value.map((part, index) => {
    const end = start + part.percent ** 0.63 / totalWeight
    const cap = part.state === 'known' ? Math.min(0.064, (end - start) * 0.18) : 0
    const bodyEnd = end - cap
    const rimWidth = Math.min(0.011, cap * 0.18)
    const labelU = positive.value.length === 1 ? 0.5 : start + (end - start) * (index === 0 ? 0.27 : 0.7)
    const leftLabel = positive.value.length === 2 && index === 0 && part.state === 'known'
    const labelX = leftLabel
      ? 66
      : positive.value.length === 3
        ? 140 + index * 270
        : Math.max(98, Math.min(700, point(labelU, 1)[0]))
    const labelY = positive.value.length === 3 ? 300 : 286 + labelU * 52
    const anchor = point(
      start + (bodyEnd - start) * (part.state === 'known' ? 0.38 : 0.65),
      part.state === 'known' ? 0.7 : 0.58
    )
    const target: [number, number] = [leftLabel ? labelX + 80 : labelX - 14, labelY - 22]
    const result = {
      ...part,
      start,
      end,
      bodyEnd,
      rimWidth,
      frameInset: Math.min(0.009, (end - start) * 0.04),
      cap,
      labelX,
      labelY,
      leftLabel,
      anchor,
      target
    }
    start = end
    return result
  })
})
function captionLines(part: (typeof parts.value)[number]) {
  const text = t('usageMonitor.text.requests10', { value0: labels.value[part.state], value1: number(part.count) })
  const advance = [...text].reduce(
    (sum, char) => sum + (char === ' ' || char === ',' ? 0.28 : char.charCodeAt(0) < 128 ? 0.56 : 1),
    0
  )
  const available =
    positive.value.length === 3
      ? 270
      : part.leftLabel
        ? 350
        : Math.min(part.labelX, 820 - part.labelX) * 2 - 6
  return advance * (positive.value.length === 3 ? 28 : part.state === 'known' ? 30 : 28) > available
    ? [labels.value[part.state], t('usageMonitor.text.requests11', { value0: number(part.count) })]
    : [text]
}
const viewHeight = computed(() =>
  Math.max(355, ...parts.value.map((part) => part.labelY + 76 + (captionLines(part).length - 1) * 32 + 10))
)
// Keep optical detail in CSS pixels; do not shrink every material feature with the viewBox.
const opticalScale = computed(() => Math.max(1, 820 / width.value))
const pitch = computed(() => Math.max(13, 6 * opticalScale.value))
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(() => {
    width.value = host.value?.clientWidth || 760
  })
  if (host.value) observer.observe(host.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    ref="host"
    class="reference-prism"
    role="img"
    :aria-label="
      parts.map((p) => t('usageMonitor.text.requests12', { value0: labels[p.state], value1: number(p.count), value2: usagePercentLabel(p.percent) })).join(t('usageMonitor.text.label10'))
    "
  >
    <svg :viewBox="`0 ${compact ? 48 : 0} 820 ${viewHeight - (compact ? 48 : 0)}`" aria-hidden="true">
      <defs>
        <filter :id="id('frontContrast')" color-interpolation-filters="sRGB">
          <feComponentTransfer>
            <feFuncR type="linear" slope="2.2" intercept="-.10" />
            <feFuncG type="linear" slope="2.4" intercept="-.69" />
            <feFuncB type="linear" slope="2.3" intercept="-.42" />
          </feComponentTransfer>
        </filter>
        <filter :id="id('topContrast')" color-interpolation-filters="sRGB">
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.5" intercept="-.224" />
            <feFuncG type="linear" slope="2.2" intercept="-1" />
            <feFuncB type="linear" slope="2.2" intercept="-.81" />
          </feComponentTransfer>
        </filter>
        <linearGradient :id="id('textureFadeX')">
          <stop stop-color="black" />
          <stop offset=".5" stop-color="white" />
          <stop offset="1" stop-color="black" />
        </linearGradient>
        <linearGradient :id="id('textureFadeY')" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="black" />
          <stop offset=".5" stop-color="white" />
          <stop offset="1" stop-color="black" />
        </linearGradient>
        <mask :id="id('textureMaskX')" maskContentUnits="objectBoundingBox">
          <rect width="1" height="1" :fill="url('textureFadeX')" />
        </mask>
        <mask :id="id('textureMaskY')" maskContentUnits="objectBoundingBox">
          <rect width="1" height="1" :fill="url('textureFadeY')" />
        </mask>
        <pattern
          :id="id('referenceBrush')"
          :patternTransform="`scale(${opticalScale})`"
          width="125"
          height="45"
          patternUnits="userSpaceOnUse"
        >
          <rect width="125" height="45" fill="#087a50" />
          <g v-for="x in [-125, 0]" :key="x">
            <g v-for="y in [-45, 0]" :key="y" :transform="`translate(${x} ${y})`" :mask="url('textureMaskX')">
              <image
                :href="emeraldTexture"
                width="250"
                height="90"
                preserveAspectRatio="none"
                :mask="url('textureMaskY')"
              />
            </g>
          </g>
        </pattern>
        <pattern
          :id="id('referenceTop')"
          :patternTransform="`scale(${opticalScale})`"
          width="125"
          height="10"
          patternUnits="userSpaceOnUse"
        >
          <rect width="125" height="10" fill="#3bc494" />
          <g v-for="x in [-125, 0]" :key="x">
            <g v-for="y in [-10, 0]" :key="y" :transform="`translate(${x} ${y})`" :mask="url('textureMaskX')">
              <image
                :href="emeraldTopTexture"
                width="250"
                height="20"
                preserveAspectRatio="none"
                :mask="url('textureMaskY')"
              />
            </g>
          </g>
        </pattern>
        <pattern
          :id="id('referenceCore')"
          :patternTransform="`scale(${opticalScale ** 0.6})`"
          width="24"
          height="115"
          x="543"
          y="126"
          patternUnits="userSpaceOnUse"
        >
          <rect width="24" height="115" fill="#021b10" />
          <image :href="emeraldCoreTexture" width="24" height="115" preserveAspectRatio="none" />
        </pattern>
        <radialGradient :id="id('frontSheen')" cx=".22" cy=".1" r=".9">
          <stop stop-color="#91f4b9" stop-opacity=".23" />
          <stop offset=".4" stop-color="#c7f9c2" stop-opacity=".05" />
          <stop offset="1" stop-color="#001e12" stop-opacity=".22" />
        </radialGradient>
        <filter :id="id('wireSoftness')" x="-2%" y="-2%" width="104%" height="104%">
          <feTurbulence type="fractalNoise" baseFrequency=".06 .14" numOctaves="2" seed="7" result="rough" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="rough"
            :scale="0.65 * opticalScale"
            xChannelSelector="R"
            yChannelSelector="G"
          />
          <feGaussianBlur :stdDeviation="0.16 * opticalScale" result="wire" />
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".012 .02"
            numOctaves="2"
            seed="11"
            result="wireLightNoise"
          />
          <feColorMatrix
            in="wireLightNoise"
            type="matrix"
            values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  .4 .4 .4 0 .2"
            result="wireLight"
          />
          <feComposite in="wire" in2="wireLight" operator="in" />
        </filter>

        <filter :id="id('brushedNoise')" x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".48 .009"
            numOctaves="3"
            seed="19"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.4" intercept="-.2" />
            <feFuncG type="linear" slope="1.4" intercept="-.2" />
            <feFuncB type="linear" slope="1.4" intercept="-.2" />
          </feComponentTransfer>
        </filter>
        <filter :id="id('goldGlow')" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow
            dx="0"
            dy="0"
            :stdDeviation="1.1 * opticalScale"
            flood-color="#ffd889"
            flood-opacity=".32"
          />
        </filter>

        <linearGradient :id="id('wireFace')" x1="0" y1="0" x2=".3" y2="1">
          <stop stop-color="#b49c71" stop-opacity=".13" />
          <stop offset=".42" stop-color="#0c100e" stop-opacity=".35" />
          <stop offset="1" stop-color="#080c0b" stop-opacity=".35" />
        </linearGradient>

        <filter :id="id('reflectionBlur')">
          <feGaussianBlur :stdDeviation="1.8 * opticalScale" />
        </filter>

        <linearGradient :id="id('top')" x1="0" y1="1" x2=".7" y2="0">
          <stop stop-color="#21bf91" />
          <stop offset=".4" stop-color="#51dba7" />
          <stop offset="1" stop-color="#1aa875" />
        </linearGradient>
        <radialGradient :id="id('topSheen')" cx=".25" cy=".35" r=".65">
          <stop stop-color="#e2ffe5" stop-opacity=".4" />
          <stop offset="1" stop-color="#d2ffe8" stop-opacity="0" />
        </radialGradient>
        <linearGradient :id="id('side')">
          <stop stop-color="#001c14" />
          <stop offset=".55" stop-color="#064634" />
          <stop offset="1" stop-color="#020b07" />
        </linearGradient>
        <linearGradient :id="id('rim')">
          <stop stop-color="#536559" />
          <stop offset=".12" stop-color="#d3d6ba" />
          <stop offset=".4" stop-color="#dddac1" />
          <stop offset=".7" stop-color="#9eaa94" />
          <stop offset="1" stop-color="#263f30" />
        </linearGradient>
        <linearGradient :id="id('gold')" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#fff0be" />
          <stop offset=".4" stop-color="#c8a76b" />
          <stop offset=".75" stop-color="#f5d999" />
          <stop offset="1" stop-color="#b28e50" />
        </linearGradient>
        <linearGradient :id="id('reflection')" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#167657" stop-opacity=".7" />
          <stop offset="1" stop-color="#06100b" stop-opacity="0" />
        </linearGradient>
        <linearGradient :id="id('fade')" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="white" />
          <stop offset="1" stop-color="black" />
        </linearGradient>
        <radialGradient :id="id('floor')">
          <stop stop-color="#1b5c3d" stop-opacity=".45" />
          <stop offset="1" stop-color="#07110c" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="id('shadow')">
          <stop stop-color="#000" stop-opacity=".6" />
          <stop offset="1" stop-color="#000" stop-opacity="0" />
        </radialGradient>

        <pattern
          :id="id('topBrush')"
          width="512"
          height="512"
          patternUnits="userSpaceOnUse"
          patternTransform="matrix(1 .05 -.7 .35 0 0)"
        >
          <rect width="512" height="512" :filter="url('brushedNoise')" />
        </pattern>

        <filter :id="id('missingMaterial')" color-interpolation-filters="sRGB">
          <feColorMatrix type="hueRotate" values="-30" />
        </filter>
        <pattern
          v-for="state in ['unknown', 'missing'] as const"
          :key="`${state}-hatch`"
          :id="id(`${state}-hatch`)"
          :width="pitch"
          :height="pitch"
          patternUnits="userSpaceOnUse"
        >
          <path
            :id="id(`${state}-fiber-path`)"
            :d="`M ${-pitch / 2} ${pitch / 2} L ${pitch / 2} ${-pitch / 2} M 0 ${pitch} L ${pitch} 0 M ${pitch / 2} ${pitch * 1.5} L ${pitch * 1.5} ${pitch / 2}`"
            fill="none"
          />
          <use
            :href="`#${id(`${state}-fiber-path`)}`"
            stroke="#111713"
            :stroke-width="2.4 * Math.sqrt(opticalScale)"
            :transform="`translate(${0.3 * Math.sqrt(opticalScale)} ${0.4 * Math.sqrt(opticalScale)})`"
            opacity=".75"
          />
          <use
            :href="`#${id(`${state}-fiber-path`)}`"
            :stroke="state === 'unknown' ? '#bdb6a3' : '#e5a38f'"
            :stroke-width="1.2 * Math.sqrt(opticalScale)"
          />
          <use
            :href="`#${id(`${state}-fiber-path`)}`"
            :stroke="state === 'unknown' ? '#f2e3c0' : '#ffe2d1'"
            :stroke-width="0.35 * Math.sqrt(opticalScale)"
            :transform="`translate(${-0.2 * Math.sqrt(opticalScale)} ${-0.2 * Math.sqrt(opticalScale)})`"
            opacity=".65"
          />
        </pattern>
        <pattern
          :id="id('champagneTop')"
          width="80"
          height="20"
          x="650"
          y="103"
          patternUnits="userSpaceOnUse"
          :patternTransform="`scale(${pitch / 13})`"
        >
          <image :href="champagneTopTexture" width="80" height="20" />
        </pattern>
        <mask :id="id('reflectionMask')" maskUnits="userSpaceOnUse" x="0" y="170" width="820" height="230">
          <rect x="0" y="190" width="820" height="210" :fill="url('fade')" />
        </mask>
      </defs>
      <ellipse cx="400" cy="285" rx="410" ry="125" :fill="url('floor')" />
      <g :mask="url('reflectionMask')" :filter="url('reflectionBlur')" opacity=".75">
        <g v-for="part in parts" :key="part.state" opacity=".65">
          <polygon
            v-if="part.state === 'known'"
            :points="quad(part.start, part.bodyEnd, 'front', true, 0.65)"
            :fill="url('reflection')"
          />
          <template v-else>
            <polygon
              :points="quad(part.start, part.end, 'front', true)"
              fill="none"
              :stroke="colors[part.state]"
              stroke-width=".8"
            />
            <polygon
              :points="quad(part.start, part.end, 'side', true)"
              fill="none"
              :stroke="colors[part.state]"
              stroke-width=".8"
            />
          </template>
        </g>
      </g>
      <g
        v-for="part in parts.filter((p) => p.state === 'known')"
        :key="`${part.state}-contact`"
        :filter="url('reflectionBlur')"
      >
        <path
          :d="`M ${xy(point(part.start, 1.025))} L ${xy(point(part.bodyEnd, 1.025))}`"
          stroke="#000b05"
          stroke-width="11"
          opacity=".9"
        />
      </g>
      <ellipse cx="393" cy="260" rx="382" ry="26" :fill="url('shadow')" transform="rotate(8.3 393 260)" />
      <path
        v-for="part in parts.filter((p) => p.state === 'known')"
        :key="part.state"
        :d="`M ${xy(point(part.start, 1.2 + 0.035 * part.start))} L ${xy(point(part.bodyEnd, 1.2 + 0.035 * part.bodyEnd))}`"
        fill="none"
        stroke="#72a28b"
        stroke-width="1"
        opacity=".45"
      />
      <g
        v-for="part in parts.filter((p) => p.state === 'known')"
        :key="`${part.state}-floor-guides`"
        stroke="#7ab89c"
        :stroke-width="0.9 * opticalScale"
        :stroke-dasharray="`${5 * opticalScale} ${6 * opticalScale}`"
        opacity=".38"
      >
        <path :d="`M ${xy(point(part.start, 1))} L ${xy(point(part.start, 1.3))}`" />
        <path
          :d="`M ${xy(point(part.bodyEnd + part.rimWidth, 1))} L ${xy(point(part.bodyEnd + part.rimWidth, 1.38))}`"
        />
      </g>
      <g v-if="!compact" class="prism-ruler" fill="none" stroke="#d9e5dc" :stroke-width="1.6 * opticalScale">
        <path d="M 76 34 L 769 62" :stroke-dasharray="`${8 * opticalScale} ${6 * opticalScale}`" />
        <path d="M 76 19 V 57 M 769 42 V 88" :stroke-dasharray="`${5 * opticalScale} ${4 * opticalScale}`" />
        <circle cx="76" cy="34" :r="2.5 * Math.sqrt(opticalScale)" fill="#f5fff7" />
        <circle cx="769" cy="62" :r="2.5 * Math.sqrt(opticalScale)" fill="#f5fff7" />
      </g>
      <text v-if="!compact" class="prism-total" x="404" y="29" text-anchor="middle">
        {{ t('usageMonitor.text.all') }} {{ total == null ? t('usageMonitor.text.unavailable') : number(total) }} {{ t('usageMonitor.text.requests4') }}
      </text>
      <g
        v-for="part in parts"
        :key="part.state"
        :opacity="focused && focused !== part.state ? 0.34 : 1"
        class="prism-part"
      >
        <template v-if="part.state === 'known'">
          <polygon
            :points="quad(part.start, part.end, 'side')"
            :fill="url('side')"
            stroke="#175f43"
            stroke-width="1"
          />

          <g
            v-if="part.end < 0.99999"
            class="prism-connection-guides"
            fill="none"
            stroke="#b5c6b7"
            :stroke-width="1.3 * Math.sqrt(opticalScale)"
            :stroke-dasharray="`${7 * Math.sqrt(opticalScale)} ${5 * Math.sqrt(opticalScale)}`"
            opacity=".48"
          >
            <path :d="`M ${xy(point(part.bodyEnd + part.rimWidth, 0, 1))} L ${xy(point(part.end, 0, 1))}`" />
            <path
              :d="`M ${xy(point(part.bodyEnd + 0.015, 0.06, 0.96))} L ${xy(point(part.end, 0.06, 0.96))}`"
              opacity=".7"
            />
          </g>
          <polygon
            :points="
              [
                point(part.bodyEnd + part.cap * 0.3, 0.045, 0.06),
                point(part.bodyEnd + part.cap * 0.3, 0.045, 0.86),
                point(part.bodyEnd + part.cap * 0.3, 0.98, 0.86),
                point(part.bodyEnd + part.cap * 0.3, 0.98, 0.06)
              ]
                .map(xy)
                .join(' ')
            "
            class="prism-core"
            :fill="url('referenceCore')"
            stroke="#35c895"
            :stroke-width="1.2 * Math.sqrt(opticalScale)"
          />
          <path
            v-for="trace in 4"
            :key="`core-trace-${trace}`"
            :d="`M ${[
              [0.06 + trace * 0.03, 0.12],
              [0.06 + trace * 0.03, 0.32],
              [0.035 + trace * 0.03, 0.32],
              [0.035 + trace * 0.03, 0.5],
              [0.06 + trace * 0.03, 0.5],
              [0.06 + trace * 0.03, 0.76],
              [0.035 + trace * 0.03, 0.76],
              [0.035 + trace * 0.03, 0.85]
            ]
              .map(([v, z]) => xy(point(part.bodyEnd + part.cap * 0.3, v, z)))
              .join(' L ')}`"
            fill="none"
            stroke="#39d99c"
            :stroke-width="0.7 * Math.sqrt(opticalScale)"
            opacity=".5"
          />
          <path
            v-for="row in 9"
            :key="`slot-${row}`"
            class="prism-cut-slot"
            opacity=".2"
            :d="`M ${xy(point(part.bodyEnd + part.cap * 0.31, row / 11, 0.08))} L ${xy(point(part.bodyEnd + part.cap * 0.31, row / 11, 0.84))}`"
            stroke="#0c5735"
            :stroke-width="0.7 * opticalScale"
          />

          <g v-for="slice in [3, 2, 1]" :key="slice" class="prism-laminate">
            <polygon
              :points="
                quad(
                  part.bodyEnd + part.rimWidth + (slice - 1) * 0.05 * part.cap,
                  part.bodyEnd + part.rimWidth + slice * 0.05 * part.cap,
                  'side'
                )
              "
              :fill="slice % 2 ? '#041a11' : '#0a3f2c'"
              fill-opacity=".04"
              :stroke="slice % 2 ? '#4ba07a' : '#175136'"
              stroke-width=".7"
            />
          </g>

          <polygon
            :points="quad(part.start, part.bodyEnd, 'front')"
            :fill="url('referenceBrush')"
            :filter="url('frontContrast')"
          />
          <polygon :points="quad(part.start, part.bodyEnd, 'front')" :fill="url('frontSheen')" opacity=".4" />
          <g :filter="url('topContrast')">
            <polygon :points="quad(part.start, part.bodyEnd, 'top')" :fill="url('top')" />
            <polygon
              :points="quad(part.start, part.bodyEnd, 'top')"
              :fill="url('referenceTop')"
              opacity=".95"
            />
            <polygon
              :points="quad(part.start, part.bodyEnd, 'top')"
              :fill="url('topBrush')"
              opacity=".45"
              style="mix-blend-mode: soft-light"
            />
            <polygon :points="quad(part.start, part.bodyEnd, 'top')" :fill="url('topSheen')" opacity=".55" />
          </g>
          <polygon
            class="prism-silver-rim"
            :points="quad(part.bodyEnd, Math.min(part.end, part.bodyEnd + part.rimWidth), 'front')"
            :fill="url('rim')"
          />
          <polygon
            :points="quad(part.bodyEnd, Math.min(part.end, part.bodyEnd + part.rimWidth), 'top')"
            :fill="url('rim')"
          />
          <polyline
            :points="[point(part.start, 1, 0), point(part.bodyEnd, 1, 0)].map(xy).join(' ')"
            fill="none"
            stroke="#548b70"
            stroke-width="1.2"
          />
          <polyline
            :points="
              [point(part.start, 1, 0), point(part.start, 0, 0), point(part.bodyEnd, 0, 0)].map(xy).join(' ')
            "
            fill="none"
            stroke="#c9f5db"
            stroke-width="1.7"
          />
          <polyline
            :points="
              [
                point(part.start, 0, 0),
                point(part.start, 0, 1),
                point(part.bodyEnd, 0, 1),
                point(part.bodyEnd, 0, 0)
              ]
                .map(xy)
                .join(' ')
            "
            fill="none"
            stroke="#c4ffe5"
            stroke-width="1.4"
          />
        </template>
        <template v-else>
          <polygon
            :points="
              [point(part.start, 0, 1), point(part.end, 0, 1), point(part.end, 1, 1), point(part.start, 1, 1)]
                .map(xy)
                .join(' ')
            "
            fill="#07100d"
            fill-opacity=".2"
            :stroke="colors[part.state]"
            stroke-width="1.1"
            opacity=".22"
          />
          <polygon :points="quad(part.start, part.end, 'side')" fill="#1b242b" fill-opacity=".4" />
          <clipPath :id="id(`${part.state}-side-clip`)">
            <polygon :points="quad(part.start, part.end, 'side')" />
          </clipPath>
          <image
            class="prism-side-material"
            :href="champagneSideTexture"
            :x="point(part.end, 0, 0)[0]"
            :y="point(part.end, 0, 1)[1]"
            :width="point(part.end, 0, 1)[0] - point(part.end, 0, 0)[0]"
            :height="point(part.end, 1, 0)[1] - point(part.end, 0, 1)[1]"
            preserveAspectRatio="none"
            :clip-path="url(`${part.state}-side-clip`)"
            :filter="part.state === 'missing' ? url('missingMaterial') : undefined"
          />
          <polygon
            :points="quad(part.start, part.end, 'top')"
            :fill="url('champagneTop')"
            :filter="part.state === 'missing' ? url('missingMaterial') : undefined"
          />
          <polygon
            class="prism-top-bevel"
            :points="quad(part.start, part.start + part.frameInset, 'top')"
            :fill="part.state === 'unknown' ? url('gold') : colors[part.state]"
            opacity=".4"
          />
          <path
            :d="`M ${xy(point(part.start + part.frameInset, 0, 0))} L ${xy(point(part.start + part.frameInset, 0, 1))}`"
            fill="none"
            :stroke="colors[part.state]"
            :stroke-width="0.8 * Math.sqrt(opticalScale)"
            opacity=".7"
          />

          <polygon :points="quad(part.start, part.end, 'front')" fill="#1e201d" fill-opacity=".65" />
          <polygon :points="quad(part.start, part.end, 'front')" :fill="url('wireFace')" />
          <polygon
            :points="quad(part.start, part.end, 'front')"
            :fill="url(`${part.state}-hatch`)"
            :filter="url('wireSoftness')"
            opacity=".85"
          />
          <polygon
            :points="quad(part.start, part.start + part.frameInset, 'front')"
            :fill="part.state === 'unknown' ? url('gold') : colors[part.state]"
            opacity=".25"
          />
          <path
            :d="`M ${xy(point(part.start + part.frameInset, 0))} L ${xy(point(part.start + part.frameInset, 1))}`"
            :stroke="colors[part.state]"
            :stroke-width="0.7 * opticalScale"
            opacity=".72"
          />
          <polygon
            :points="quad(part.start, part.end, 'front')"
            fill="none"
            :stroke="part.state === 'unknown' ? '#654c2c' : '#6b3c32'"
            :stroke-width="3 * Math.sqrt(opticalScale)"
            opacity=".65"
          />
          <g v-for="face in ['front', 'top', 'side'] as const" :key="face">
            <polygon
              :points="quad(part.start, part.end, face)"
              fill="none"
              :stroke="part.state === 'unknown' ? '#6c5836' : '#703c31'"
              :stroke-width="3 * Math.sqrt(opticalScale)"
              opacity=".65"
            />
            <polygon
              :points="quad(part.start, part.end, face)"
              fill="none"
              :stroke="part.state === 'unknown' ? url('gold') : colors[part.state]"
              :stroke-width="1.8 * Math.sqrt(opticalScale)"
              :filter="part.state === 'unknown' ? url('goldGlow') : undefined"
            />
            <polygon
              :points="quad(part.start, part.end, face)"
              fill="none"
              :stroke="part.state === 'unknown' ? '#fff0cb' : '#ffe3d7'"
              :stroke-width="0.55 * Math.sqrt(opticalScale)"
              :transform="`translate(${-0.25 * opticalScale} ${-0.3 * opticalScale})`"
              opacity=".8"
            />
          </g>
        </template>
        <path
          :d="`M ${xy(part.anchor)} L ${xy(part.target)}`"
          fill="none"
          :stroke="colors[part.state]"
          :stroke-width="Math.max(2, 1.5 * opticalScale)"
        />
        <circle
          :cx="part.anchor[0]"
          :cy="part.anchor[1]"
          :r="6 * Math.sqrt(opticalScale)"
          :fill="colors[part.state]"
        />
        <circle
          :cx="part.target[0]"
          :cy="part.target[1]"
          :r="3 * Math.sqrt(opticalScale)"
          :fill="colors[part.state]"
        />
        <g
          class="prism-label"
          :data-state="part.state"
          :data-count="part.count"
          :data-percent="part.percent"
          @mouseenter="focused = part.state"
          @mouseleave="focused = null"
        >
          <text
            :x="part.labelX"
            :y="part.labelY + 35"
            :text-anchor="part.leftLabel ? 'start' : 'middle'"
            class="prism-percent"
            :style="{
              fontSize: positive.length === 3 ? '48px' : part.state === 'known' ? '60px' : '50px',
              fontWeight: part.state === 'known' ? 650 : 600
            }"
          >
            {{ usagePercentLabel(part.percent) }}
          </text>
          <text
            :x="part.labelX"
            :y="part.labelY + (part.state === 'known' ? 76 : 70)"
            :text-anchor="part.leftLabel ? 'start' : 'middle'"
            class="prism-caption"
            :style="{
              fontSize: positive.length === 3 ? '28px' : part.state === 'known' ? '32px' : '28px'
            }"
            :fill="colors[part.state]"
          >
            <tspan v-for="(line, i) in captionLines(part)" :key="i" :x="part.labelX" :dy="i ? 32 : 0">
              {{ line }}
            </tspan>
          </text>
        </g>
      </g>
    </svg>
  </div>
</template>
<style scoped>
.reference-prism {
  width: 100%;
  position: relative;
  isolation: isolate;
}
svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
  font-family: inherit;
}
.prism-total {
  font-size: 32px;
  fill: #eef5ef;
  font-weight: 500;
}
.prism-percent {
  font-size: 56px;
  fill: #f0f6f1;
  font-weight: 650;
  letter-spacing: -0.5px;
  font-variant-numeric: tabular-nums;
}
.prism-caption {
  font-size: 28px;
  font-weight: 500;
}
.prism-part {
  transition: opacity 0.15s ease;
}
@media (prefers-reduced-motion: reduce) {
  .prism-part {
    transition: none;
  }
}
</style>
