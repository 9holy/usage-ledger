<template>
  <section class="asset-overview" aria-labelledby="asset-overview-title" data-design="asset-overview-approved-20261024">
    <header class="asset-overview__heading">
      <div><h2 id="asset-overview-title"> {{ t('costComponents.assetAndCostOverview') }} </h2><span class="asset-overview__source">{{ sourceLabel }}</span></div>
      <p>{{ scopeLabel }}</p>
    </header>
    <div class="asset-overview__hero">
      <picture class="asset-overview__artwork asset-overview__artwork--fallback"><img class="asset-overview__surface" :src="surfaceUrl" alt="" aria-hidden="true" /></picture>
      <div class="asset-overview__artwork asset-overview__artwork--desktop" aria-hidden="true">
        <span class="asset-overview__art-slice asset-overview__art-slice--left"><img :src="stageUrl" alt="" /></span>
        <span class="asset-overview__art-slice asset-overview__art-slice--right"><img :src="stageUrl" alt="" /></span>
      </div>
      <div class="asset-overview__total" :title="totalNote">
        <strong>{{ total }}</strong><span>{{ totalLabel }}</span>
      </div>
      <div class="asset-overview__flows">
        <div v-for="node in flowNodes" :key="node.slot" class="asset-overview__node" :class="`asset-overview__node--${node.slot}`">
          <span class="asset-overview__orb" aria-hidden="true"><component :is="node.icon" :size="27" :stroke-width="2" /></span>
          <slot :name="node.slot" />
        </div>
      </div>
      <div class="asset-overview__budget"><Coins :size="25" aria-hidden="true" /><slot name="budget" /></div>
    </div>
    <div class="asset-overview__metrics asset-overview__metrics--primary">
      <div v-for="metric in primaryMetrics" :key="metric.slot" class="asset-overview__metric">
        <component :is="metric.icon" :size="22" aria-hidden="true" /><slot :name="metric.slot" />
      </div>
    </div>
    <div class="asset-overview__metrics asset-overview__metrics--secondary">
      <div class="asset-overview__metric asset-overview__accounts">
        <UserRound :size="22" aria-hidden="true" /><slot name="accounts" />
        <div class="asset-overview__progress" :class="{ 'is-unknown': activeRatio == null }" role="progressbar" :aria-label="t('costComponents.availableAccountRatio')" :aria-valuenow="activeRatio == null ? undefined : Math.round(activeRatio * 100)" :aria-valuetext="activeRatio == null ? t('costComponents.accountDataUnavailable') : `${activeCount} / ${accountCount}`" :aria-valuemin="0" :aria-valuemax="100"><i v-if="activeRatio != null" :style="{ width: `${activeRatio * 100}%` }" /></div>
      </div>
      <div v-for="metric in secondaryMetrics" :key="metric.slot" class="asset-overview__metric">
        <component :is="metric.icon" :size="22" aria-hidden="true" /><slot :name="metric.slot" />
      </div>
      <p class="asset-overview__disclaimer"><Info :size="15" aria-hidden="true" /><span> {{ t('costComponents.estimatedAmountsAreForReferenceOnlyMissing') }} </span></p>
    </div>
    <footer>{{ updatedLabel }} {{ t('costComponents.costsStartWhenTheAccountJoins') }} </footer>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

import { computed } from 'vue'
import { ShoppingCart, ReceiptText, Settings, Coins, Box, ChartNoAxesColumnIncreasing, Zap, CalendarDays, FileText, UserRound, CircleDollarSign, ChartPie, TrendingUp, Clock3, Info } from '@lucide/vue'
import surfaceUrl from './assets/asset-overview-surface.svg'
import stageUrl from './assets/asset-overview-stage.webp'

// This component is presentation-only. All money, provenance and availability
// remain in the existing parent bindings / TruthfulMetric named slots.
const props = defineProps<{
  total: string
  totalLabel: string
  totalNote: string
  sourceLabel: string
  scopeLabel: string
  updatedLabel: string
  activeCount: number | null
  accountCount: number | null
}>()
const activeRatio = computed(() => props.activeCount == null || props.accountCount == null || props.accountCount <= 0
  ? null : Math.min(1, Math.max(0, props.activeCount / props.accountCount)))
const flowNodes = [{ slot: 'procurement', icon: ShoppingCart }, { slot: 'loss', icon: ReceiptText }, { slot: 'operations', icon: Settings }]
const primaryMetrics = [{ slot: 'hourlyUsage', icon: Box }, { slot: 'rolling', icon: ChartNoAxesColumnIncreasing }, { slot: 'hourlyTotal', icon: Zap }, { slot: 'today', icon: CalendarDays }, { slot: 'period', icon: FileText }]
const secondaryMetrics = [{ slot: 'unitCost', icon: CircleDollarSign }, { slot: 'profit', icon: ChartPie }, { slot: 'payback', icon: TrendingUp }, { slot: 'paybackTime', icon: Clock3 }]
</script>

<style scoped>
.asset-overview { min-width: 0; margin-top: 20px; color: #e6eee9; }
.asset-overview__heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0 0 10px; }
.asset-overview__heading > div { display: flex; align-items: center; min-width: 0; gap: 22px; }
.asset-overview__heading h2 { margin: 0; font: 700 clamp(25px, 2.6vw, 40px)/1.2 'Segoe UI', 'Microsoft YaHei', sans-serif; letter-spacing: -.045em; color: #edf3ef; font-weight: 700 !important; }
.asset-overview__source { padding-left: 22px; border-left: 1px solid #729789; color: #afc5c9; font-size: 13px; }
.asset-overview__heading p { margin: 0; font-size: 11px; color: #9db2a8; text-align: right; }
.asset-overview__hero { position: relative; isolation: isolate; height: clamp(225px, 15.5vw, 255px); margin-bottom: 8px; background: radial-gradient(ellipse at 19% 55%, #0a4b2d44, transparent 38%), radial-gradient(ellipse at 85% 78%, #0c5d4d35, transparent 40%); }
.asset-overview__artwork { position: absolute; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
.asset-overview__artwork--desktop { display: none; }
.asset-overview__surface { position: absolute; inset: 0; z-index: -1; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
.asset-overview__total { position: absolute; left: 6.8%; top: 27%; width: 19%; text-align: center; display: grid; gap: 8px; }
.asset-overview__total strong { font: 700 clamp(25px, 2.6vw, 40px)/1.2 'Segoe UI', sans-serif; letter-spacing: -.035em; overflow-wrap: anywhere; text-shadow: 0 2px 18px #001c12; }
.asset-overview__total span { color: #d6e5d5; font-size: 13px; }
.asset-overview__flows { position: absolute; left: 33%; right: 2%; top: 3%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6%; }
.asset-overview__node { position: relative; display: flex; align-items: flex-start; gap: 14px; min-width: 0; min-height: 120px; padding: 12px 10px 15px 3px; border-top: 1px solid #8ad2aa80; border-radius: 36px 25px 48px 55px; background: linear-gradient(120deg, #10251a33, #041e1266 60%, #051b1277); box-shadow: inset 0 1px 1px #bbfbd320, 0 1px 1px #6dd8aa33; }
.asset-overview__node--loss { border-color: #e8d37860; background: linear-gradient(120deg, #39301b33, #121d1466 60%, #10211355); }
.asset-overview__node--operations { border-color: #84dbcd70; background: linear-gradient(120deg, #16433b44, #04282055 60%, #021e1366); }
.asset-overview__orb { display: grid; place-items: center; width: 65px; height: 68px; flex: 0 0 65px; margin: 0 0 0 -2px; border: 2px solid #d5ffb4b0; border-radius: 50%; color: #c1ffd3; background: radial-gradient(ellipse at 35% 18%, #ceffb9aa, transparent 40%), radial-gradient(ellipse at 65% 60%, #052c19 10%, #137d30 65%, #ceff9c); box-shadow: inset 4px 0 4px #e7ffd1bb, inset -5px -4px 9px #2a812d, 0 0 22px #79e96c66; }
.asset-overview__orb svg { filter: drop-shadow(0 0 6px #b8ffc47a); }
.asset-overview__node--loss .asset-overview__orb { color: #fff0b1; border-color: #fff1a7bb; background: radial-gradient(ellipse at 30% 15%, #fff1bcaa, transparent 40%), radial-gradient(ellipse at 65% 60%, #4b3810 10%, #a3841f 65%, #ffe487); box-shadow: inset 4px 0 4px #fff2c5bb, inset -5px -4px 9px #94721d, 0 0 22px #dfbc4e66; }
.asset-overview__node--operations .asset-overview__orb { color: #b4fff3; border-color: #a4fff5bb; background: radial-gradient(ellipse at 30% 15%, #bdfff2aa, transparent 40%), radial-gradient(ellipse at 65% 60%, #073b31 10%, #08756b 65%, #91fff1); box-shadow: inset 4px 0 4px #b8fff4bb, inset -5px -4px 9px #106c68, 0 0 22px #4ad8c266; }
.asset-overview__budget { position: absolute; left: 33%; right: 8%; bottom: 6%; min-height: 62px; display: flex; align-items: center; gap: 25px; padding: 8px 25px; border: 1px solid #b5e8a08a; border-radius: 22px 65% 65% 22px / 22px 60% 60% 22px; background: linear-gradient(100deg, #0c4425bb, #10291cdd 45%, #2c4d2c88 75%, #122a1b11); box-shadow: inset 2px 1px 5px #c3ffc06b, inset 0 -2px 8px #71e4a133, 0 0 17px #8ee99520; }
.asset-overview__budget > svg { color: #f8e7a0; flex-shrink: 0; filter: drop-shadow(0 0 8px #c1d88b66); }
.asset-overview__metrics { display: grid; overflow: hidden; border: 1px solid var(--cost-line); border-radius: 18px; background: var(--cost-panel); box-shadow: inset 0 1px #d6f5e505; }
.asset-overview__metrics--primary { grid-template-columns: repeat(5, minmax(0, 1fr)); padding: 18px 0; }
.asset-overview__metrics--secondary { grid-template-columns: 1.05fr 1.1fr 1fr .83fr 1fr 1.18fr; margin-top: 12px; padding: 15px 0; }
.asset-overview__metric { position: relative; display: flex; align-items: flex-start; min-width: 0; gap: 15px; padding: 0 18px; border-right: 1px solid #2b4235; }
.asset-overview__metric:last-child { border-right: 0; }
.asset-overview__metric > svg { flex-shrink: 0; margin-top: 5px; color: #89b0bf; stroke-width: 1.6; }
.asset-overview__metric:nth-child(3) > svg { color: #e7d064; }
.asset-overview :deep(.asset-metric-detail) { display: contents; }
.asset-overview :deep(.cost-metric-cell) { display: flex; flex: 1; flex-direction: column; justify-content: flex-start; min-width: 0; padding: 0; border: 0; background: transparent; }
.asset-overview :deep(.cost-metric-cell::before) { display: none; }
.asset-overview :deep(.cost-metric-cell__heading) { align-items: center; flex-wrap: wrap; gap: 4px 6px; }
.asset-overview :deep(.cost-metric-cell__label) { color: #b8ccc3; font-size: 12px; line-height: 1.45; }
.asset-overview :deep(.cost-metric-cell__value) { margin-top: 8px; color: #e9f0eb; font: 650 clamp(19px, 1.65vw, 26px)/1.2 'Segoe UI', sans-serif; letter-spacing: -.025em; font-variant-numeric: tabular-nums; }
.asset-overview :deep(.cost-metric-cell__note) { margin-top: 8px; color: #97ada1; font: 10px/1.55 'Segoe UI', 'Microsoft YaHei', sans-serif; overflow-wrap: anywhere; }
.asset-overview :deep(.cost-metric-cell__state) { padding: 2px 5px; font-size: 9px; background: #16261b44; gap: 3px; }
.asset-overview :deep(.data-unavailable .cost-metric-cell__value), .asset-overview :deep(.data-loading .cost-metric-cell__value) { color: #b6c3bb; }
.asset-overview__node :deep(.cost-metric-cell__heading) { justify-content: flex-start; }
.asset-overview__node :deep(.cost-metric-cell__label) { color: #d5e4d9; font-size: 17px; font-weight: 650; }
.asset-overview__node :deep(.cost-metric-cell__value) { font-size: clamp(20px, 1.8vw, 28px); margin-top: 8px; }
.asset-overview__node :deep(.cost-metric-cell__note) { font-size: 10px; line-height: 1.5; }
.asset-overview__budget :deep(.cost-metric-cell) { display: grid; grid-template-columns: max-content max-content minmax(0, 1fr); align-items: center; gap: 18px; }
.asset-overview__budget :deep(.cost-metric-cell__heading) { gap: 8px; }
.asset-overview__budget :deep(.cost-metric-cell__label) { font-size: 14px; }
.asset-overview__budget :deep(.cost-metric-cell__value) { margin: 0; font-size: 30px; }
.asset-overview__budget :deep(.cost-metric-cell__note) { margin: 0; padding-left: 18px; border-left: 1px solid #667c4c88; }
.asset-overview__metrics--secondary :deep(.cost-metric-cell__label) { font-size: 11px; }
.asset-overview__metrics--secondary :deep(.cost-metric-cell__value) { font-size: 21px; }
.asset-overview__metrics--secondary :deep(.cost-metric-cell__note) { font-size: 9px; }
.asset-overview__accounts { flex-wrap: wrap; align-content: start; column-gap: 13px; row-gap: 8px; }
.asset-overview__accounts :deep(.cost-metric-cell) { display: grid; grid-template-columns: auto auto; column-gap: 10px; align-items: center; }
.asset-overview__accounts :deep(.cost-metric-cell__value) { margin: 0; font-size: 20px; }
.asset-overview__accounts :deep(.cost-metric-cell__note) { grid-column: 1 / -1; margin: 2px 0 0; }
.asset-overview__progress { margin-left: 35px; width: calc(100% - 35px); height: 7px; border-radius: 9px; background: #344a47; overflow: hidden; }
.asset-overview__progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6ec963, #c1f786); }
.asset-overview__progress.is-unknown { opacity: .5; background: repeating-linear-gradient(120deg, #344a47 0 5px, #253a34 5px 10px); }
.asset-overview__disclaimer { display: flex; align-items: center; gap: 9px; margin: 0; padding: 0 17px; color: #90aab0; font-size: 10px; line-height: 1.8; }
.asset-overview__disclaimer svg { flex-shrink: 0; }
.asset-overview footer { margin-top: 8px; text-align: right; color: #7f9789; font-size: 10px; }
@media (max-width: 1250px) {
 .asset-overview__flows { left: 31%; right: 0; gap: 3%; }
 .asset-overview__orb { width: 48px; height: 52px; flex-basis: 48px; }
 .asset-overview__node { gap: 9px; }
 .asset-overview__node :deep(.cost-metric-cell__label) { font-size: 14px; }
 .asset-overview__node :deep(.cost-metric-cell__value) { font-size: 21px; }
 .asset-overview__budget { left: 31%; right: 2%; gap: 15px; padding-left: 18px; }
 .asset-overview__budget :deep(.cost-metric-cell) { gap: 12px; }
 .asset-overview__budget :deep(.cost-metric-cell__value) { font-size: 25px; }
 .asset-overview__metric { gap: 9px; padding: 0 12px; }
 .asset-overview__metric > svg { width: 19px; }
 .asset-overview__metrics--secondary { grid-template-columns: repeat(5,minmax(0,1fr)); }
 .asset-overview__disclaimer { grid-column: 1/-1; margin-top: 12px; padding-top: 10px; border-top: 1px solid #294133; }
}
@media (max-width: 900px) {
 .asset-overview__heading { align-items: flex-start; }
 .asset-overview__heading > div { gap: 12px; flex-wrap: wrap; }
 .asset-overview__source { padding-left: 12px; }
 .asset-overview__hero { height: 330px; }
 .asset-overview__surface { height: 230px; }
 .asset-overview__total { top: 60px; }
 .asset-overview__flows { gap: 10px; }
 .asset-overview__node { display: block; padding: 8px; }
 .asset-overview__orb { width: 44px; height: 46px; margin-bottom: 10px; }
 .asset-overview__budget { left: 4%; right: 4%; bottom: 5%; }
 .asset-overview__metrics--primary { grid-template-columns: repeat(3, minmax(0,1fr)); gap: 18px 0; }
 .asset-overview__metrics--secondary { grid-template-columns: repeat(3,minmax(0,1fr)); gap: 18px 0; }
}
@media (max-width: 580px) {
 .asset-overview__heading { flex-direction: column; gap: 8px; }
 .asset-overview__heading h2 { font-size: 25px; }
 .asset-overview__hero { height: auto; padding-top: 190px; }
 .asset-overview__surface { width: 210%; max-width: none; height: 200px; left: -1%; }
 .asset-overview__total { left: 12%; top: 51px; width: 44%; }
 .asset-overview__total strong { font-size: 31px; }
 .asset-overview__flows { position: relative; left: auto; right: auto; top: auto; grid-template-columns: 1fr; gap: 12px; padding: 0 8px; }
 .asset-overview__node { display: flex; min-height: 104px; padding: 13px; gap: 18px; }
 .asset-overview__orb { flex-basis: 52px; width: 52px; height: 56px; }
 .asset-overview__budget { position: relative; left: auto; right: auto; bottom: auto; margin: 15px 8px; padding: 15px; border-radius: 20px; }
 .asset-overview__budget :deep(.cost-metric-cell) { grid-template-columns: 1fr; gap: 6px; }
 .asset-overview__budget :deep(.cost-metric-cell__note) { padding-left: 0; border: 0; }
 .asset-overview__metrics--primary, .asset-overview__metrics--secondary { grid-template-columns: repeat(2,minmax(0,1fr)); }
 .asset-overview__metric { padding: 0 11px; gap: 8px; }
 .asset-overview :deep(.cost-metric-cell__value) { font-size: 19px; }
 .asset-overview__disclaimer { margin-top: 0; }
}
/* Slot metrics also inherit parent-view typography. Override only this approved
   surface, never the shared TruthfulMetric component or other workspaces. */
.asset-overview .asset-overview__node :deep(.cost-metric-cell__value) { font-size: clamp(23px, 1.8vw, 28px) !important; line-height: 1.2; }
.asset-overview .asset-overview__budget :deep(.cost-metric-cell__value) { font-size: 30px !important; }
.asset-overview .asset-overview__metric :deep(.cost-metric-cell__value) { font-size: 25px !important; color: #e9f0eb; }
.asset-overview .asset-overview__metrics--secondary :deep(.cost-metric-cell__value) { font-size: 21px !important; }
.asset-overview .asset-overview__node :deep(.cost-metric-cell__label) { font-size: 18px; font-weight: 650; }
@media(max-width:1250px) { .asset-overview .asset-overview__metric :deep(.cost-metric-cell__value) { font-size: 21px !important; } }
@media(max-width:580px) { .asset-overview .asset-overview__metric :deep(.cost-metric-cell__value) { font-size: 19px !important; } }
/* Text-free static artwork supplies the approved glass/ribbon material only.
   HTML slots remain the single source of all figures, notes and state badges.
   Source art: 2048 × 768, stage begins at y=224. Two continuous horizontal
   mappings share source x=42% at destination x=38.22%; this matches the
   approved narrower pedestal and node anchors without moving live data.
   Only decorative artwork is muted; HTML labels and figures remain unfiltered. */
@media (min-width: 901px) {
 .asset-overview__hero { width: 100%; min-width: 0; height: auto; aspect-ratio: 2048 / 330; min-height: 225px; max-height: 255px; background: none; }
 .asset-overview__artwork--fallback { display: none; }
 .asset-overview__artwork--desktop { display: block; filter: brightness(.76) saturate(.72); }
 .asset-overview__art-slice { position: absolute; inset: 0; }
 .asset-overview__art-slice img { position: absolute; top: 0; left: 0; width: 100%; max-width: none; height: auto; transform-origin: 0 0; }
 .asset-overview__art-slice--left { clip-path: inset(0 61.77% 0 0); }
 .asset-overview__art-slice--left img { transform: translateY(-29.166667%) scaleX(.91); }
 .asset-overview__art-slice--right { clip-path: inset(0 0 0 38.21%); }
 .asset-overview__art-slice--right img { transform: translate(-6.517241%, -29.166667%) scaleX(1.06517241); }
 .asset-overview__flows { left: 0; right: 0; top: 0; display: block; }
 .asset-overview__node { position: absolute; width: 19.6%; }
 .asset-overview__node--procurement { left: 33.4%; }
 .asset-overview__node--loss { left: 56.6%; }
 .asset-overview__node--operations { left: 79.1%; width: 20.5%; }
 .asset-overview__node, .asset-overview__node--loss, .asset-overview__node--operations { min-height: 120px; padding: 18px 0 10px; gap: 14px; border: 0; background: none; box-shadow: none; border-radius: 0; }
 .asset-overview__orb, .asset-overview__node--loss .asset-overview__orb, .asset-overview__node--operations .asset-overview__orb { width: 65px; height: 65px; flex: 0 0 65px; margin: 0; border: 0; background: none; box-shadow: none; }
 .asset-overview__budget { left: 32.4%; right: 9%; bottom: 8%; min-height: 65px; padding: 8px 25px; border: 0; border-radius: 0; background: none; box-shadow: none; }
 .asset-overview__total { left: 6.7%; top: 27%; }
}
@media (min-width: 901px) and (max-width: 1250px) {
 .asset-overview__hero { min-height: 195px; }
 .asset-overview__node { gap: 9px; padding-top: 13px; }
 .asset-overview__orb, .asset-overview__node--loss .asset-overview__orb, .asset-overview__node--operations .asset-overview__orb { width: 48px; height: 52px; flex-basis: 48px; }
 .asset-overview__node :deep(.cost-metric-cell__label) { font-size: 15px; }
 .asset-overview .asset-overview__node :deep(.cost-metric-cell__value) { font-size: 22px !important; }
 .asset-overview__budget { min-height: 52px; padding-left: 15px; bottom: 10%; }
 .asset-overview .asset-overview__budget :deep(.cost-metric-cell__value) { font-size: 26px !important; }
}
</style>
