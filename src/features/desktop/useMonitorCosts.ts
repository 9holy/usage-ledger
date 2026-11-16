import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { getLocalCostReport, LOCAL_FINANCE_SCOPE, saveLocalCostSettings, type LocalCostReport, type LocalCostSettings } from '@/api/localCost'
import { getFinanceLedger, type FinanceSnapshot } from '@/api/financeLedger'
import { localCostMetrics, type LocalCostRow } from './localCostMath'
import i18n from '@/i18n'
import { monitorUpstreamRevision, monitorUpstreamStatus } from '@/api/monitorUpstreams'

export interface MonitorCostSnapshot { report: LocalCostReport; finances: FinanceSnapshot }

export function useMonitorCosts(period: () => { startMs: number | null; endMs: number }, periodKey: Ref<string>, enabled: Ref<boolean>) {
  const data = ref<MonitorCostSnapshot | null>(null), error = ref(''), busy = ref(false), saving = ref(false)
  const upstreamErrors = computed(() => monitorUpstreamStatus.value.errors)
  const visible = ref(document.visibilityState!=='hidden')
  const activity = () => { visible.value=document.visibilityState!=='hidden' }
  const active = computed(()=>enabled.value&&visible.value)
  let sequence = 0, timer: ReturnType<typeof setTimeout> | undefined
  async function reload() {
    clearTimeout(timer)
    if (!active.value) return
    const current = ++sequence, bounds = period(), startMs = bounds.startMs ?? 0, endMs = bounds.endMs
    busy.value = true
    try {
      const [report, finances] = await Promise.all([getLocalCostReport(startMs, endMs), getFinanceLedger({ ...LOCAL_FINANCE_SCOPE, startMs, endMs })])
      if (current === sequence) {
        data.value = { report, finances }; error.value = ''
      }
    } catch (failure) { if (current === sequence) error.value = String(failure instanceof Error ? failure.message : failure) }
    finally { if (current === sequence) { busy.value = false; if (active.value) timer = setTimeout(reload, 60_000) } }
  }
  async function save(settings: LocalCostSettings) {
    saving.value = true
    try { await saveLocalCostSettings(settings); await reload() }
    finally { saving.value = false }
  }
  watch(() => [periodKey.value, active.value], () => {
    sequence++; clearTimeout(timer); busy.value = false
    if (active.value) void reload()
  }, { immediate: true, flush: 'post' })
  watch(monitorUpstreamRevision, () => { if (active.value) void reload() })
  onMounted(()=>document.addEventListener('visibilitychange',activity))
  onBeforeUnmount(() => { sequence++; clearTimeout(timer);document.removeEventListener('visibilitychange',activity) })
  const rows = computed<LocalCostRow[]>(() => {
    if (!data.value) return []
    const { report, finances } = data.value, accounts = report.accounts.slice()
    for (const entry of finances.byAccount) if (!accounts.some(account => account.id === entry.accountId)) accounts.push({
      id: entry.accountId, label: report.accountNames?.[entry.accountId] ?? entry.accountId, tool: '', verifiedRequests: 0, referenceRequests: 0,
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 0, pricedCostUsd: 0, unpricedRequests: 0, incompleteRequests: 0, cacheHitRatio: null, outputTokensPerSecond: 0 },
    })
    const clients:Record<string,string>={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity','deepseek-harness':'DeepSeek Harness'}
    return accounts.map(account => {
      const label=report.accountNames?.[account.id]??account.label.replace(/^Account (?=\d+$)/,i18n.global.t('usageMonitor.text.account')+' ')
      const name=account.id==='api:all'?i18n.global.t('usageMonitor.routes.unattributedApi'):account.id==='unassigned'?i18n.global.t('desktop.localCost.unassigned'):`${clients[account.tool]?clients[account.tool]+' · ':''}${label}`
      return {...account,name,metrics:localCostMetrics(account,report,finances.byAccount)}
    })
  })
  return { data, rows, error, busy, saving, reload, save, upstreamErrors }
}
