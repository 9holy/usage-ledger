<script lang="ts">
let nextTokenId = 0
</script>
<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import scenery from '@/assets/usage/scenes/token-original-clean.webp'
import liquidMaterial from '@/assets/usage/scenes/token-liquid-material.webp'
import outputFlow from '@/assets/usage/scenes/token-output-flow.webp'
import surfaceCache from '@/assets/usage/scenes/token-surface-cache.webp'
import surfaceFresh from '@/assets/usage/scenes/token-surface-fresh.webp'
import surfaceOutput from '@/assets/usage/scenes/token-surface-output.webp'
import { usageColors, usagePercentLabel } from './usageChartPalette'

const { t } = useI18n()
const uid = 'token-reservoir-' + ++nextTokenId
const props = defineProps<{
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  partial?: boolean
}>()
const valid = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0
const total = computed(() =>
  valid(props.inputTokens) && valid(props.outputTokens)
    ? props.inputTokens + props.outputTokens
    : null,
)
const validCache = computed(
  () =>
    valid(props.inputTokens) &&
    valid(props.cacheReadTokens) &&
    props.cacheReadTokens <= props.inputTokens,
)
const fresh = computed(() =>
  validCache.value ? props.inputTokens! - props.cacheReadTokens! : null,
)
const cachedPercent = computed(() =>
  validCache.value && props.inputTokens! > 0
    ? (props.cacheReadTokens! / props.inputTokens!) * 100
    : null,
)
const count = (n: number | null | undefined) =>
  valid(n) ? n.toLocaleString(usageLocale()) : t('usageMonitor.text.notRecorded')
const compact = (n: number | null | undefined) =>
  valid(n)
    ? new Intl.NumberFormat(usageLocale(), {
        notation: 'compact',
        maximumFractionDigits: 2,
      }).format(n)
    : t('usageMonitor.text.notRecorded')
const segments = computed(() =>
  total.value && valid(props.inputTokens) && valid(props.outputTokens)
    ? [
        {
          label: validCache.value ? t('usageMonitor.text.otherInput') : t('usageMonitor.text.inputCachePortionNotRecorded'),
          tokens: validCache.value ? fresh.value! : props.inputTokens,
          color: usageColors.input,
        },
        ...(validCache.value
          ? [
              {
                label: props.partial ? t('usageMonitor.text.recordedCacheReads') : t('usageMonitor.text.cacheRead'),
                tokens: props.cacheReadTokens!,
                color: usageColors.cache,
              },
            ]
          : []),
        {
          label: t('usageMonitor.text.output'),
          tokens: props.outputTokens,
          color: usageColors.output,
        },
      ].map((row) => ({ ...row, percent: (row.tokens / total.value!) * 100 }))
    : [],
)
const vessels = computed(() => [
  {
    key: 'cache',
    surface: surfaceCache,
    fullLevel: 246,
    path: 'M267 249 C285 219 491 225 527 259 L517 363 Q407 415 283 365 Z',
    x: 270,
    w: 260,
    bottom: 391,
    capacity: 145,
    ratio: (cachedPercent.value ?? 0) / 100,
    color: '#50dfb6',
  },
  {
    key: 'fresh',
    surface: surfaceFresh,
    fullLevel: 266,
    path: 'M531 263 C568 242 650 247 646 274 L637 352 Q613 387 529 392 Z',
    x: 520,
    w: 140,
    bottom: 389,
    capacity: 123,
    ratio: cachedPercent.value == null ? 0 : 1 - cachedPercent.value / 100,
    color: '#79bdff',
  },
  {
    key: 'output',
    surface: surfaceOutput,
    fullLevel: 345,
    path: 'M716 344 Q819 319 911 346 L892 411 Q818 461 747 414 Z',
    x: 710,
    w: 220,
    bottom: 440,
    capacity: 95,
    ratio:
      total.value && valid(props.outputTokens)
        ? props.outputTokens / total.value
        : 0,
    color: '#f4c467',
  },
])
</script>
<template>
  <section
    class="token-composition"
    :class="{ 'has-token-data': segments.length }"
    :aria-label="t('usageMonitor.text.whereTokensAreUsed')"
  >
    <div class="token-stage">
      <header class="token-heading">
        <div>
          <h2>{{ t('usageMonitor.text.whereTokensAreUsed') }}</h2>
          <p>
            {{ t('usageMonitor.text.inputIncludesCacheReads') }}<br />{{ t('usageMonitor.text.outputCountedSeparately') }}<br />{{ t('usageMonitor.text.totalUsageInputOutput') }}<br />{{ t('usageMonitor.text.cacheIsNotCountedTwice') }}
          </p>
        </div>
        <div class="token-total">
          <span>{{ t('usageMonitor.text.totalUsage') }}</span
          ><strong :title="count(total)">{{ compact(total) }}</strong
          ><small>Token</small>
        </div>
      </header>
      <template v-if="segments.length">
        <div class="token-landscape">
          <img
            :src="scenery"
            :alt="t('usageMonitor.text.transparentInputContainerIncludesCacheAndOtherInputOutput')"
          />
          <img
            v-if="outputTokens && outputTokens > 0"
            :src="outputFlow"
            class="token-output-flow"
            alt=""
          />
          <svg
            viewBox="0 0 1000 500"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <template v-for="v in vessels" :key="v.key">
                <clipPath :id="uid + '-' + v.key">
                  <path :d="v.path" />
                </clipPath>
                <clipPath :id="uid + '-level-' + v.key">
                  <rect
                    :x="v.x"
                    :y="v.bottom - v.capacity * v.ratio"
                    :width="v.w"
                    :height="v.capacity * v.ratio"
                  />
                </clipPath>
                <linearGradient
                  :id="uid + '-fill-' + v.key"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop :stop-color="v.color" stop-opacity=".12" />
                  <stop offset=".45" :stop-color="v.color" stop-opacity=".05" />
                  <stop offset="1" :stop-color="v.color" stop-opacity=".1" />
                </linearGradient>
              </template>
            </defs>
            <g
              v-for="v in vessels"
              :key="v.key"
              :data-vessel="v.key"
              :data-level="v.ratio"
              :clip-path="`url(#${uid}-${v.key})`"
            >
              <template v-if="v.ratio > 0">
                <image
                  :href="liquidMaterial"
                  width="1000"
                  height="500"
                  :clip-path="`url(#${uid}-level-${v.key})`"
                />
                <rect
                  :x="v.x"
                  :y="v.bottom - v.capacity * v.ratio"
                  :width="v.w"
                  :height="v.capacity * v.ratio"
                  :fill="`url(#${uid}-fill-${v.key})`"
                />
                <ellipse
                  :cx="v.x + v.w / 2"
                  :cy="v.bottom - v.capacity * v.ratio"
                  :rx="v.w / 2"
                  ry="9"
                  :fill="v.color"
                  fill-opacity=".25"
                  :stroke="v.color"
                  stroke-width="1.5"
                />
                <image
                  :href="v.surface"
                  class="token-liquid-surface"
                  width="1000"
                  height="500"
                  :transform="`translate(0,${v.bottom - v.capacity * v.ratio - v.fullLevel})`"
                />
              </template>
            </g>
          </svg>
          <div class="input-label">
            <span>{{ t('usageMonitor.text.input') }}</span
            ><strong :title="count(inputTokens)">{{
              compact(inputTokens)
            }}</strong>
          </div>
          <div class="cache-insight">
            <span>{{ partial ? t('usageMonitor.text.ofRecordedInput') : t('usageMonitor.text.ofInput') }}</span
            ><strong>{{
              cachedPercent == null ? '—' : usagePercentLabel(cachedPercent)
            }}</strong
            ><span>{{ t('usageMonitor.text.fromCache') }}</span>
          </div>
        </div>
        <div class="token-readouts">
          <div class="token-readout cache" :title="count(cacheReadTokens)">
            <span>{{ partial ? t('usageMonitor.text.recordedCacheReads') : t('usageMonitor.text.cacheRead') }}</span
            ><strong>{{
              validCache ? compact(cacheReadTokens) : t('usageMonitor.text.notRecorded')
            }}</strong
            ><em>Token</em
            ><small>{{
              cachedPercent == null
                ? t('usageMonitor.text.cacheBreakdownUnavailable')
                : usagePercentLabel(cachedPercent) + t('usageMonitor.text.shareOfInput')
            }}</small>
          </div>
          <div class="token-readout fresh" :title="count(fresh)">
            <span>{{ t('usageMonitor.text.otherInput') }}</span><strong>{{ compact(fresh) }}</strong
            ><em>Token</em
            ><small>{{
              cachedPercent == null
                ? t('usageMonitor.text.cacheBreakdownUnavailable')
                : usagePercentLabel(100 - cachedPercent) + t('usageMonitor.text.shareOfInput')
            }}</small>
          </div>
          <div class="token-readout output" :title="count(outputTokens)">
            <span>{{ t('usageMonitor.text.output') }}</span><strong>{{ compact(outputTokens) }}</strong
            ><em>Token</em
            ><small
              >{{ usagePercentLabel((outputTokens! / total!) * 100) }} {{ t('usageMonitor.text.shareOfTotal') }}</small
            >
          </div>
        </div>
        <div class="token-parts" :aria-label="t('usageMonitor.text.exactTotalTokenComposition')">
          <div
            v-for="part in segments"
            :key="part.label"
            :data-tokens="part.tokens"
            :data-percent="part.percent"
            :style="{ width: part.percent + '%', '--tone': part.color }"
            :title="t('usageMonitor.text.tokens', { value0: part.label, value1: count(part.tokens), value2: usagePercentLabel(part.percent) })"
          />
        </div>
        <p class="token-equation">{{ t('usageMonitor.text.cacheIsAlreadyIncludedInInput') }}</p>
        <p class="token-scale-note">
          {{ t('usageMonitor.text.levelsShowProportionsOfInputTotalContainerShapesDo') }}{{
            partial ? t('usageMonitor.text.recordedDataOnly') : ''
          }}
        </p>
      </template>
      <p v-else class="token-empty">
        {{
          total === 0
            ? t('usageMonitor.text.noTokenUsageInTheSelectedPeriod')
            : t('usageMonitor.text.completeInputAndOutputRecordsNotYetAvailable')
        }}
      </p>
    </div>
  </section>
</template>
<style scoped>
.token-composition {
  container-type: inline-size;
  min-width: 0;
  border: 0;
  border-radius: 14px;
  overflow: hidden;
  background: transparent;
  color: #e4ebde;
  margin: 20px 0;
}
.token-heading {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 0 0;
  position: relative;
  z-index: 1;
}
.token-heading > div > span {
  font-size: 10px;
  color: #92b19e;
  letter-spacing: 0.12em;
}
.token-heading h2 {
  font:
    500 clamp(22px, 3.4cqw, 36px) / 1.3 Georgia,
    'Noto Serif CJK SC',
    serif;
  margin: 8px 0;
}
.token-heading p {
  font-size: 11px;
  color: #9fb2a3;
  line-height: 1.8;
}
.token-total {
  text-align: right;
}
.token-total > span {
  display: block;
}
.token-total strong {
  font:
    500 clamp(24px, 4.5cqw, 45px) / 1.4 Georgia,
    serif;
  display: block;
  white-space: nowrap;
  color: #f1e7ce;
}
.token-total small {
  font-size: 10px;
  color: #b1beaf;
}
.token-landscape {
  position: relative;
  aspect-ratio: 2/1;
  margin-top: -20px;
}
.token-landscape > img,
.token-landscape > svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.input-label {
  color: #e8f0de;
  position: absolute;
  top: 24%;
  left: 33%;
  z-index: 1;
  text-shadow: 0 2px 10px #000;
}
.input-label span {
  font-size: 12px;
  display: block;
}
.input-label strong {
  font:
    500 clamp(19px, 3.5cqw, 35px) / 1.3 Georgia,
    serif;
}
.cache-insight {
  position: absolute;
  right: 5%;
  top: 13%;
  z-index: 1;
  display: flex;
  flex-direction: column;
  padding: 10px 16px;
  border: 1px solid #4c9d7b55;
  border-radius: 7px;
  background: #071b15bb;
  box-shadow: 0 0 22px #1d786022;
}
.cache-insight span {
  font-size: 11px;
  color: #b3d2bb;
}
.cache-insight strong {
  font:
    500 clamp(24px, 4cqw, 40px) / 1.3 Georgia,
    serif;
  color: #a7eccd;
}
.token-readouts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
  padding: 0 0 22px;
  margin-top: -8px;
  position: relative;
  z-index: 1;
}
.token-readout {
  border-left: 1px solid currentColor;
  padding-left: 14px;
  min-width: 0;
}
.token-readout span {
  font-size: 12px;
}
.token-readout strong {
  white-space: nowrap;
  display: block;
  font:
    500 clamp(23px, 3.5cqw, 36px) / 1.5 Georgia,
    serif;
  overflow-wrap: anywhere;
}
.token-readout small {
  display: block;
  color: #8fac9d;
  font-size: 10px;
}
.cache {
  color: #a3efca;
}
.fresh {
  color: #aedaff;
}
.output {
  color: #f6d68c;
}
.token-parts {
  height: 5px;
  display: flex;
  margin: 0;
  background: #3c4941;
  overflow: hidden;
  border-radius: 5px;
}
.token-parts > div {
  height: 100%;
  background: var(--tone);
}
.token-equation {
  font-size: 11px;
  color: #c1d1c1;
  padding: 14px 0 0;
  line-height: 1.8;
}
.token-scale-note {
  font-size: 11px;
  color: #7b9889;
  padding: 5px 0 20px;
  line-height: 1.8;
}
.token-empty {
  padding: 30px 0;
  color: #96ac9c;
  font-size: 12px;
}
@container (max-width:520px) {
  .token-heading {
    padding: 20px 0 0;
    gap: 10px;
  }
  .token-heading h2 {
    font-size: 21px;
  }
  .token-heading p {
    font-size: 10px;
  }
  .token-total strong {
    font-size: 24px;
  }
  .token-landscape {
    margin-top: 0;
    aspect-ratio: 1.7;
  }
  .cache-insight {
    right: 3%;
    padding: 8px;
    top: 8%;
  }
  .cache-insight strong {
    font-size: 24px;
  }
  .input-label {
    color: #e8f0de;
    left: 28%;
    top: 21%;
  }
  .token-readouts {
    padding-inline: 0;
    gap: 10px;
  }
  .token-readout {
    padding-left: 8px;
  }
  .token-readout span {
    font-size: 10px;
  }
  .token-readout strong {
    white-space: nowrap;
    font-size: 20px;
  }
  .token-readout small {
    font-size: 11px;
  }
  .token-parts {
    margin-inline: 0;
  }
  .token-equation,
  .token-scale-note {
    padding-inline: 0;
  }
}

.has-token-data {
  position: relative;
  border-radius: 4px;
}
.has-token-data .token-heading {
  position: absolute;
  inset: 14px 0 auto;
  padding: 0;
  display: block;
  pointer-events: none;
}
.has-token-data .token-heading > div > span {
  display: none;
}
.has-token-data .token-heading h2 {
  font-size: clamp(20px, 3cqw, 30px);
  margin: 0 0 9px;
}
.has-token-data .token-heading p {
  font-size: clamp(9px, 1.5cqw, 14px);
  line-height: 1.65;
  width: 25%;
}
.has-token-data .token-total {
  position: absolute;
  left: 40%;
  top: 0;
  text-align: left;
}
.has-token-data .token-total > span {
  display: block !important;
  font-size: clamp(10px, 1.7cqw, 16px);
}
.has-token-data .token-total strong {
  font-size: clamp(27px, 4.9cqw, 48px);
  line-height: 1.2;
}
.has-token-data .token-total small {
  font-size: 10px;
}
.has-token-data .token-landscape {
  margin: 0;
}
.has-token-data .input-label {
  top: 30%;
  left: 32%;
  pointer-events: auto;
}
.has-token-data .input-label strong {
  font-size: clamp(19px, 3.4cqw, 34px);
}
.has-token-data .token-readouts {
  position: absolute;
  inset: 0;
  display: block;
  margin: 0;
  padding: 0;
  pointer-events: none;
}
.has-token-data .token-readout {
  position: absolute;
  border-left: 1px solid currentColor;
  text-shadow: 0 1px 8px #000;
  pointer-events: auto;
}
.has-token-data .token-readout.output {
  left: 80%;
  top: 49%;
}
.has-token-data .token-readout span {
  font-size: clamp(10px, 1.7cqw, 16px);
}
.has-token-data .token-readout strong {
  font-size: clamp(20px, 3.5cqw, 34px);
}
.has-token-data .token-parts {
  position: absolute;
  left: 3%;
  right: 3%;
  bottom: 0;
  margin: 0;
  height: 2px;
  opacity: 0.6;
}
.has-token-data .token-equation {
  position: absolute;
  padding: 0;
  color: #b1c4b5;
}
.has-token-data .token-scale-note {
  position: absolute;
  right: 3%;
  bottom: 3%;
  padding: 0;
  font-size: 11px;
  max-width: 45%;
  text-align: right;
  opacity: 1;
}
@container (max-width:480px) {
  .has-token-data .token-heading {
    position: relative;
    inset: auto;
    padding: 17px 0 0;
  }
  .has-token-data .token-heading h2 {
    font-size: 25px;
  }
  .has-token-data .token-heading p {
    width: 100%;
    font-size: 10px;
    line-height: 1.6;
  }
  .has-token-data .token-heading p br {
    display: none;
  }
  .has-token-data .token-total {
    right: 15px;
    left: auto;
    top: 17px;
    text-align: right;
  }
  .has-token-data .token-total strong {
    font-size: 25px;
  }
  .has-token-data .token-total > span {
    font-size: 10px;
  }
  .has-token-data .input-label {
    top: 24%;
    left: 27%;
  }
  .has-token-data .cache-insight {
    padding: 7px;
  }
  .has-token-data .token-readouts {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 9px;
    padding: 0 0 15px;
  }
  .has-token-data .token-readout {
    position: static;
    background: none;
  }
  .has-token-data .token-readout strong {
    font-size: 20px;
  }
  .has-token-data .token-readout small {
    display: block;
    font-size: 11px;
  }
  .has-token-data .token-equation,
  .has-token-data .token-scale-note {
    position: static;
    padding: 4px 0;
    max-width: none;
    text-align: left;
    font-size: 11px;
  }
  .has-token-data .token-scale-note {
    padding-bottom: 14px;
  }
  .has-token-data .token-parts {
    position: static;
    margin: 0 15px;
  }
}

@container (max-width:480px) {
  .has-token-data .token-heading p {
    display: none;
  }
  .has-token-data .token-heading {
    min-height: 79px;
  }
}

.has-token-data .token-landscape {
  aspect-ratio: 637/307;
}
.has-token-data .cache-insight {
  right: 2%;
  top: 16%;
  width: 12%;
  padding: 0;
  border: 0;
  background: none;
  box-shadow: none;
}
.has-token-data .cache-insight span {
  font-size: clamp(9px, 1.6cqw, 14px);
}
.has-token-data .cache-insight strong {
  font-size: clamp(22px, 4.6cqw, 42px);
}
.has-token-data .token-readout.cache {
  left: 32.5%;
  top: 56%;
}
.has-token-data .token-readout.fresh {
  left: 55%;
  top: 56%;
}
.has-token-data .token-readout {
  padding: 3px 5px;
  background: none;
}
.has-token-data .token-readout span {
  line-height: 1.2;
}
.has-token-data .token-readout strong {
  line-height: 1.1;
}
.has-token-data .token-equation {
  left: 3%;
  top: 43%;
  bottom: auto;
  max-width: 21%;
  font-size: clamp(8px, 1.3cqw, 11px);
}
@container (max-width:480px) {
  .has-token-data .token-landscape {
    aspect-ratio: 1.7;
  }
  .has-token-data .cache-insight {
    width: 14%;
    top: 16%;
    right: 2%;
  }
  .has-token-data .cache-insight strong {
    font-size: 15px;
  }
  .has-token-data .cache-insight span {
    font-size: 11px;
  }
  .has-token-data .token-readout {
    padding-left: 7px;
  }
  .has-token-data .token-equation {
    position: static;
    max-width: none;
    padding: 4px 0;
  }
}

.has-token-data .token-total strong {
  display: inline-block;
}
.has-token-data .token-total small {
  display: inline;
  margin-left: 5px;
}
.token-readout em {
  display: block;
  font-size: clamp(9px, 1.6cqw, 12px);
  font-style: normal;
  color: #bdcfc2;
  line-height: 1.4;
}
.input-label small {
  font-size: 10px;
  margin-left: 5px;
  color: #c3d4c8;
}
@container (max-width:480px) {
  .token-readout em {
    display: none;
  }
}

.has-token-data .token-readout small {
  display: block;
  font-size: clamp(11px, 1.1cqw, 12px);
  line-height: 1.4;
  color: #c0d2c6;
}
/* Horizontal footprint follows the host; compactness is controlled vertically. */
.token-stage {
  position: relative;
  container-type: inline-size;
  width: 100%;
  margin-inline: auto;
}
@container (max-width:480px) {
  .has-token-data .token-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    min-height: 68px;
    padding-top: 12px;
  }
  .has-token-data .token-heading h2 {
    font-size: 19px;
    max-width: 11em;
  }
  .has-token-data .token-total {
    position: static;
    flex: none;
  }
}
/* Keep native readouts legible over reflections without rectangular blur plates. */
.has-token-data .token-readout, .has-token-data .input-label { text-shadow:0 1px 3px #02100ef0,0 0 7px #02100e99; }
.has-token-data .token-readout small { color:#d3e3d9; }
@container(max-width:480px) {
 .has-token-data .cache-insight { right:1%; width:12%; top:14%; }
 .has-token-data .cache-insight strong { font-size:14px; line-height:1.3; }
 .has-token-data .cache-insight span { font-size:10px; line-height:1.3; display:block; }
 .has-token-data .token-equation { font-size:11px; line-height:1.5; }
 .has-token-data .token-scale-note { line-height:1.5; padding-top:2px; padding-bottom:9px; }
 .has-token-data .token-readouts { padding-bottom:9px; }
 .has-token-data .token-heading { min-height:62px; }
}
@container (min-width:481px) {
 .has-token-data .token-landscape { aspect-ratio:auto; height:min(48.2cqw, 484px); }
}

/* Blend only the outer scene edges into the host page, without a card fill. */
.token-landscape {
  mask-image: linear-gradient(to right, transparent, #000 2%, #000 98%, transparent), linear-gradient(to bottom, transparent, #000 5%, #000 92%, transparent);
  mask-composite: intersect;
}
</style>
