<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Pencil, Plus, ReceiptText, Search, X } from '@lucide/vue'
import { monitorAmount, monitorAutomaticPriceSummary } from '@/api/usageMonitor'
import { setUsageAccountName } from '@/api/usageAccounts'
import type { LocalCostSettings } from '@/api/localCost'
import type { LocalCostRow } from './localCostMath'
import type { MonitorCostSnapshot } from './useMonitorCosts'
import { usageLocale } from '@/utils/usageFormat'
import { accountApiExpense } from './localCostMath'

const props = defineProps<{ rows: LocalCostRow[]; data: MonitorCostSnapshot; saving: boolean; busy?: boolean; saveSettings: (settings: LocalCostSettings) => Promise<void> }>()
const emit = defineEmits<{ account: [id: string]; record: [id: string, enter: boolean]; changed: []; editing: [value: boolean] }>()
const { t } = useI18n()
const search = ref(''), tool = ref('all'), stateFilter = ref('all'), sort = ref('value')
const nameEditor = ref<{ id: string; value: string } | null>(null)
const status = ref({ id: '', value: 'active' as 'active' | 'inactive' | 'banned' })
const pending = ref(false), error = ref('')
const disabled = computed(() => props.saving || pending.value)
const report = computed(() => props.data.report)
const apiMissing = (id: string) => accountApiExpense(report.value,id)?.missingRequests ?? 0
const tools = computed(() => [...new Set(props.rows.flatMap(row => [...(row.clientTools?.length ? row.clientTools : [row.tool]),...(row.id==='api:all'?['api']:[])]).filter(value => value && value !== 'unknown'))])
const clientName = (value: string) => ({ api: 'API', codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', 'deepseek-harness': 'DeepSeek Harness' }[value] ?? value)
const visibleRows = computed(() => props.rows.filter(row =>
  row.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()) && (tool.value === 'all' || (row.clientTools?.length ? row.clientTools.includes(tool.value) : row.tool === tool.value) || tool.value==='api'&&row.id==='api:all') &&
  (stateFilter.value === 'all' || (!['api:all', 'unassigned'].includes(row.id) && (report.value.settings.accounts[row.id]?.status ?? 'unknown') === stateFilter.value))
).slice().sort((a, b) => {
  const value = (row: LocalCostRow) => sort.value === 'expense' ? row.metrics.expenseCny : sort.value === 'requests' ? row.totals.requestCount : row.metrics.valueCny
  return (value(b) ?? -Infinity) - (value(a) ?? -Infinity)
}))
const money = (value: number | null, currency = 'CNY') => value == null ? t('desktop.localCost.notEntered') : new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 4 }).format(value)
const compact = (value: number) => new Intl.NumberFormat(usageLocale(), { notation: 'compact', maximumFractionDigits: 2 }).format(value)
const usageValue = (totals: LocalCostRow['totals']) => monitorAutomaticPriceSummary(totals).currencies.filter(price => price.identifiedSubtotal != null).map(price => monitorAmount(price.identifiedSubtotal!, price.currency)).join(' / ') || '—'
const date = (value: number) => new Date(value).toLocaleDateString(usageLocale())
async function saveName() {
  if (!nameEditor.value || disabled.value) return
  const { id, value } = nameEditor.value
  pending.value = true; error.value = ''
  try { await setUsageAccountName(id, value); nameEditor.value = null; emit('changed') }
  catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { pending.value = false }
}
async function saveStatus() {
  if (!status.value.id || disabled.value) return
  const { id, value } = status.value
  pending.value = true; error.value = ''
  try {
    await props.saveSettings({ ...report.value.settings, accounts: { ...report.value.settings.accounts, [id]: { status: value, updatedAtMs: Date.now() } } })
    status.value.id = ''
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { pending.value = false }
}
watch(() => !!nameEditor.value || !!status.value.id || pending.value, value => emit('editing', value))
onBeforeUnmount(() => emit('editing', false))
</script>

<template>
  <section id="monitor-account-costs" class="monitor-account-costs" :aria-busy="!!busy" :data-start-ms="report.startMs" :data-end-ms="report.endMs">
        <div class="accounts-heading"><h2>{{ t('desktop.localCost.accountAssets') }} <span>{{ rows.length }}</span></h2><div class="account-filters"><label class="account-search"><Search :size="14" /><input v-model="search" :aria-label="t('desktop.localCost.searchAccounts')" :placeholder="t('desktop.localCost.searchAccounts')" /></label><select v-model="tool" :aria-label="t('desktop.localCost.client')"><option value="all">{{ t('desktop.localCost.allClients') }}</option><option v-for="item in tools" :key="item" :value="item">{{ clientName(item) }}</option></select><select v-model="stateFilter" :aria-label="t('desktop.localCost.accountState')"><option value="all">{{ t('desktop.localCost.allStates') }}</option><option v-for="item in ['active', 'inactive', 'banned', 'unknown']" :key="item" :value="item">{{ t('desktop.localCost.' + item) }}</option></select><select v-model="sort" :aria-label="t('desktop.localCost.sort')"><option value="value">{{ t('desktop.localCost.sortValue') }}</option><option value="expense">{{ t('desktop.localCost.sortExpense') }}</option><option value="requests">{{ t('desktop.localCost.sortRequests') }}</option></select></div></div>
        <p class="account-table-period">{{ report.startMs === 0 ? t('usageMonitor.text.all') : date(report.startMs) }} – {{ date(report.endMs - 1) }}<span v-if="busy"> · {{ t('usageMonitor.text.updatingPeriodData') }}</span></p>
        <p v-if="error" class="cost-error" role="alert">{{ error }}</p>
        <div class="cost-table-scroll monitor-cost-table-scroll"><table class="local-cost-table accounts-table"><thead><tr><th>{{ t('costComponents.account') }}</th><th>{{ t('desktop.localCost.lastPurchase') }}</th><th>{{ t('desktop.localCost.usage') }}</th><th>{{ t('desktop.localCost.value') }}</th><th>{{ t('desktop.localCost.expense') }}</th><th>{{ t('desktop.localCost.factor') }}</th><th>{{ t('desktop.localCost.remaining') }}</th><th>{{ t('costComponents.actions') }}</th></tr></thead>
          <tbody><tr v-for="row in visibleRows" :key="row.id" :data-account-key="row.id">
            <td><div class="account-identity"><span class="account-mark" :class="{ 'api-mark': row.id === 'api:all' }">{{ row.id === 'api:all' ? 'API' : row.tool === 'codex' ? 'CX' : row.tool === 'claude' ? 'CL' : '—' }}</span><div><div class="name-heading"><button type="button" class="account-name-button" :title="t('desktop.localCost.usageAndQuota')" @click="emit('account', row.id)">{{ row.name }}</button><button v-if="row.tool && !['api:all', 'unassigned'].includes(row.id)" class="console-icon-button" :title="t('desktop.localCost.editAccountName')" @click="nameEditor = { id: row.id, value: report?.accountNames?.[row.id] ?? '' }"><Pencil :size="12" /></button></div><span v-if="row.id !== 'api:all' && row.id !== 'unassigned'" class="account-state" :class="report?.settings.accounts[row.id]?.status ?? 'unknown'">{{ t('desktop.localCost.' + (report?.settings.accounts[row.id]?.status ?? 'unknown')) }}</span><small v-else-if="row.id === 'api:all'">{{ t('desktop.localCost.apiCalls') }}</small></div></div><small v-if="row.referenceRequests" class="reference-note" :title="t('desktop.localCost.referenceOwnership', { count: row.referenceRequests })">{{ t('desktop.localCost.referenceAccount') }}</small><small v-if="row.id === 'unassigned' && row.billingCounts" class="reference-note">{{ t('desktop.localCost.unassignedCalls', { subscription: row.billingCounts.subscription ?? 0, unknown: row.billingCounts.unknown ?? 0 }) }}</small>
            <form v-if="nameEditor?.id === row.id" class="name-editor" @submit.prevent="saveName"><input v-model="nameEditor.value" maxlength="128" :placeholder="row.label" :aria-label="t('desktop.localCost.accountName')" :disabled="disabled" /><button class="console-icon-button" :title="t('costComponents.save')" :disabled="disabled"><Check :size="14" /></button><button type="button" class="console-icon-button" :title="t('costComponents.cancel')" @click="nameEditor = null"><X :size="14" /></button></form>
              <form v-if="status.id === row.id" class="status-editor" @submit.prevent="saveStatus"><select v-model="status.value" :aria-label="t('desktop.localCost.accountState')"><option value="active">{{ t('desktop.localCost.active') }}</option><option value="inactive">{{ t('desktop.localCost.inactive') }}</option><option value="banned">{{ t('desktop.localCost.banned') }}</option></select><button class="console-icon-button" :title="t('costComponents.save')" :disabled="disabled"><Check :size="15" /></button><button type="button" class="console-icon-button" :title="t('costComponents.cancel')" @click="status.id = ''"><X :size="14" /></button></form>
            </td>
            <td><span :class="{ 'muted-value': !report?.purchases[row.id] }">{{ report?.purchases[row.id] ? money(report.purchases[row.id].amount, report.purchases[row.id].currency) : t('desktop.localCost.notEntered') }}</span><small v-if="report?.purchases[row.id]?.coverageEndMs">{{ t('desktop.localCost.expires') }} {{ new Date(report.purchases[row.id].coverageEndMs!).toLocaleDateString(usageLocale()) }}</small></td>
            <td v-if="row.totals.requestCount || row.totals.totalTokens">{{ row.totals.requestCount.toLocaleString(usageLocale()) }}<small :title="row.totals.totalTokens.toLocaleString(usageLocale()) + ' Token'">{{ compact(row.totals.totalTokens) }} Token</small></td>
            <td v-else class="muted-value">{{ t(row.referenceRequests ? 'desktop.localCost.referenceAccount' : 'desktop.localCost.noVerifiedPeriodUsage') }}</td>
            <td>{{ usageValue(row.totals) }}<small v-if="row.metrics.valueCny != null" class="usage-cny-value">{{ money(row.metrics.valueCny) }}</small><small v-if="row.metrics.partial && row.metrics.valueCny != null" class="reference-note" :title="t('desktop.localCost.partial')">{{ t('desktop.localCost.knownPart') }}</small></td>
            <td class="expense-cell"><strong :class="{ 'muted-value': row.metrics.expenseCny == null }">{{ row.metrics.expenseCny == null && row.metrics.missingCoverage ? t('desktop.localCost.missingBillingPeriod') : money(row.metrics.expenseCny) }}</strong><small v-if="row.metrics.perMillionTokens != null" :title="t('desktop.localCost.unitCost')">{{ money(row.metrics.perMillionTokens) }} / 1M Token</small><small v-if="apiMissing(row.id) > 0" class="reference-note">{{ t('desktop.localCost.unpricedApi', { count: apiMissing(row.id) }) }}</small></td>
            <td :title="row.metrics.partial ? t('desktop.localCost.referenceFactor') : t('desktop.localCost.formulas')"><span class="factor-value">{{ row.metrics.factor == null ? '—' : row.metrics.factor.toFixed(4) + '×' }}</span></td>
            <td>{{ row.id === 'api:all' ? '—' : money(row.metrics.remainingCny) }}</td>
            <td><div class="row-actions"><button v-if="row.id !== 'unassigned'" class="console-icon-button" :title="t('desktop.localCost.enterForAccount')" :disabled="disabled" @click="emit('record', row.id, true)"><Plus :size="15" /></button><button v-if="row.id !== 'unassigned'" class="console-icon-button" :title="t('desktop.localCost.records')" @click="emit('record', row.id, false)"><ReceiptText :size="15" /></button><button v-if="row.id !== 'unassigned' && row.id !== 'api:all'" class="console-icon-button" :title="t('desktop.localCost.accountState')" :disabled="disabled" @click="status = { id: row.id, value: report?.settings.accounts[row.id]?.status ?? 'active' }"><Pencil :size="14" /></button></div></td>
          </tr><tr v-if="report && !visibleRows.length"><td colspan="8" class="table-empty">{{ t('desktop.localCost.noMatchingAccounts') }}</td></tr></tbody>
        </table></div>
        <footer v-if="report" class="account-count">{{ t('desktop.localCost.showingAccounts', { shown: visibleRows.length, total: rows.length }) }}</footer>
  </section>
</template>

<style scoped>
.monitor-account-costs{display:flow-root;min-width:0}.accounts-heading,.account-filters,.row-actions,.status-editor{display:flex;align-items:center}.monitor-account-costs :is(input,select){font:inherit;max-width:100%;min-width:0;min-height:34px;padding:6px 9px;color:var(--cost-text);background:var(--cost-panel);border:1px solid var(--cost-line);border-radius:4px}.account-table-period{font-size:10px;color:var(--cost-muted);margin:0 0 12px}.cost-error{color:var(--cost-gold);font-size:12px;overflow-wrap:anywhere}
.accounts-heading { justify-content: space-between; gap: 15px; flex-wrap: wrap; margin: 24px 0 12px; }.accounts-heading h2,.prices-heading h2 { font-size: 15px; margin: 0; font-weight: 550; }.accounts-heading h2 > span { margin-left: 7px; color: var(--cost-muted); font-size: 12px; font-weight: 400; }.account-filters { gap: 8px; flex-wrap: wrap; }.account-filters select { font-size: 11px; }.account-search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--cost-line); border-radius: 4px; padding-left: 10px; color: var(--cost-muted); background: var(--cost-panel); }.account-search input { width: 165px; border: 0; background: transparent; font-size: 11px; }
.cost-table-scroll { overflow-x: auto; width: 100%; }.local-cost-table { width: 100%; border-collapse: collapse; font-size: 12px; }.local-cost-table th,.local-cost-table td { text-align: left; padding: 14px 12px; border-bottom: 1px solid var(--cost-line); vertical-align: middle; }.local-cost-table th { font-weight: 400; color: var(--cost-muted); white-space: nowrap; font-size: 10px; background: var(--cost-panel); }.local-cost-table th:first-child,.local-cost-table td:first-child { padding-left: 10px; }.local-cost-table th:nth-last-child(n+2):nth-child(n+2),.local-cost-table td:nth-last-child(n+2):nth-child(n+2) { text-align: right; }.local-cost-table tbody > tr:hover { background: var(--cost-panel); }.local-cost-table td { font-variant-numeric: tabular-nums; white-space: nowrap; }.local-cost-table strong { font-weight: 550; }.local-cost-table small { display: block; font-size: 10px; color: var(--cost-muted); margin-top: 5px; line-height: 1.5; }.local-cost-table .reference-note { color: var(--cost-gold); }.account-identity { display: flex; align-items: center; gap: 9px; min-width: 190px; max-width: 300px; }.account-identity strong { display: block; white-space: normal; overflow-wrap: anywhere; }.account-mark { display: grid; place-items: center; width: 31px; height: 33px; flex: 0 0 31px; border: 1px solid var(--cost-line-strong); border-radius: 4px; color: #bed2c4; font-size: 10px; font-weight: 550; background: var(--cost-panel-2); }.account-mark.api-mark { color: var(--cost-blue); }.account-state { display: inline-flex; align-items: center; gap: 5px; color: var(--cost-muted); font-size: 10px; margin-top: 5px; }.account-state::before { content: ''; display: block; width: 4px; height: 4px; border-radius: 50%; background: currentColor; }.account-state.active { color: var(--cost-lime); }.account-state.banned { color: var(--cost-gold); }.muted-value { color: var(--cost-muted); font-size: 11px; }.expense-cell > strong { color: var(--cost-text); }.expense-cell > .muted-value { color: var(--cost-muted); font-weight: 400; }.factor-value { color: var(--cost-lime); }.row-actions { gap: 4px; justify-content: flex-end; }.row-actions .console-icon-button { width: 28px; height: 30px; flex-basis: 28px; border-color: transparent; background: transparent; }.row-actions .console-icon-button:hover { border-color: var(--cost-line-strong); background: var(--cost-panel-2); }.status-editor { gap: 5px; margin-top: 9px; }.status-editor .console-icon-button { width: 28px; height: 30px; flex-basis: 28px; }.status-editor select { font-size: 11px; }.account-count { text-align: right; color: var(--cost-muted); font-size: 10px; margin-top: 12px; }.local-cost-table .table-empty { text-align: center; padding: 40px; color: var(--cost-muted); }
.account-name-button{font-weight:550;text-align:left;white-space:normal;overflow-wrap:anywhere}.account-name-button:hover{color:var(--cost-lime)}
.name-heading{display:flex;align-items:flex-start;gap:6px}.name-heading>.console-icon-button{width:22px;height:23px;flex-basis:22px;border:0;background:none;opacity:.65}.name-heading>.console-icon-button:hover{opacity:1}.name-editor{display:flex;gap:5px;margin-top:8px;max-width:280px}.name-editor input{width:160px;font-size:11px}.name-editor .console-icon-button{width:28px;height:32px;flex-basis:28px}.account-identity{max-width:340px}
@media(max-width:1100px){.accounts-heading{align-items:flex-start;flex-direction:column}}@media(max-width:650px){.account-filters{width:100%}.account-search{width:100%}.account-search input{width:100%}.account-filters>select{flex:1;max-width:100%}.account-identity{min-width:150px}.local-cost-table th,.local-cost-table td{padding-inline:9px}}
</style>
