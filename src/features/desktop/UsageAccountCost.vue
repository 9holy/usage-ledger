<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Pencil, Plus, ReceiptText, ChartNoAxesColumnIncreasing, Settings2, X } from '@lucide/vue'
import { setUsageAccountName } from '@/api/usageAccounts'
import { monitorAutomaticPriceSummary } from '@/api/usageMonitor'
import type { LocalCostSettings } from '@/api/localCost'
import type { LocalCostRow } from './localCostMath'
import type { MonitorCostSnapshot } from './useMonitorCosts'
import { usageLocale } from '@/utils/usageFormat'
import { accountApiExpense } from './localCostMath'

const props = defineProps<{ row: LocalCostRow; data: MonitorCostSnapshot; saving: boolean; hideInspector?: boolean; compact?: boolean; saveSettings: (settings: LocalCostSettings) => Promise<void> }>()
const emit = defineEmits<{ record: [id: string, enter: boolean]; inspect: [id: string]; changed: []; prices: [] }>()
const { t } = useI18n()
const editing = ref(false), name = ref(''), state = ref('active'), busy = ref(false), error = ref('')
const purchase = computed(() => props.data.report.purchases[props.row.id])
const apiMissing = computed(() => accountApiExpense(props.data.report,props.row.id)?.missingRequests ?? 0)
const accountState = computed<'active'|'inactive'|'banned'|'unknown'>(() => props.data.report.settings.accounts[props.row.id]?.status ?? 'unknown')
const value = computed(() => monitorAutomaticPriceSummary(props.row.totals).currencies.filter(row => row.identifiedSubtotal != null).map(row => money(row.identifiedSubtotal,row.currency)).join(' / ') || '—')
const money = (value: number | null | undefined, currency='CNY') => value == null ? t('desktop.localCost.notEntered') : new Intl.NumberFormat(usageLocale(),{style:'currency',currency,maximumFractionDigits:4}).format(value)
const expense = computed(() => props.row.metrics.expenseCny == null && props.row.metrics.missingCoverage
  ? t('desktop.localCost.missingBillingPeriod') : money(props.row.metrics.expenseCny))
const date = (value?: number | null) => value == null ? '—' : new Date(value).toLocaleDateString(usageLocale())
function edit(){name.value=props.data.report.accountNames?.[props.row.id]??props.row.label;state.value=accountState.value;editing.value=true;error.value=''}
async function save(){
  busy.value=true;error.value=''
  try{
    if(name.value!==(props.data.report.accountNames?.[props.row.id]??props.row.label)) await setUsageAccountName(props.row.id,name.value)
    if(state.value!==accountState.value) await props.saveSettings({...props.data.report.settings,accounts:{...props.data.report.settings.accounts,[props.row.id]:{status:state.value as 'active'|'inactive'|'banned',updatedAtMs:Date.now()}}})
    editing.value=false;emit('changed')
  }catch(failure){error.value=String(failure instanceof Error?failure.message:failure)}finally{busy.value=false}
}
</script>

<template>
  <section v-if="compact" class="account-cost-inline" :data-account-key="row.id" :data-start-ms="data.report.startMs" :data-end-ms="data.report.endMs" :aria-label="t('usageMonitor.fusion.accountCosts')">
    <header><span>{{ row.name }} · {{ data.report.startMs===0?t('usageMonitor.text.all'):date(data.report.startMs) }} – {{ date(data.report.endMs-1) }}</span><button type="button" @click="emit('inspect',row.id)">{{ t('usageMonitor.flow.accountDetails') }}<ChartNoAxesColumnIncreasing :size="13" /></button></header>
    <dl><div><dt>{{ t('desktop.localCost.expense') }}</dt><dd>{{ expense }}<small v-if="row.metrics.expenseCny!=null && apiMissing > 0">{{ t('desktop.localCost.knownPart') }}</small><small v-if="purchase">{{ t('desktop.localCost.lastPaid', { amount: money(purchase.amount, purchase.currency) }) }}</small></dd></div><div :title="t('desktop.localCost.referenceFactor')"><dt>{{ t('desktop.localCost.factor') }}</dt><dd>{{ row.metrics.factor==null?'—':row.metrics.factor.toFixed(4)+'×' }}</dd></div><div class="inline-cost-action"><button v-if="row.id==='api:all'" type="button" @click="emit('prices')"><Settings2 :size="14" />{{ t('usageMonitor.delivery.prices') }}</button><button v-else-if="purchase" type="button" @click="emit('record',row.id,false)"><ReceiptText :size="14" />{{ t('desktop.localCost.records') }}</button><button v-else type="button" @click="emit('record',row.id,true)"><Plus :size="14" />{{ t('desktop.localCost.enterPurchase') }}</button></div></dl>
  </section>
  <section v-else class="account-cost" :data-account-key="row.id" :data-start-ms="data.report.startMs" :data-end-ms="data.report.endMs" :aria-label="t('usageMonitor.fusion.accountCosts')">
    <header><h3>{{ t('usageMonitor.fusion.accountCosts') }}</h3><div><button v-if="row.id!=='api:all' && row.tool" type="button" class="console-icon-button" :title="t('desktop.localCost.editAccountName')" :disabled="saving || busy" @click="edit"><Pencil :size="14" /></button><button type="button" class="console-icon-button" :title="t('desktop.localCost.enterForAccount')" @click="emit('record',row.id,true)"><Plus :size="14" /></button><button type="button" class="console-icon-button" :title="t('desktop.localCost.records')" @click="emit('record',row.id,false)"><ReceiptText :size="14" /></button><button v-if="!hideInspector" type="button" class="console-icon-button" :title="t('usageMonitor.fusion.accountDetails')" @click="emit('inspect',row.id)"><ChartNoAxesColumnIncreasing :size="14" /></button></div></header>
    <div class="account-cost-context"><strong>{{ row.name }}</strong><span v-if="row.id!=='api:all'" :data-state="accountState">{{ t('desktop.localCost.'+accountState) }}</span></div>
    <small v-if="row.referenceRequests" :title="t('desktop.localCost.referenceOwnership',{count:row.referenceRequests})">{{ t('desktop.localCost.referenceAccount') }}</small>
    <form v-if="editing" class="account-cost-editor" @submit.prevent="save"><input v-model="name" maxlength="128" :aria-label="t('desktop.localCost.accountName')" :disabled="busy || saving" /><select v-model="state" :aria-label="t('desktop.localCost.accountState')" :disabled="busy || saving"><option v-if="accountState==='unknown'" value="unknown" disabled>{{ t('desktop.localCost.unknown') }}</option><option v-for="status in ['active','inactive','banned']" :key="status" :value="status">{{ t('desktop.localCost.'+status) }}</option></select><button class="console-icon-button" :disabled="busy || saving" :title="t('costComponents.save')"><Check :size="14" /></button><button type="button" class="console-icon-button" :title="t('costComponents.cancel')" :disabled="busy || saving" @click="editing=false"><X :size="14" /></button></form>
    <p v-if="error" class="account-cost-error" role="alert">{{ error }}</p>
    <dl class="account-cost-figures"><div><dt>{{ t('usageMonitor.fusion.periodUsageUsd') }}</dt><dd class="account-usage-value">{{ value }}</dd></div><div><dt>{{ t('desktop.localCost.expense') }}</dt><dd>{{ expense }}</dd><small v-if="apiMissing > 0" class="account-cost-missing">{{ t('desktop.localCost.unpricedApi',{count:apiMissing}) }}<button type="button" @click="emit('prices')"><Settings2 :size="13" />{{ t('usageMonitor.delivery.prices') }}</button></small></div><div><dt>{{ t('desktop.localCost.factor') }}</dt><dd>{{ row.metrics.factor==null?'—':row.metrics.factor.toFixed(4)+'×' }}</dd></div><div v-if="row.id!=='api:all'"><dt>{{ t('desktop.localCost.remaining') }}</dt><dd>{{ money(row.metrics.remainingCny) }}</dd></div></dl>
    <dl v-if="row.id!=='api:all'" class="account-purchase-facts"><div><dt>{{ t('desktop.localCost.lastPurchase') }}</dt><dd>{{ money(purchase?.amount,purchase?.currency) }}</dd></div><div><dt>{{ t('desktop.localCost.expires') }}</dt><dd>{{ date(purchase?.coverageEndMs??row.periods?.subscription.endMs) }}</dd></div></dl>
    <small class="account-cost-period">{{ data.report.startMs===0?t('usageMonitor.text.all'):date(data.report.startMs) }} – {{ date(data.report.endMs-1) }}<template v-if="row.metrics.partial"> · {{ t('desktop.localCost.knownPart') }}</template></small>
  </section>
</template>

<style scoped>
.account-cost-inline{padding:10px 0;margin-top:12px;border-top:1px solid var(--cost-line);min-width:0}.account-cost-inline>header{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:10px;color:var(--cost-muted)}.account-cost-inline button{display:inline-flex;align-items:center;gap:5px;min-height:28px;font-size:11px;color:var(--cost-blue)}.account-cost-inline dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(70px,.6fr) auto;align-items:end;gap:12px;margin:6px 0 0}.account-cost-inline dt{font-size:11px;color:var(--cost-muted)}.account-cost-inline dd{margin:5px 0 0;font-size:16px;font-weight:500;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.account-cost-inline dd small{display:block;font-size:10px;font-weight:400;color:var(--cost-gold)}.inline-cost-action{text-align:right}
.account-cost-missing{display:block;margin-top:7px;font-size:11px;color:var(--cost-gold)}.account-cost-missing button{display:flex;align-items:center;gap:5px;min-height:28px;color:var(--cost-blue)}
.account-cost{padding:20px 0 0;margin-top:18px;border-top:1px solid var(--cost-line)}.account-cost>header,.account-cost>header>div,.account-cost-context,.account-cost-editor{display:flex;align-items:center;gap:8px}.account-cost>header{justify-content:space-between}.account-cost h3{font-size:14px;font-weight:550;margin:0}.account-cost-context{justify-content:space-between;margin:14px 0 18px;min-width:0}.account-cost-context strong{font-size:12px;overflow-wrap:anywhere}.account-cost-context>span{font-size:10px;color:var(--cost-muted);white-space:nowrap}.account-cost-context [data-state=active]{color:var(--cost-lime)}.account-cost-context [data-state=banned],.account-cost-error{color:var(--cost-gold)}.account-cost-figures{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 24px}.account-cost-figures dt,.account-purchase-facts dt{font-size:11px;color:var(--cost-muted)}.account-cost-figures dd{margin:8px 0 0;font-size:22px;line-height:1.4;font-weight:550;overflow-wrap:anywhere}.account-usage-value{color:var(--cost-gold)}.account-purchase-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;border-top:1px solid var(--cost-line);padding-top:16px;margin-top:18px}.account-purchase-facts dd{font-size:13px;margin:8px 0}.account-cost-period{display:block;font-size:10px;color:var(--cost-muted);margin-top:12px}.account-cost-editor{flex-wrap:wrap;margin-bottom:16px}.account-cost-editor input{width:160px;min-width:0}.account-cost-editor :is(input,select){color:var(--cost-text);background:var(--cost-panel);border:1px solid var(--cost-line);border-radius:4px;font:inherit;font-size:11px;padding:7px}.account-cost-error{font-size:11px;overflow-wrap:anywhere}
</style>
