<template>
  <form class="finance-batch" :aria-label="t('costComponents.purchaseBatchForm')" @submit.prevent="requestSave">
    <header><h4>{{ initial ? t('costComponents.editPurchaseBatch') : t('costComponents.batchPurchaseRenewal') }}</h4><span>{{ rows.length }} {{ t('costComponents.accountsAllocated') }} {{ allocated.toFixed(2) }} / {{ form.total || '0.00' }} {{ form.currency }}</span></header>
    <p v-if="error" class="finance-error" role="alert">{{ error }}</p>
    <div class="batch-fields">
      <label> {{ t('costComponents.totalBatchPayment') }} <input v-model="form.total" :aria-label="t('costComponents.totalBatchPayment')" type="number" min="0" step="any" required :disabled="saving" /></label>
      <label> {{ t('costComponents.currency') }} <select v-model="form.currency" :aria-label="t('costComponents.batchCurrency')" :disabled="saving"><option>CNY</option><option>USD</option></select></label>
      <label> {{ t('costComponents.occurredAt') }} <input v-model="form.occurredAt" :aria-label="t('costComponents.batchOccurrenceTime')" type="datetime-local" step="0.001" required :disabled="saving" /></label>
      <label> {{ t('costComponents.purchaseChannel') }} <input v-model="form.channel" :aria-label="t('costComponents.batchPurchaseChannel')" :list="`${uid}-channels`" maxlength="512" :disabled="saving" /></label>
      <datalist :id="`${uid}-channels`"><option v-for="channel in channels" :key="channel" :value="channel" /></datalist>
      <label> {{ t('costComponents.plan') }} <input v-model="defaults.plan" :aria-label="t('costComponents.defaultBatchPlan')" maxlength="512" :disabled="saving" /></label>
      <label> {{ t('costComponents.coverageStartm268') }} <input v-model="defaults.start" :aria-label="t('costComponents.defaultBatchCoverageStart')" type="datetime-local" step="0.001" :disabled="saving" /></label>
      <label> {{ t('costComponents.coverageEndm270') }} <input v-model="defaults.end" :aria-label="t('costComponents.defaultBatchCoverageEnd')" type="datetime-local" step="0.001" :disabled="saving" /></label>
      <button type="button" class="finance-button" :disabled="saving || !rows.length" @click="applyDefaults"><Copy :size="14" /> {{ t('costComponents.applyPlanAndCoveragePeriod') }} </button>
    </div>
    <div class="batch-selection">
      <label> {{ t('costComponents.searchAccounts') }} <input v-model="search" :aria-label="t('costComponents.searchBatchAccounts')" type="search" :disabled="saving" /></label>
      <div class="batch-selection-actions"><button type="button" class="finance-button" :disabled="saving || !filtered.length" @click="selectFiltered"><CheckCheck :size="14" /> {{ t('costComponents.selectFilteredAccounts') }} </button><button type="button" class="finance-button" :disabled="saving || !rows.length" @click="selected = []"><X :size="14" /> {{ t('costComponents.clearSelection') }} </button></div>
      <select :aria-label="t('costComponents.batchAccountSelection')" multiple size="6" :disabled="saving" @change="changeSelection"><option v-for="account in filtered" :key="account.id" :value="account.id" :selected="selected.includes(account.id)">{{ account.name }} · {{ account.id }}</option></select>
    </div>
    <div class="batch-actions"><button type="button" class="finance-button" :disabled="saving || !rows.length || !(Number(form.total) > 0)" @click="splitEvenly"><Equal :size="14" /> {{ t('costComponents.splitTotalPaymentEqually') }} </button><span v-if="rows.length && !balanced" class="finance-warning"> {{ t('costComponents.allocatedAmountsMustEqualTheTotalPayment') }} </span></div>
    <div v-if="rows.length" class="finance-table-scroll"><table><thead><tr><th> {{ t('costComponents.account') }} </th><th> {{ t('costComponents.event') }} </th><th> {{ t('costComponents.allocatedAmount') }} </th><th> {{ t('costComponents.plan') }} </th><th> {{ t('costComponents.coverageStartm268') }} </th><th> {{ t('costComponents.coverageEndm270') }} </th><th> {{ t('costComponents.note') }} </th><th></th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.id"><td>{{ accountName(row.accountId) }}</td><td><select v-model="row.kind" :disabled="saving"><option value="purchase"> {{ t('costComponents.purchase') }} </option><option value="renewal"> {{ t('costComponents.renewal') }} </option></select></td><td><input v-model="row.amount" :aria-label="t('costComponents.allocatedAmountm281', { p0: row.accountId })" type="number" min="0" step="any" required :disabled="saving" /></td><td><input v-model="row.plan" maxlength="512" :disabled="saving" /></td><td><input v-model="row.start" type="datetime-local" step="0.001" :disabled="saving" /></td><td><input v-model="row.end" type="datetime-local" step="0.001" :disabled="saving" /></td><td><input v-model="row.note" maxlength="1000" :disabled="saving" /></td><td><button type="button" class="finance-icon" :aria-label="t('costComponents.removeAllocation', { p0: row.accountId })" :title="t('costComponents.removeAllocationm283')" :disabled="saving" @click="selected = selected.filter(id => id !== row.accountId)"><X :size="14" /></button></td></tr>
    </tbody></table></div>
    <footer><button type="button" class="finance-button" :disabled="saving" @click="emit('cancel')"><X :size="14" /> {{ t('costComponents.cancel') }} </button><button type="submit" class="finance-button finance-primary" :disabled="saving || !valid"><Save :size="14" />{{ saving ? t('costComponents.saving') : t('costComponents.saveBatch') }}</button></footer>
    <ConfirmDialog :show="confirmRemoval" :title="t('costComponents.removeOriginalBatchAllocations')" :message="t('costComponents.thisWillVoidOriginalAllocationsAndSave', { p0: removedCount })" :confirm-text="t('costComponents.confirmSave')" danger @confirm="submit" @cancel="confirmRemoval = false" />
  </form>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

import { computed, getCurrentInstance, reactive, ref, watch } from 'vue'
import { CheckCheck, Copy, Equal, Save, X } from '@lucide/vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { saveFinanceBatch, type FinanceBatch, type FinanceCurrency, type FinanceEvent, type FinanceEventInput, type FinanceScope } from '@/api/financeLedger'

const props = defineProps<{ scope: FinanceScope; accounts: Array<{ id: string; name: string }>; channels: string[]; initial?: FinanceBatch | null }>()
const emit = defineEmits<{ saved: []; cancel: []; busy: [value: boolean] }>()
const uid = `finance-batch-${getCurrentInstance()!.uid}`
const localInput = (time: number) => { const date = new Date(time); return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23) }
const initialTime = props.initial?.occurredAtMs ?? Date.now()
const originalTime = localInput(initialTime)
const batchId = props.initial?.batchId ?? crypto.randomUUID()
const form = reactive({ total: props.initial ? String(props.initial.totalAmount) : '', currency: props.initial?.currency ?? 'CNY' as FinanceCurrency, occurredAt: originalTime, channel: props.initial?.purchaseChannel ?? '' })
const defaults = reactive({ plan: '', start: '', end: '' })
interface Row { id: string; accountId: string; kind: 'purchase' | 'renewal'; amount: string; plan: string; start: string; end: string; note: string; original?: FinanceEvent }
const eventRow = (event: FinanceEvent): Row => ({ id: event.id, accountId: event.accountId, kind: event.kind as Row['kind'], amount: String(event.amount), plan: event.planLabel ?? '', start: event.coverageStartMs == null ? '' : localInput(event.coverageStartMs), end: event.coverageEndMs == null ? '' : localInput(event.coverageEndMs), note: event.note ?? '', original: event })
const rows = ref<Row[]>(props.initial?.events.map(eventRow) ?? [])
const selected = ref(rows.value.map(row => row.accountId))
const search = ref('')
const saving = ref(false)
const error = ref('')
const confirmRemoval = ref(false)
const options = computed(() => { const map = new Map(props.accounts.map(account => [account.id, account])); for (const event of props.initial?.events ?? []) if (!map.has(event.accountId)) map.set(event.accountId, { id: event.accountId, name: event.accountId }); return [...map.values()] })
const originalRows = computed(() => new Map((props.initial?.events ?? []).map(event => [event.accountId, event])))
const accountNames = computed(() => new Map(options.value.map(account => [account.id, account.name])))
const filtered = computed(() => { const term = search.value.trim().toLowerCase(); return options.value.filter(account => `${account.name} ${account.id}`.toLowerCase().includes(term)) })
const accountName = (id: string) => accountNames.value.get(id) ?? id
const allocated = computed(() => rows.value.reduce((sum, row) => sum + Number(row.amount), 0))
const balanced = computed(() => Number.isFinite(allocated.value) && Math.abs(allocated.value - Number(form.total)) <= Math.max(0.000001, Number(form.total) * 1e-10))
const occurredAtMs = computed(() => form.occurredAt === originalTime ? initialTime : new Date(form.occurredAt).getTime())
function rowTime(row: Row, field: 'start' | 'end'): number | null {
  const value = row.original?.[field === 'start' ? 'coverageStartMs' : 'coverageEndMs']
  if (value != null && row[field] === localInput(value)) return value
  return row[field] ? new Date(row[field]).getTime() : null
}
const valid = computed(() => rows.value.length > 0 && Number.isFinite(Number(form.total)) && Number(form.total) > 0 && balanced.value && Number.isFinite(occurredAtMs.value) && rows.value.every(row => {
  const start = rowTime(row, 'start'), end = rowTime(row, 'end')
  return Number.isFinite(Number(row.amount)) && Number(row.amount) > 0 && ((!row.start && !row.end) || (start != null && end != null && Number.isFinite(start) && Number.isFinite(end) && end > start))
}))
const removedCount = computed(() => { const ids = new Set(rows.value.map(row => row.id)); return (props.initial?.events ?? []).filter(event => !ids.has(event.id)).length })
watch(selected, ids => {
  const existing = new Map(rows.value.map(row => [row.accountId, row]))
  rows.value = ids.map(accountId => { const old = originalRows.value.get(accountId); return existing.get(accountId) ?? (old ? eventRow(old) : { id: crypto.randomUUID(), accountId, kind: 'purchase', amount: '', plan: defaults.plan, start: defaults.start, end: defaults.end, note: '' }) })
})
function changeSelection(event: Event) {
  const visible = new Set(filtered.value.map(account => account.id))
  const chosen = [...(event.target as HTMLSelectElement).selectedOptions].map(option => option.value)
  const chosenIds = new Set(chosen)
  const kept = selected.value.filter(id => !visible.has(id) || chosenIds.has(id))
  const keptIds = new Set(kept)
  selected.value = [...kept, ...chosen.filter(id => !keptIds.has(id))]
}
function selectFiltered() { selected.value = [...new Set([...selected.value, ...filtered.value.map(account => account.id)])] }
function applyDefaults() { for (const row of rows.value) Object.assign(row, { plan: defaults.plan, start: defaults.start, end: defaults.end }) }
function splitEvenly() {
  const total = Number(form.total)
  const each = Math.floor(total * 100 / rows.value.length) / 100
  rows.value.forEach((row, index) => { row.amount = String(index === rows.value.length - 1 ? Number((total - each * index).toFixed(10)) : each) })
}
function requestSave() { if (valid.value && !saving.value) { if (removedCount.value) confirmRemoval.value = true; else void submit() } }
async function submit() {
  if (!valid.value || saving.value) return
  confirmRemoval.value = false
  saving.value = true; emit('busy', true); error.value = ''
  try {
    const allocations: FinanceEventInput[] = rows.value.map(row => ({ ...props.scope, id: row.id, accountId: row.accountId, kind: row.kind, amount: Number(row.amount), currency: form.currency, occurredAtMs: occurredAtMs.value, coverageStartMs: rowTime(row, 'start'), coverageEndMs: rowTime(row, 'end'), planLabel: row.plan.trim() || null, note: row.note.trim() || null, batchId, batchTotal: Number(form.total), purchaseChannel: form.channel.trim() || null, relatedEventId: null }))
    await saveFinanceBatch({ scope: { ...props.scope }, batchId, totalAmount: Number(form.total), currency: form.currency, occurredAtMs: occurredAtMs.value, purchaseChannel: form.channel.trim() || null, allocations })
    emit('saved')
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure) }
  finally { saving.value = false; emit('busy', false) }
}
</script>

<style scoped>
.finance-batch { margin-block: 14px; padding-block: 14px; border-block: 1px solid var(--cost-line, #303830); }
header, footer, .batch-actions, .batch-selection-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
header { justify-content: space-between; } h4 { margin: 0; font-size: 13px; } header span { color: var(--cost-muted, #8f9b91); font-variant-numeric: tabular-nums; }
.batch-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 10px; margin-block: 12px; align-items: end; }
label { display: flex; flex-direction: column; gap: 6px; color: var(--cost-muted, #8f9b91); min-width: 0; }
.batch-selection { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-block: 12px; align-items: end; }
.batch-selection select { grid-column: 1 / -1; width: 100%; min-height: 110px; } .batch-actions { margin-block: 12px; }
.finance-batch :is(input, select, button) { font: inherit; color: var(--cost-text, #e9ede6); border: 1px solid var(--cost-line-strong, #424d43); border-radius: 4px; background: var(--cost-panel, #171a17); min-width: 0; }
.finance-batch :is(input, select) { padding: 6px 8px; min-height: 32px; } .finance-batch button:disabled { opacity: .45; cursor: default; }
.finance-button, .finance-icon { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 10px; cursor: pointer; } .finance-icon { width: 32px; height: 32px; padding: 0; }
.finance-primary { background: var(--cost-lime, #b9e55a) !important; color: #151912 !important; }
.finance-table-scroll { overflow-x: auto; } table { width: 100%; border-collapse: collapse; text-align: left; } :is(th, td) { padding: 8px; border-bottom: 1px solid var(--cost-line, #303830); } th { color: var(--cost-muted, #8f9b91); font-weight: 500; } td:first-child { min-width: 140px; overflow-wrap: anywhere; } td input { width: 130px; } td input[type=datetime-local] { width: 220px; }
td select { min-width: 72px; white-space: nowrap; }
footer { justify-content: flex-end; margin-top: 12px; } .finance-error { color: #f49a9a; overflow-wrap: anywhere; } .finance-warning { color: var(--cost-gold, #dfbc4c); }
@media (max-width: 600px) { .batch-selection { grid-template-columns: minmax(0, 1fr); } }
</style>
