<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import { monitorAutomaticPriceSummary, monitorCacheRatio, monitorCacheCoverage, type MonitorModelUsage, type LiveSnapshot } from '@/api/usageMonitor'
import type { LocalCostReport } from '@/api/localCost'
import { usageLocale } from '@/utils/usageFormat'
import { usageModelColor } from './usageChartPalette'
import { displayLiveRate } from './liveRate'

const props = defineProps<{ models: MonitorModelUsage[]; expenses?: LocalCostReport['apiExpense']['byModel']; live?: LiveSnapshot | null; evidence?: boolean; period?: string; loading?: boolean }>()
const emit = defineEmits<{ evidence: [tool: string, model: string] }>()
const { t } = useI18n()
const number = (value: number) => value.toLocaleString(usageLocale())
const compact = (value: number) => new Intl.NumberFormat(usageLocale(), { notation: 'compact', maximumFractionDigits: 2 }).format(value)
const money = (amount: number, currency: string) => new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 4 }).format(amount)
const value = (row: MonitorModelUsage) => monitorAutomaticPriceSummary(row.totals).currencies.filter(item => item.identifiedSubtotal != null).map(item => money(item.identifiedSubtotal!, item.currency)).join(' / ') || t('usageMonitor.text.estimateUnavailable')
const expense = (row: MonitorModelUsage) => props.expenses?.find(item => item.tool === row.tool && item.model === row.model)
const expenseText = (row: MonitorModelUsage) => {
  const cost = expense(row)
  return cost?.pricedRequests ? Object.entries(cost.byCurrency).map(([currency, amount]) => money(amount, currency)).join(' / ') : cost?.missingRequests ? t('desktop.localCost.notEntered') : '—'
}
const rate = (row: MonitorModelUsage) => {
  const reported = props.live?.byModel.find(item => item.tool === row.tool && item.model === row.model)?.windows.find(item => item.seconds === 60)
  const coverage = props.live?.byTool.find(item => item.tool === row.tool)?.windows.find(item => item.seconds === 60)
  return displayLiveRate(reported ?? (coverage ? { ...coverage, observedOutputTokens: 0, outputTokensPerSecond: coverage.complete ? 0 : null } : undefined))
}
const speedText = (value: number) => value > 0 && value < 0.01 ? new Intl.NumberFormat(usageLocale(), { maximumSignificantDigits: 2 }).format(value) : value.toFixed(2)
const timingLabel = (basis: string | null) => t('desktop.localCost.' + (basis?.includes('turn') ? 'turnTiming' : basis?.includes('request') ? 'requestTiming' : 'recordedTiming'))
const toolName = (tool: string) => ({ api:'API',codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', 'deepseek-harness': 'DeepSeek Harness' }[tool] ?? tool)
</script>

<template>
  <section class="model-cost-section model-details">
    <header><h2>{{ t('usageMonitor.text.modelsCost') }}</h2><span>{{ period }} {{ t('usageMonitor.text.basedOnSavedRequestsAndPricingEvidence') }}</span></header>
    <div class="table-scroll" role="region" :aria-label="t('usageMonitor.text.modelsCostTable')" tabindex="0"><table class="model-cost-table">
      <thead><tr><th>{{ t('usageMonitor.text.model') }}</th><th>{{ t('usageMonitor.text.requests3') }}</th><th>{{ t('usageMonitor.text.inputOutput') }}</th><th>{{ t('usageMonitor.text.cacheHit') }}</th><th>{{ t('usageMonitor.text.referenceCost') }}</th><th>{{ t('desktop.localCost.apiCost') }}</th><th>{{ t('desktop.localCost.observedRate') }}</th><th>{{ t('usageMonitor.text.pricingCoverage') }}</th></tr></thead>
      <tbody><tr v-for="row in models" :key="row.tool + ':' + row.model" :style="{ '--model-color': usageModelColor(row.model) }">
        <td><strong class="model-name">{{ row.model || t('usageMonitor.text.unidentifiedModel') }}</strong><small>{{ toolName(row.tool) }}</small></td>
        <td>{{ number(row.totals.requestCount) }}</td>
        <td :title="number(row.totals.inputTokens) + ' / ' + number(row.totals.outputTokens)">{{ compact(row.totals.inputTokens) }} / {{ compact(row.totals.outputTokens) }}<small v-if="row.totals.incompleteRequests">{{ t('desktop.localCost.knownPart') }}</small></td>
        <td>{{ monitorCacheRatio(row.totals) }}<small :title="number(row.totals.cacheReadTokens) + ' / ' + number(row.totals.cacheWriteTokens)">{{ t('usageMonitor.text.read') }} {{ compact(row.totals.cacheReadTokens) }} {{ t('usageMonitor.text.write2') }} {{ compact(row.totals.cacheWriteTokens) }}</small><small v-if="monitorCacheCoverage(row.totals)">{{ monitorCacheCoverage(row.totals) }}</small></td>
        <td class="model-money">{{ value(row) }}</td>
        <td>{{ expenseText(row) }}<small v-if="expense(row)?.missingRequests">{{ t('usageMonitor.inlineCosts.apiMissing', { count: number(expense(row)!.missingRequests) }) }}</small></td>
        <td class="model-speed"><strong>{{ rate(row).text }}<template v-if="rate(row).value != null && rate(row).value! > 0"> Token/s</template></strong><small>{{ t('desktop.localCost.lastMinute') }}</small><details class="request-rate-details"><summary>{{ t('desktop.localCost.requestSpeed') }}</summary><div v-for="speed in row.speeds?.filter(item => item.outputTokensPerSecond != null)" :key="speed.basis ?? ''">{{ speedText(speed.outputTokensPerSecond!) }} Token/s<small>{{ speed.validSamples }} / {{ row.totals.requestCount }} {{ t('desktop.localCost.timedRequests') }} · {{ timingLabel(speed.basis) }}</small></div><span v-if="!row.speeds?.some(item => item.outputTokensPerSecond != null)">{{ t('desktop.localCost.durationUnavailable') }}</span></details></td>
        <td><span class="coverage-badge" :class="{ complete: row.totals.requestCount > 0 && monitorAutomaticPriceSummary(row.totals).complete }">{{ number(monitorAutomaticPriceSummary(row.totals).coveredRequests) }} / {{ number(row.totals.requestCount) }}</span><button v-if="evidence && row.model" class="model-evidence-link" type="button" :aria-label="t('usageMonitor.text.view') + toolName(row.tool) + ' ' + row.model + t('usageMonitor.text.pricingEvidence')" @click="emit('evidence', row.tool, row.model)">{{ t('usageMonitor.text.viewEvidence') }}<ChevronRight :size="13" /></button></td>
      </tr><tr v-if="!models.length"><td colspan="8" class="empty">{{ t(loading ? 'usageMonitor.text.loadingModelUsage' : 'usageMonitor.text.noModelUsageInTheSelectedRange') }}</td></tr></tbody>
    </table></div>
  </section>
</template>

<style scoped>
.model-cost-section{min-width:0;padding:24px 0;border-top:1px solid var(--cost-line)}header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}h2{font-size:20px;font-weight:650;margin:0}header>span{font-size:11px;color:var(--cost-muted)}.table-scroll{overflow-x:auto;width:100%}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:14px 12px;vertical-align:top;border-bottom:1px solid var(--cost-line);font-variant-numeric:tabular-nums}th{font-weight:400;font-size:11px;color:var(--cost-muted);background:var(--cost-panel)}td{min-width:85px}td:first-child{min-width:165px}.model-name{display:block;border-left:3px solid var(--model-color);padding-left:9px;font-size:13px;overflow-wrap:anywhere}small{display:block;color:var(--cost-muted);font-size:10px;line-height:1.6;margin-top:6px}.model-money{color:var(--usage-value);font-weight:600}.model-speed>strong{color:var(--cost-blue);font-size:12px;font-weight:500}.request-rate-details{font-size:10px;color:var(--cost-muted);margin-top:8px}.request-rate-details summary{cursor:pointer}.request-rate-details>div{margin-top:8px}.coverage-badge{display:inline-block;border:1px solid var(--cost-line);padding:3px 6px;border-radius:3px;font-size:11px;white-space:nowrap}.coverage-badge.complete{color:var(--cost-lime)}.model-evidence-link{display:flex;align-items:center;gap:4px;margin-top:9px;color:var(--cost-blue);font-size:11px;white-space:nowrap}.empty{text-align:center;padding:28px;color:var(--cost-muted)}
</style>
