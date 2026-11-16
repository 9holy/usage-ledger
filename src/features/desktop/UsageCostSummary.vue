<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChartNoAxesColumnIncreasing, Plus, ReceiptText, Settings2, Users, Wallet } from '@lucide/vue'
import { monitorAutomaticPriceSummary } from '@/api/usageMonitor'
import { localCostOverview, type LocalCostRow } from './localCostMath'
import type { MonitorCostSnapshot } from './useMonitorCosts'
import { usageLocale } from '@/utils/usageFormat'

const props = defineProps<{ data: MonitorCostSnapshot; rows: LocalCostRow[]; scope: 'all' | 'api:all'; busy?: boolean; compact?: boolean; hideNavigation?: boolean }>()
const emit = defineEmits<{ open: []; enter: []; usage: []; accounts: []; channels: []; prices: [] }>()
const { t } = useI18n()
const rows = computed(() => props.rows.filter(row => props.scope === 'all' || row.id === props.scope))
const summary = computed(() => localCostOverview(rows.value, props.data.report, props.data.finances.byAccount.filter(row => props.scope === 'all' || row.accountId === props.scope)))
const usdValue = computed(() => {
  const amounts=rows.value.map(row=>monitorAutomaticPriceSummary(row.totals).currencies.find(price=>price.currency==='USD')?.identifiedSubtotal).filter((value):value is number=>value!=null)
  return amounts.length?amounts.reduce((sum,value)=>sum+value,0):null
})
const money = (value: number | null | undefined, currency = 'CNY') => value == null ? t('desktop.localCost.notEntered') : new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, ...(value!==0&&Math.abs(value)<.01?{maximumSignificantDigits:6}:{maximumFractionDigits:2}) }).format(value)
const date = (value: number) => new Date(value).toLocaleString(usageLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const shortDate = (value: number) => new Date(value).toLocaleDateString(usageLocale(),{month:'numeric',day:'numeric'})
const clock = (value: number) => new Date(value).toLocaleTimeString(usageLocale(),{hour:'2-digit',minute:'2-digit',hour12:false})
const details = computed(() => {
  const known = rows.value.filter(row => row.metrics.perMillionTokens != null)
  const tokens = known.reduce((sum,row) => sum+row.totals.totalTokens,0)
  const priced = rows.value.reduce((sum,row) => sum+monitorAutomaticPriceSummary(row.totals).coveredRequests,0)
  return [
    { label:t('desktop.localCost.usageUsd'), value:usdValue.value, currency:'USD' },
    { label:t('desktop.localCost.usageCny'), value:summary.value.valueCny },
    { label:t('desktop.localCost.subscriptionCost'), value:summary.value.accruedCny },
    { label:t('desktop.localCost.confirmedLoss'), value:summary.value.lossesCny },
    { label:t('desktop.localCost.costCredits'), value:summary.value.creditsCny },
    { label:t('costComponents.refunds'), value:summary.value.refundsCny },
    { label:t('desktop.localCost.unitCost'), value:tokens>0?known.reduce((sum,row)=>sum+row.metrics.expenseCny!,0)/tokens*1e6:null },
    { label:t('desktop.localCost.apiCost'), value:summary.value.apiCny },
    { label:t('desktop.localCost.subscriptionAccounts'), text:String(summary.value.subscriptionCount) },
    { label:t('desktop.localCost.purchaseCoverage'), text:summary.value.enteredCount+' / '+summary.value.subscriptionCount },
    { label:t('desktop.localCost.priceCoverage'), text:summary.value.requests?(priced/summary.value.requests*100).toFixed(1)+'%':'—' },
    { label:t('desktop.localCost.active'), text:String(summary.value.activeCount) },
    { label:t('desktop.localCost.banned'), text:String(summary.value.bannedCount) },
    ...(summary.value.unknownStateCount ? [{label:t('usageMonitor.delivery.unknownStates'),text:String(summary.value.unknownStateCount)}] : []),
  ].filter(item=>item.text!=null||item.value!=null)
})
</script>

<template>
  <section v-if="compact" class="monitor-cost-strip" :aria-busy="!!busy" :data-start-ms="data.report.startMs" :data-end-ms="data.report.endMs" :aria-label="t('usageMonitor.costs.overview')">
    <div class="strip-scope"><strong>{{ t('usageMonitor.costs.overview') }}</strong><small>{{ t(scope === 'all' ? 'usageMonitor.delivery.globalScope' : 'usageMonitor.costs.api') }}</small><small><template v-if="data.report.startMs===0">{{ t('usageMonitor.text.all') }}</template><time v-else :datetime="new Date(data.report.startMs).toISOString()">{{ shortDate(data.report.startMs) }}</time> – <time :datetime="new Date(data.report.endMs).toISOString()">{{ shortDate(data.report.endMs-1) }} {{ clock(data.report.endMs-1) }}</time><span v-if="busy"> · {{ t('usageMonitor.text.loading') }}</span></small></div>
    <dl class="strip-values">
      <div><dt>{{ t('desktop.localCost.cashPaid') }}</dt><dd :class="{'is-missing':summary.cashOutlayCny==null}">{{ money(summary.cashOutlayCny) }}</dd></div>
      <div><dt>{{ t('desktop.localCost.recordedCost') }}<small v-if="summary.expenseCny!=null && summary.costIncomplete" :title="t('usageMonitor.delivery.partialCost')"> · {{ t('desktop.localCost.knownPart') }}</small></dt><dd :class="{'is-missing':summary.expenseCny==null}">{{ money(summary.expenseCny) }}</dd></div>
      <div :title="t('desktop.localCost.valuationBasis')"><dt>{{ t('desktop.localCost.value') }} · USD</dt><dd class="strip-usage">{{ usdValue==null?'—':money(usdValue,'USD') }}</dd><small v-if="summary.valueCny != null" class="strip-cny">{{ t('usageMonitor.inlineCosts.cnyEquivalent', { amount: money(summary.valueCny) }) }}</small></div>
      <div :title="t('usageMonitor.fusion.factorBasis')"><dt>{{ t('desktop.localCost.factor') }}</dt><dd>{{ summary.factor==null?'—':summary.factor.toFixed(4)+'×' }}</dd></div>
      <div><dt>{{ t('desktop.localCost.remaining') }}</dt><dd :class="{'is-missing':summary.remainingCny==null}">{{ money(summary.remainingCny) }}</dd></div>
    </dl>
    <div class="strip-actions"><button type="button" @click="emit('accounts')"><Users :size="14" />{{ t('desktop.localCost.accountAssets') }}</button><button type="button" @click="emit('open')"><ReceiptText :size="14" />{{ t('desktop.localCost.records') }}</button><button type="button" @click="emit('channels')"><Wallet :size="14" />{{ t('desktop.localCost.channels') }}</button><button type="button" @click="emit('prices')"><Settings2 :size="14" />{{ t('usageMonitor.delivery.prices') }}</button></div>
  </section>
  <section v-else class="monitor-cost-summary" :aria-busy="!!busy" :aria-label="t('usageMonitor.costs.overview')">
    <header v-if="!hideNavigation">
      <span>{{ t(scope === 'all' ? 'usageMonitor.delivery.globalScope' : 'usageMonitor.costs.api') }}</span>
      <div class="summary-actions">
        <button type="button" :aria-label="t('desktop.localCost.accountAssets')" @click="emit('accounts')"><Users :size="15" />{{ t('desktop.localCost.accountAssets') }}</button>
        <button type="button" :aria-label="t('desktop.localCost.allRecordedUsage')" @click="emit('usage')"><ChartNoAxesColumnIncreasing :size="15" />{{ t('usageMonitor.delivery.usageDetails') }}</button>
        <button type="button" @click="emit('open')"><ReceiptText :size="15" />{{ t('desktop.localCost.records') }}</button>
        <button type="button" @click="emit('channels')"><Wallet :size="15" />{{ t('desktop.localCost.channels') }}</button>
        <button type="button" @click="emit('prices')"><Settings2 :size="15" />{{ t('usageMonitor.delivery.prices') }}</button>
      </div>
    </header>
    <div class="cost-summary-values">
      <div><span>{{ t('desktop.localCost.cashPaid') }}</span><strong :class="{'is-unknown':summary.cashOutlayCny==null}">{{ money(summary.cashOutlayCny) }}</strong><button v-if="summary.cashOutlayCny==null || summary.enteredCount<summary.subscriptionCount" type="button" class="enter-purchase" @click="emit('enter')"><Plus :size="12" />{{ t('desktop.localCost.enterPurchase') }}</button></div>
      <div><span>{{ t('desktop.localCost.recordedCost') }}</span><strong :class="{'is-unknown':summary.expenseCny==null}">{{ money(summary.expenseCny) }}</strong><small v-if="summary.expenseCny!=null && summary.costIncomplete" class="cost-completeness">{{ t('usageMonitor.delivery.partialCost') }}</small></div>
      <div :title="t('usageMonitor.fusion.factorBasis')"><span>{{ t('desktop.localCost.factor') }}</span><strong>{{ summary.factor == null ? '—' : summary.factor.toFixed(4) + '×' }}</strong><small>{{ t('usageMonitor.delivery.matchedFactor',{count:summary.factorAccountCount}) }}</small></div>
      <div :title="t('usageMonitor.delivery.remainingKnown')"><span>{{ t('desktop.localCost.remaining') }}</span><strong :class="{'is-unknown':summary.remainingCny==null}">{{ money(summary.remainingCny) }}</strong></div>
    </div>
    <dl class="cost-summary-details"><div v-for="item in details" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.text??money(item.value,'currency' in item?item.currency:'CNY') }}</dd></div></dl>
    <small><template v-if="data.report.startMs===0">{{ t('usageMonitor.text.all') }}</template><time v-else :datetime="new Date(data.report.startMs).toISOString()">{{ date(data.report.startMs) }}</time> – <time :datetime="new Date(data.report.endMs).toISOString()">{{ date(data.report.endMs) }}</time><span v-if="busy"> · {{ t('usageMonitor.text.updatingPeriodData') }}</span></small>
  </section>
</template>

<style scoped>
.strip-cny{display:block;margin-top:5px;font-size:10px;line-height:1.5;color:var(--cost-muted);font-variant-numeric:tabular-nums}
.monitor-cost-strip{display:flex;align-items:center;gap:18px;padding:12px 0;margin-top:16px;border-block:1px solid var(--cost-line);min-width:0}.strip-scope{flex:0 0 150px;min-width:0}.strip-scope>strong{display:block;font-size:11px;font-weight:500}.strip-scope>small{display:block;margin-top:5px;font-size:10px;color:var(--cost-muted);line-height:1.5}.strip-values{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;flex:1;min-width:0;margin:0}.strip-values>div{min-width:0}.strip-values dt{font-size:11px;color:var(--cost-muted);line-height:1.5}.strip-values dt>small{font-size:10px;color:var(--cost-gold)}.strip-values dd{margin:5px 0 0;font-size:18px;font-weight:550;line-height:1.3;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.strip-values dd.is-missing{font-size:12px;color:var(--cost-muted);font-weight:400}.strip-values .strip-usage{color:var(--cost-gold)}.strip-actions{display:grid;grid-template-columns:repeat(2,max-content);gap:0 12px}.strip-actions button{display:flex;align-items:center;gap:5px;min-height:28px;color:var(--cost-blue);font-size:11px;white-space:nowrap}.strip-actions button:hover{text-decoration:underline}@media(max-width:1250px){.monitor-cost-strip{gap:12px}.strip-scope{flex-basis:126px}.strip-values{gap:10px}.strip-values dd{font-size:16px}}@media(max-width:850px){.monitor-cost-strip{flex-wrap:wrap}.strip-values{flex-basis:calc(100% - 150px)}.strip-actions{display:flex;flex-wrap:wrap;margin-left:138px}}
.summary-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.summary-actions button{min-height:32px;padding:6px 9px;border:1px solid transparent;border-radius:4px;white-space:nowrap}.summary-actions button:hover,.summary-actions button:focus-visible{background:var(--cost-panel);border-color:var(--cost-line-strong)}.summary-actions svg{flex-shrink:0}
.cost-summary-values small{display:block;margin-top:6px;font-size:11px;line-height:1.5;color:var(--cost-muted)}.cost-summary-values .cost-completeness{color:var(--cost-gold)}
.cost-summary-details{display:flex;gap:12px 28px;flex-wrap:wrap;padding:14px 0;margin:0;border-top:1px solid var(--cost-line)}.cost-summary-details>div{display:flex;align-items:baseline;gap:8px;font-size:11px}.cost-summary-details dt{color:var(--cost-muted)}.cost-summary-details dd{margin:0;font-weight:500;font-variant-numeric:tabular-nums}
.monitor-cost-summary{padding:20px 0;border-block:1px solid var(--cost-line);margin:20px 0}.monitor-cost-summary>header{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:12px}.monitor-cost-summary button{display:flex;align-items:center;gap:5px;color:var(--cost-blue);font-size:11px}.cost-summary-values{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;margin:18px 0 12px}.cost-summary-values>div{min-width:0}.cost-summary-values span,.monitor-cost-summary>small,.monitor-cost-summary>p{font-size:11px;line-height:1.6;color:var(--cost-muted)}.cost-summary-values strong{display:block;font-size:26px;font-weight:550;margin-top:8px;overflow-wrap:anywhere}.cost-summary-values .usage-value{color:var(--cost-gold)}.monitor-cost-summary>p{color:var(--cost-gold)}@media(max-width:650px){.cost-summary-values{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
