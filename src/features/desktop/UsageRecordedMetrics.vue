<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { monitorAutomaticPriceSummary, monitorCacheRatio, type MonitorTotals } from '@/api/usageMonitor'
import { usageLocale } from '@/utils/usageFormat'
const props = defineProps<{ totals?: MonitorTotals | null }>()
const { t } = useI18n()
const number = (value: number | null | undefined) => value == null ? t('usageMonitor.text.unknown') : value.toLocaleString(usageLocale())
const metrics = computed(() => [
  { key: 'inputRecorded', value: number(props.totals?.inputTokens) },
  { key: 'outputRecorded', value: number(props.totals?.outputTokens) },
  { key: 'cacheRead', value: number(props.totals?.cacheReadTokens) },
  { key: 'cacheWrite', value: number(props.totals?.cacheWriteTokens) },
  { key: 'cacheHit', value: monitorCacheRatio(props.totals) },
  { key: 'priceCoverage', value: `${number(props.totals ? monitorAutomaticPriceSummary(props.totals).coveredRequests : null)} / ${number(props.totals?.requestCount)}` },
])
</script>

<template>
  <dl class="recorded-usage"><div v-for="item in metrics" :key="item.key"><dt>{{ t('desktop.localCost.' + item.key) }}</dt><dd>{{ item.value }}</dd></div></dl>
</template>

<style scoped>
.recorded-usage{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:18px;padding:24px 0;margin:0;border-bottom:1px solid var(--cost-line)}.recorded-usage>div{min-width:0}.recorded-usage dt{font-size:11px;color:var(--cost-muted);line-height:1.6}.recorded-usage dd{font-size:17px;font-weight:550;margin:9px 0 0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}@media(max-width:1050px){.recorded-usage{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:550px){.recorded-usage{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
