<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, ChartNoAxesColumnIncreasing, CircleDollarSign, Info, Plus, ReceiptText, RefreshCw, Settings2, SlidersHorizontal, Wallet } from '@lucide/vue'
import ConsoleWorkspaceHeader from '@/features/desktop/ConsoleWorkspaceHeader.vue'
import LocalCostOverview from '@/features/desktop/LocalCostOverview.vue'
import LocalCostUsagePanel from '@/features/desktop/LocalCostUsagePanel.vue'
import LocalCostChannels from '@/features/desktop/LocalCostChannels.vue'
import UsageCostAccounts from '@/features/desktop/UsageCostAccounts.vue'
import UsageApiPrices from '@/features/desktop/UsageApiPrices.vue'
import CostEventsPanel from '@/features/cost-center/components/CostEventsPanel.vue'
import { getFinanceLedger, type FinanceSnapshot } from '@/api/financeLedger'
import { getLocalCostReport, saveLocalCostSettings, LOCAL_FINANCE_SCOPE, type LocalCostReport, type LocalCostSettings } from '@/api/localCost'
import { localCostMetrics } from '@/features/desktop/localCostMath'
import { useLocalCostLive } from '@/features/desktop/useLocalCostLive'
import { usageChartStyle } from '@/features/desktop/usageChartPalette'
import { getUsageMonitorQuotas, type MonitorQuotaReport } from '@/api/usageMonitor'
import { usageLocale } from '@/utils/usageFormat'
import { isDesktopRuntime } from '@/api/url'
import '@/styles/console-theme.css'

const props = defineProps<{ embedded?: boolean }>()
const { t } = useI18n()
const report = ref<LocalCostReport | null>(null)
const finances = ref<FinanceSnapshot | null>(null)
const busy = ref(false), error = ref(''), saving = ref(false)
const range = ref<'month' | '7d' | '30d' | 'all' | 'custom'>('month')
const dateInput = (time: number) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
const customStart = ref(dateInput(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()))
const customEnd = ref(dateInput(Date.now()))
const endMs = ref(Date.now()), loadedAt = ref<number | null>(null)
const startMs = computed(() => range.value === 'custom' ? new Date(customStart.value + 'T00:00:00').getTime() : range.value === 'all' ? 0 : range.value === 'month' ? new Date(new Date(endMs.value).getFullYear(), new Date(endMs.value).getMonth(), 1).getTime() : endMs.value - (range.value === '7d' ? 7 : 30) * 86400000)
const panel = ref<'accounts' | 'usage' | 'channels' | 'records' | 'prices'>('accounts')
const panels = [{ key: 'accounts', icon: ChartNoAxesColumnIncreasing }, { key: 'usage', icon: Activity }, { key: 'channels', icon: Wallet }, { key: 'records', icon: ReceiptText }, { key: 'prices', icon: SlidersHorizontal }] as const
const usageAccountId = ref('')
const usageSource = ref('all')
const quotaReport = ref<MonitorQuotaReport | null>(null), quotaError = ref('')
const financePanel = ref<InstanceType<typeof CostEventsPanel> | null>(null)
const pricePanel = ref<InstanceType<typeof UsageApiPrices> | null>(null)
const tableEditing = ref(false)
const liveEnabled = computed(() => isDesktopRuntime() && !!report.value && ['accounts', 'usage'].includes(panel.value) && (['all', 'api:all', 'unassigned'].includes(usageAccountId.value) || !!rows.value.find(row => row.id === usageAccountId.value)?.tool))
const { report: liveReport, error: liveError } = useLocalCostLive(usageAccountId, liveEnabled, usageSource)
let sequence = 0
let lastSnapshotAttempt = 0
watch(liveReport, value => {
  if (!value || busy.value || saving.value || tableEditing.value) return
  const active = value.live.windows.some(window => window.observedOutputTokens > 0)
  if (Date.now() - lastSnapshotAttempt >= (active ? 15_000 : 60_000)) void reload()
})

async function reload() {
  if (!isDesktopRuntime()) return
  const current = ++sequence
  const now = Date.now()
  const finish = new Date(customEnd.value + 'T00:00:00'); finish.setDate(finish.getDate() + 1)
  endMs.value = range.value === 'custom' ? Math.min(finish.getTime(), now) : now
  if (!Number.isFinite(startMs.value) || !Number.isFinite(endMs.value) || startMs.value >= endMs.value) { busy.value = false; error.value = t('usageMonitor.costs.invalidDates'); return }
  lastSnapshotAttempt = now; busy.value = true; error.value = ''
  try {
    const quotaRead = getUsageMonitorQuotas().then(value => ({ value, error: '' }), failure => ({ value: quotaReport.value, error: String(failure instanceof Error ? failure.message : failure) }))
    const [usage, money, quota] = await Promise.all([getLocalCostReport(startMs.value, endMs.value), getFinanceLedger({ ...LOCAL_FINANCE_SCOPE, startMs: startMs.value, endMs: endMs.value }), quotaRead])
    if (current !== sequence) return
    report.value = usage; finances.value = money; loadedAt.value = Date.now()
    quotaReport.value = quota.value; quotaError.value = quota.error
    if (!usageAccountId.value || (usageAccountId.value !== 'all' && !rows.value.some(row => row.id === usageAccountId.value))) {
      const recent = rows.value.filter(row => row.analytics?.latestRequestMs != null).sort((a, b) => b.analytics!.latestRequestMs! - a.analytics!.latestRequestMs!)[0]
      usageAccountId.value = usage.currentAccountKey ?? recent?.id ?? 'all'
    }
  } catch (failure) { if (current === sequence) error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { if (current === sequence) busy.value = false }
}

const name = (id: string, label?: string, source?: string) => id === 'api:all' ? 'API' : id === 'unassigned' ? t('desktop.localCost.unassigned') : `${source ? ({ codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' }[source] ?? source) + ' · ' : ''}${(label ?? id).replace(/^Account /, t('usageMonitor.text.account') + ' ')}`
const rows = computed(() => {
  if (!report.value) return []
  const accounts = report.value.accounts.slice()
  for (const entry of finances.value?.byAccount ?? []) {
    if (!accounts.some(account => account.id === entry.accountId)) accounts.push({ id: entry.accountId, label: entry.accountId, tool: '', totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 0, pricedCostUsd: 0, unpricedRequests: 0, incompleteRequests: 0, cacheHitRatio: null, outputTokensPerSecond: 0 }, referenceRequests: 0, verifiedRequests: 0 })
  }
  return accounts.map(account => ({ ...account, name: name(account.id, account.label, account.tool), metrics: localCostMetrics(account, report.value!, finances.value?.byAccount ?? []) }))
})
const accountChoices = computed(() => rows.value.filter(row => row.id !== 'unassigned').map(row => ({ id: row.id, name: row.name })))
async function openSettings() {
  panel.value = 'prices'; await nextTick(); pricePanel.value?.openEditor()
}
function showUsage(id: string) { usageAccountId.value = id; panel.value = 'usage' }
async function showRecords(id = '', enter = false) {
  panel.value = 'records'; await nextTick()
  financePanel.value?.selectAccount(id)
  if (enter) financePanel.value?.openEntry(id)
}
async function saveAccountSettings(settings: LocalCostSettings) {
  saving.value = true
  try { await saveLocalCostSettings(settings); await reload() }
  finally { saving.value = false }
}
onMounted(reload)
</script>

<template>
  <component :is="props.embedded ? 'section' : 'main'" class="console-surface local-cost-view" :class="{ embedded: props.embedded }" :style="usageChartStyle">
    <ConsoleWorkspaceHeader v-if="!props.embedded" />
    <div class="local-cost-content">
      <header class="local-cost-toolbar">
        <div class="workspace-title"><CircleDollarSign :size="24" /><component :is="props.embedded ? 'h2' : 'h1'">{{ t(props.embedded ? 'usageMonitor.costs.title' : 'desktop.localCost.title') }}</component><span>{{ t('desktop.localCost.onDevice') }}</span></div>
        <div class="workspace-controls">
          <select v-model="range" :aria-label="t('desktop.localCost.period')" :disabled="saving" @change="reload"><option value="month">{{ t('desktop.localCost.thisMonth') }}</option><option value="7d">{{ t('usageMonitor.text.last7Days') }}</option><option value="30d">{{ t('usageMonitor.text.last30Days') }}</option><option value="all">{{ t('usageMonitor.text.all') }}</option><option value="custom">{{ t('usageMonitor.costs.customDates') }}</option></select>
          <template v-if="range === 'custom'"><input v-model="customStart" type="date" :max="customEnd" :aria-label="t('usageMonitor.costs.fromDate')" :disabled="saving" @change="reload" /><span>–</span><input v-model="customEnd" type="date" :min="customStart" :max="dateInput(Date.now())" :aria-label="t('usageMonitor.costs.toDate')" :disabled="saving" @change="reload" /></template>
          <button class="console-icon-button" :title="t('usageMonitor.text.refreshData')" :disabled="busy || saving" @click="reload"><RefreshCw :size="16" :class="{ refreshing: busy }" /></button>
          <button class="console-icon-button" :title="t('desktop.localCost.prices')" :disabled="!report || saving" @click="openSettings"><Settings2 :size="16" /></button>
          <button class="local-command primary-command" :disabled="!report || saving" @click="showRecords('', true)"><Plus :size="16" />{{ t('desktop.localCost.enterPurchase') }}</button>
        </div>
      </header>
      <div class="workspace-meta"><span v-if="report" data-testid="loaded-period">{{ report.startMs === 0 ? t('usageMonitor.text.all') : new Date(report.startMs).toLocaleDateString(usageLocale()) }} – {{ new Date(report.endMs - 1).toLocaleDateString(usageLocale()) }}<span class="update-time">{{ t('desktop.localCost.updated', { time: new Date(loadedAt!).toLocaleTimeString(usageLocale()) }) }}</span></span><span v-else>{{ t('desktop.localCost.independent') }}</span><button class="formula-info" :title="t('desktop.localCost.formulas')" :aria-label="t('desktop.localCost.formulas')"><Info :size="14" /></button></div>
      <p v-if="!isDesktopRuntime()" role="status" class="workspace-message">{{ t('desktop.localCost.desktopRequired') }}</p>
      <p v-if="error" class="cost-error" role="alert">{{ error }}<template v-if="report"> · {{ t('desktop.localCost.retained') }}</template></p>
      <nav class="local-tabs" :aria-label="t('desktop.localCost.title')" role="tablist"><button v-for="item in panels" :id="'tab-' + item.key" :key="item.key" type="button" role="tab" :aria-selected="panel === item.key" :aria-controls="'panel-' + item.key" :class="{ selected: panel === item.key }" @click="panel = item.key"><component :is="item.icon" :size="16" />{{ t('desktop.localCost.' + (item.key === 'prices' ? 'priceTab' : item.key === 'usage' ? 'usageTab' : item.key)) }}</button></nav>
      <div v-if="busy && !report" class="workspace-skeleton" role="status" :aria-label="t('desktop.localCost.loading')"><span /><span /><span /></div>

      <section v-show="panel === 'accounts'" id="panel-accounts" role="tabpanel" aria-labelledby="tab-accounts">
        <LocalCostOverview v-if="report" :rows="rows" :report="report" :finances="finances?.byAccount ?? []" @enter="showRecords('', true)" @account="showUsage"><LocalCostUsagePanel v-model="usageAccountId" v-model:source="usageSource" :report="report" :rows="rows" :quotas="quotaReport?.quotas ?? []" :quota-error="quotaError" :live="liveReport" :live-error="liveError" summary-only /></LocalCostOverview>
        <UsageCostAccounts v-if="report && finances" :rows="rows" :data="{ report, finances }" :busy="busy" :saving="saving" :save-settings="saveAccountSettings" @account="showUsage" @record="showRecords" @changed="reload" @editing="tableEditing=$event" />
      </section>

      <section v-show="panel === 'usage'" id="panel-usage" role="tabpanel" aria-labelledby="tab-usage"><LocalCostUsagePanel v-if="panel === 'usage' && report" v-model="usageAccountId" v-model:source="usageSource" :report="report" :rows="rows" :quotas="quotaReport?.quotas ?? []" :quota-error="quotaError" :live="liveReport" :live-error="liveError" /></section>
      <section v-show="panel === 'channels'" id="panel-channels" role="tabpanel" aria-labelledby="tab-channels"><LocalCostChannels v-if="panel === 'channels' && report" :snapshot="finances" :start-ms="report.startMs" :end-ms="report.endMs" :accounts="accountChoices" @enter="showRecords('', true)" /></section>
      <section v-show="panel === 'records'" id="panel-records" role="tabpanel" aria-labelledby="tab-records"><CostEventsPanel v-if="report" ref="financePanel" v-bind="LOCAL_FINANCE_SCOPE" :start-ms="report.startMs" :end-ms="report.endMs" :accounts="accountChoices" restrict-accounts @changed="reload" /></section>

      <section v-show="panel === 'prices'" id="panel-prices" role="tabpanel" aria-labelledby="tab-prices"><UsageApiPrices v-if="report" ref="pricePanel" :settings="report.settings" :saving="saving" :save-settings="saveAccountSettings" /></section>
    </div>
  </component>
</template>

<style scoped>
.local-cost-view.embedded{min-height:0}.embedded .local-cost-content{max-width:none;padding:24px 0 0}.workspace-title h2{font-size:20px;font-weight:600;margin:0;line-height:1.4}.workspace-controls{flex-wrap:wrap}.workspace-controls>input[type=date]{width:145px}
.local-cost-view { min-height: 100vh; }.local-cost-content { max-width: 1660px; padding: 24px 30px 36px; margin: auto; }
.local-cost-toolbar,.workspace-title,.workspace-controls,.workspace-meta,.local-tabs,.account-filters,.accounts-heading,.row-actions,.status-editor,.prices-heading,.price-editor > header,.price-editor > footer { display: flex; align-items: center; }
.local-cost-toolbar { justify-content: space-between; gap: 20px; flex-wrap: wrap; }.workspace-title { gap: 10px; min-width: 0; }.workspace-title > svg { color: var(--cost-lime); }.workspace-title h1 { font-size: 23px; font-weight: 600; margin: 0; line-height: 1.4; }.workspace-title > span { color: var(--cost-muted); font-size: 11px; margin-left: 8px; border-left: 1px solid var(--cost-line-strong); padding-left: 15px; }.workspace-controls { gap: 8px; }.workspace-controls > select { width: 136px; }
.local-cost-content :is(input,select) { font: inherit; max-width: 100%; min-width: 0; min-height: 34px; padding: 6px 9px; color: var(--cost-text); background: var(--cost-panel); border: 1px solid var(--cost-line); border-radius: 4px; }.local-command { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; border: 1px solid var(--cost-line-strong); background: var(--cost-panel); color: var(--cost-text); border-radius: 4px; padding: 7px 12px; font-size: 12px; }.local-command:hover:not(:disabled) { background: var(--cost-panel-2); }.primary-command { background: var(--cost-lime); color: #151912; border-color: var(--cost-lime); font-weight: 550; }.primary-command:hover:not(:disabled) { background: #caeb87; }.workspace-meta { gap: 10px; min-height: 36px; color: var(--cost-muted); font-size: 10px; }.update-time { margin-left: 14px; }.formula-info { display: inline-flex; color: var(--cost-muted); }.workspace-message,.cost-error { padding: 10px 12px; margin: 8px 0; font-size: 12px; border-left: 2px solid var(--cost-gold); background: var(--cost-panel); }.cost-error { color: var(--cost-gold); overflow-wrap: anywhere; }
.local-tabs { border-bottom: 1px solid var(--cost-line); gap: 28px; margin-top: 6px; }.local-tabs > button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 43px; padding: 0 1px; border-bottom: 2px solid transparent; color: var(--cost-muted); font-size: 12px; white-space: nowrap; }.local-tabs > button:hover { color: var(--cost-text); }.local-tabs > .selected { color: var(--cost-lime); border-color: var(--cost-lime); }
.workspace-skeleton { display: grid; grid-template-columns: 1.3fr 1fr .7fr; gap: 30px; margin: 25px 0; }.workspace-skeleton span { height: 95px; background: var(--cost-panel); border-radius: 4px; }.refreshing { animation: refresh-spin 1s linear infinite; }@keyframes refresh-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .refreshing { animation: none; } }
@media(max-width:650px){.local-cost-content .local-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 8px}.local-tabs>button{white-space:normal;min-width:0;justify-content:flex-start;text-align:left}.local-tabs>button>svg{flex-shrink:0}}
@media (max-width: 1100px) { .local-cost-content { padding-inline: 22px; }.accounts-heading { align-items: flex-start; flex-direction: column; }.price-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 650px) { .local-cost-content { padding: 18px 14px 28px; }.workspace-title > span { display: none; }.workspace-controls { width: 100%; }.workspace-controls > select { flex: 1; }.local-tabs { gap: 18px; }.local-tabs > button { font-size: 11px; }.account-filters { width: 100%; }.account-search { width: 100%; }.account-search input { width: 100%; }.account-filters > select { flex: 1; max-width: 100%; }.price-fields { grid-template-columns: 1fr; }.price-editor > footer { align-items: flex-start; flex-direction: column; }.workspace-meta { line-height: 1.7; }.update-time { display: inline-block; }.account-identity { min-width: 150px; }.local-cost-table th,.local-cost-table td { padding-inline: 9px; } }
</style>
