<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUpRight, Plus, Settings2 } from '@lucide/vue'
import type { localCostOverview, LocalCostRow } from './localCostMath'
import { usageLocale } from '@/utils/usageFormat'

const props = defineProps<{ rows: LocalCostRow[]; summary: ReturnType<typeof localCostOverview> }>()
const emit = defineEmits<{ account: [id: string]; accounts: []; enter: []; prices: [] }>()
const { t } = useI18n()
const money = (value: number) => new Intl.NumberFormat(usageLocale(), { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(value)
const ranking = computed(() => props.rows.filter(row => row.metrics.valueCny != null && row.metrics.valueCny > 0).slice().sort((a,b) => b.metrics.valueCny! - a.metrics.valueCny!).slice(0,5))
const breakdown = computed(() => [
  { key:'subscriptionCost', value:props.summary.accruedCny, color:'var(--usage-input)' },
  { key:'apiCost', value:props.summary.apiCny, color:'var(--usage-output)' },
  { key:'confirmedLoss', value:props.summary.lossesCny, color:'var(--cost-gold)' },
  { key:'costCredits', value:props.summary.creditsCny ? -props.summary.creditsCny : props.summary.creditsCny, color:'var(--usage-cache)' },
])
const maximumExpense = computed(() => Math.max(1, ...breakdown.value.map(item => Math.abs(item.value ?? 0))))
</script>

<template>
  <div class="cost-insights">
    <section class="cost-ranking" :aria-label="t('usageMonitor.delivery.accountRanking')">
      <header><h2>{{ t('usageMonitor.delivery.accountRanking') }}</h2><button type="button" @click="emit('accounts')">{{ t('usageMonitor.delivery.allAccounts') }}<ArrowUpRight :size="14" /></button></header>
      <p class="insight-context">CNY · {{ t('usageMonitor.delivery.rankKnown') }}</p>
      <div v-if="!ranking.length" class="insight-empty">{{ t('desktop.localCost.noPricedUsage') }}</div>
      <button v-for="(row,index) in ranking" :key="row.id" type="button" class="cost-rank-row" :title="row.name" @click="emit('account',row.id)">
        <span class="rank-index">{{ index+1 }}</span><span class="rank-label">{{ row.name }}<i aria-hidden="true" :style="{width:row.metrics.valueCny!/ranking[0].metrics.valueCny!*100+'%'}" /></span><strong>{{ money(row.metrics.valueCny!) }}</strong><ArrowUpRight :size="13" />
      </button>
    </section>
    <section class="cost-breakdown" :aria-label="t('desktop.localCost.costBreakdown')">
      <header><h2>{{ t('desktop.localCost.costBreakdown') }}</h2><strong v-if="summary.expenseCny!=null">{{ money(summary.expenseCny) }}<small v-if="summary.costIncomplete">{{ t('usageMonitor.delivery.partialCost') }}</small></strong><span v-else>{{ t('usageMonitor.delivery.noCostRecords') }}</span></header>
      <p class="insight-context">CNY</p>
      <dl>
        <div v-for="item in breakdown" :key="item.key" class="cost-breakdown-row" :style="{'--breakdown-color':item.color}">
          <dt><i aria-hidden="true" />{{ t('desktop.localCost.'+item.key) }}</dt><dd>{{ item.value==null?t('desktop.localCost.notEntered'):money(item.value) }}</dd>
          <span class="cost-breakdown-track" aria-hidden="true"><i v-if="item.value!=null" :style="{width:Math.abs(item.value)/maximumExpense*100+'%'}" /></span>
        </div>
      </dl>
      <div class="cost-entry-actions"><button type="button" @click="emit('enter')"><Plus :size="14" />{{ t('desktop.localCost.enterPurchase') }}</button><button type="button" @click="emit('prices')"><Settings2 :size="14" />{{ t('usageMonitor.delivery.prices') }}</button></div>
    </section>
  </div>
</template>

<style scoped>
.cost-insights{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:36px;border-bottom:1px solid var(--cost-line);padding:4px 0 22px;margin-bottom:22px}.cost-insights>section{min-width:0}.cost-insights header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-height:24px}.cost-insights h2{font-size:15px;font-weight:600;margin:0}.cost-insights header>span,.insight-context,.insight-empty{font-size:11px;color:var(--cost-muted)}.insight-context{margin:6px 0 12px}.cost-insights header button,.cost-entry-actions button{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--cost-blue);min-height:28px}.cost-insights header>strong{text-align:right;font-size:16px;font-variant-numeric:tabular-nums}.cost-insights header small{display:block;font-size:10px;font-weight:400;color:var(--cost-gold);margin-top:3px}
.cost-rank-row{display:grid;grid-template-columns:18px minmax(0,1fr) max-content 13px;gap:10px;align-items:center;min-height:36px;width:100%;text-align:left;font-size:12px}.cost-rank-row:hover{color:var(--cost-lime)}.rank-index{color:var(--cost-muted);font-size:10px}.rank-label{position:relative;min-width:0;padding:7px 0 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rank-label>i{position:absolute;bottom:1px;left:0;height:3px;background:var(--usage-input);opacity:.65}.cost-rank-row strong{font-weight:500;font-variant-numeric:tabular-nums}.cost-rank-row>svg{color:var(--cost-muted)}
.cost-breakdown dl{margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 22px}.cost-breakdown-row{min-width:0}.cost-breakdown dt{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--cost-muted)}.cost-breakdown dt>i{width:6px;height:6px;flex:0 0 6px;background:var(--breakdown-color)}.cost-breakdown dd{margin:7px 0;font-size:16px;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.cost-breakdown-track{display:block;height:3px;background:var(--cost-panel-2)}.cost-breakdown-track>i{display:block;height:100%;background:var(--breakdown-color)}.cost-entry-actions{display:flex;gap:20px;flex-wrap:wrap;margin-top:14px}.insight-empty{min-height:130px;display:flex;align-items:center}
@media(max-width:700px){.cost-insights{grid-template-columns:1fr;gap:24px}.cost-rank-row{font-size:11px}}
</style>
