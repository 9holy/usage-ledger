<template>
  <section class="finance-events" :aria-label="t('costComponents.enteredFinancialEvents')">
    <header class="finance-toolbar">
      <h3> {{ t('costComponents.financialEvents') }} </h3>
      <select v-model="accountFilter" :aria-label="t('costComponents.filterFinancialAccounts')" :disabled="loading || saving">
        <option value=""> {{ t('costComponents.allAccounts') }} </option>
        <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}</option>
      </select>
      <select v-model="channelFilter" :aria-label="t('costComponents.filterPurchaseChannels')" :disabled="loading || saving"><option value=""> {{ t('costComponents.allPurchaseChannels') }} </option><option v-for="channel in snapshot?.purchaseChannels ?? []" :key="channel" :value="channel">{{ channel }}</option></select>
      <select v-model="planFilter" :aria-label="t('costComponents.filterPlans')" :disabled="loading || saving"><option value=""> {{ t('costComponents.allPlans') }} </option><option v-for="plan in snapshot?.planLabels ?? []" :key="plan" :value="plan">{{ plan }}</option></select>
      <select v-model="listMode" :aria-label="t('costComponents.financialListScope')" :disabled="loading || saving"><option value="current"> {{ t('costComponents.currentWindow') }} </option><option value="all"> {{ t('costComponents.allHistory') }} </option></select>
      <button type="button" class="finance-icon" :title="t('costComponents.refreshFinancialEvents')" :aria-label="t('costComponents.refreshFinancialEvents')" :disabled="loading || saving" @click="reload"><RefreshCw :size="15" /></button>
      <button type="button" class="finance-button finance-primary" :disabled="saving" @click="openEditor()"><Plus :size="15" /> {{ t('costComponents.enterEvent') }} </button>
      <button type="button" class="finance-button" :disabled="saving" @click="openBatch()"><ListPlus :size="15" /> {{ t('costComponents.batchPurchase') }} </button>
    </header>

    <p v-if="error" class="finance-error" role="alert">{{ error }}</p>
    <p class="finance-status"> {{ t('costComponents.summaryPeriod') }} {{ when(startMs) }} {{ t('costComponents.to') }} {{ when(endMs) }} {{ t('costComponents.eventsOutsideThisWindowRemainInAll') }} </p>
    <p v-if="loading" class="finance-status" role="status"> {{ t('costComponents.loadingFinancialEvents') }} </p>
    <div v-else-if="snapshot" class="finance-summary">
      <p v-if="!snapshot.summary.hasEnteredFacts" class="finance-status"> {{ t('costComponents.noValidFinancialFactsWereEnteredBy') }} </p>
      <div v-for="item in snapshot.summary.currencies" :key="item.currency" class="finance-summary-row">
        <strong>{{ item.currency }}</strong>
        <span> {{ t('costComponents.cashOutlay') }} <b>{{ money(item.cashOutlay, item.currency) }}</b></span>
        <span> {{ t('costComponents.refunds') }} <b>{{ money(item.refunds, item.currency) }}</b></span>
        <span> {{ t('costComponents.accruedExpense') }} <b>{{ money(item.accruedExpense, item.currency) }}</b></span>
        <span> {{ t('costComponents.recognizedTerminationLoss') }} <b>{{ money(item.recognizedLoss, item.currency) }}</b></span>
        <span> {{ t('costComponents.expenseCredits') }} <b>{{ money(item.expenseCredits, item.currency) }}</b></span>
        <span> {{ t('costComponents.netExpense') }} <b>{{ item.netExpense == null ? t('costComponents.allocationIncomplete') : money(item.netExpense, item.currency) }}</b></span>
        <span> {{ t('costComponents.remainingPrepaid') }} <b>{{ item.remainingPrepaid == null ? t('costComponents.allocationIncomplete') : money(item.remainingPrepaid, item.currency) }}</b></span>
        <small v-if="item.unresolvedCount">{{ item.unresolvedCount }} {{ t('costComponents.factsHaveUnresolvedExpenseAllocation') }} </small>
        <small v-if="item.missingCoverageCount">{{ item.missingCoverageCount }} {{ t('costComponents.outlaysLackACoveragePeriod') }} </small>
      </div>
      <p v-if="snapshot.summary.unresolvedTerminationCount" class="finance-warning"> {{ t('costComponents.terminationLossIsNotLinkedToA') }} </p>
    </div>

    <FinanceBatchEditor v-if="batchOpen" :key="batchInitial?.batchId ?? 'new'" :scope="{ source, instanceId }" :accounts="accounts" :channels="snapshot?.purchaseChannels ?? []" :initial="batchInitial" @cancel="batchOpen = false" @saved="batchSaved" @busy="saving = $event" />

    <form v-if="editing" class="finance-form" :aria-label="t('costComponents.financialEventForm')" @submit.prevent="submit">
      <label> {{ t('costComponents.account') }} <input v-model="form.accountId" :list="optionsId" :disabled="!!form.id || saving" required maxlength="512" /></label>
      <datalist :id="optionsId"><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}</option></datalist>
      <label> {{ t('costComponents.event') }} <select v-model="form.kind" :disabled="saving"><option v-for="(label, kind) in kindLabels" :key="kind" :value="kind">{{ label }}</option></select></label>
      <label> {{ t('costComponents.amount') }} <input v-model="form.amount" type="number" min="0" step="any" inputmode="decimal" :disabled="saving" required /></label>
      <label> {{ t('costComponents.currency') }} <select v-model="form.currency" :disabled="saving"><option value="CNY">CNY</option><option value="USD">USD</option></select></label>
      <label> {{ t('costComponents.occurredAt') }} <input v-model="form.occurredAt" type="datetime-local" step="0.001" :disabled="saving" required /></label>
      <template v-if="isPurchase">
        <label> {{ t('costComponents.coverageStart') }} <input v-model="form.coverageStart" type="datetime-local" step="0.001" :disabled="saving" /></label>
        <label> {{ t('costComponents.coverageEnd') }} <input v-model="form.coverageEnd" type="datetime-local" step="0.001" :disabled="saving" /></label>
        <label> {{ t('costComponents.purchaseChannel') }} <input v-model="form.purchaseChannel" :list="`${optionsId}-channels`" maxlength="512" :disabled="saving" /></label>
        <datalist :id="`${optionsId}-channels`"><option v-for="channel in snapshot?.purchaseChannels ?? []" :key="channel" :value="channel" /></datalist>
        <label> {{ t('costComponents.plan') }} <input v-model="form.planLabel" maxlength="512" :disabled="saving" /></label>
      </template>
      <label v-else> {{ t('costComponents.relatedOriginalEvent') }} <select v-model="form.relatedEventId" :aria-label="t('costComponents.relatedOriginalEvent')" :disabled="saving || relatedLoading"><option value=""> {{ t('costComponents.unlinkedIncomplete') }} </option><option v-for="event in relatedOptions" :key="event.id" :value="event.id">{{ when(event.occurredAtMs) }} · {{ kindLabels[event.kind] }} · {{ event.amount }} {{ event.currency }} · {{ event.planLabel || event.id.slice(-8) }}</option></select></label>
      <p v-if="relatedError" class="finance-warning">{{ relatedError }}</p>
      <label class="finance-note"> {{ t('costComponents.note') }} <input v-model="form.note" maxlength="1000" :disabled="saving" /></label>
      <div class="finance-form-actions">
        <button type="button" class="finance-button" :disabled="saving" @click="editing = false"><X :size="15" /> {{ t('costComponents.cancel') }} </button>
        <button type="submit" class="finance-button finance-primary" :disabled="saving || !validForm"><Save :size="15" />{{ saving ? t('costComponents.saving') : t('costComponents.save') }}</button>
      </div>
    </form>

    <div v-if="snapshot?.events.length" class="finance-table-scroll">
      <table>
        <thead><tr><th> {{ t('costComponents.occurredAt') }} </th><th> {{ t('costComponents.account') }} </th><th> {{ t('costComponents.event') }} </th><th> {{ t('costComponents.amount') }} </th><th> {{ t('costComponents.channelPlan') }} </th><th> {{ t('costComponents.coveragePeriod') }} </th><th> {{ t('costComponents.relationBatch') }} </th><th> {{ t('costComponents.note') }} </th><th> {{ t('costComponents.status') }} </th><th> {{ t('costComponents.actions') }} </th></tr></thead>
        <tbody>
          <tr v-for="event in snapshot.events" :key="event.id" :class="{ 'finance-voided': event.voidedAtMs != null }">
            <td>{{ when(event.occurredAtMs) }}</td><td>{{ accountName(event.accountId) }}</td><td>{{ kindLabels[event.kind] }}</td>
            <td class="finance-amount">{{ event.currency }} {{ money(event.amount, event.currency) }}</td>
            <td>{{ event.purchaseChannel || '-' }} / {{ event.planLabel || '-' }}</td>
            <td>{{ event.coverageStartMs != null && event.coverageEndMs != null ? `${when(event.coverageStartMs)} - ${when(event.coverageEndMs)}` : t('costComponents.notEntered') }}</td>
            <td class="finance-row-reference">{{ event.relatedEventId ? t('costComponents.related', { p0: event.relatedEventId.slice(-8) }) : event.batchId ? t('costComponents.batch', { p0: event.batchId.slice(-8) }) : (event.kind === 'refund' || event.kind === 'termination_loss') ? t('costComponents.unlinked') : '-' }}</td>
            <td class="finance-row-note">{{ event.note || '-' }}</td><td>{{ event.voidedAtMs == null ? t('costComponents.valid') : t('costComponents.voided') }}</td>
            <td><div class="finance-row-actions">
              <button type="button" class="finance-icon" :title="t('costComponents.editFinancialEvent')" :aria-label="t('costComponents.editFinancialEvent')" :disabled="saving || event.voidedAtMs != null" @click="openEditor(event)"><Pencil :size="14" /></button>
              <button type="button" class="finance-icon" :title="t('costComponents.voidFinancialEvent')" :aria-label="t('costComponents.voidFinancialEvent')" :disabled="saving || event.voidedAtMs != null" @click="pendingVoid = event"><Ban :size="14" /></button>
            </div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="snapshot && !loading && !error" class="finance-status"> {{ t('costComponents.noEnteredEventsOrCoveragePeriodsMatch') }} </p>
    <footer v-if="snapshot" class="finance-pagination"><span> {{ t('costComponents.total') }} {{ snapshot.totalEvents }} {{ t('costComponents.entriesPerPage') }} </span><button type="button" class="finance-icon" :title="t('costComponents.previousPage')" :aria-label="t('costComponents.previousFinancialEventsPage')" :disabled="loading || saving || offset === 0" @click="offset = Math.max(0, offset - 100)"><ChevronLeft :size="15" /></button><span>{{ Math.floor(offset / 100) + 1 }}</span><button type="button" class="finance-icon" :title="t('costComponents.nextPage')" :aria-label="t('costComponents.nextFinancialEventsPage')" :disabled="loading || saving || offset + 100 >= snapshot.totalEvents" @click="offset += 100"><ChevronRight :size="15" /></button></footer>
    <ConfirmDialog :show="pendingVoid != null" :title="pendingVoid?.batchId ? t('costComponents.voidEntirePurchaseBatch') : t('costComponents.voidFinancialEvent')" :message="pendingVoid?.batchId ? t('costComponents.voidEveryAllocationInThisPurchaseBatch') : t('costComponents.voidThisRecordItWillRemainAvailable')" :confirm-text="t('costComponents.confirmVoid')" :cancel-text="t('costComponents.cancel')" danger @confirm="confirmVoid" @cancel="pendingVoid = null" />
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { getLocale } from '@/i18n'

import { computed, getCurrentInstance, reactive, ref, watch } from 'vue'
import { Ban, ChevronLeft, ChevronRight, ListPlus, Pencil, Plus, RefreshCw, Save, X } from '@lucide/vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { getFinanceBatch, getFinanceLedger, getFinanceRelatedEvents, saveFinanceEvent, voidFinanceBatch, voidFinanceEvent, type FinanceBatch, type FinanceCurrency, type FinanceEvent, type FinanceEventKind, type FinanceSource, type FinanceSnapshot } from '@/api/financeLedger'
import FinanceBatchEditor from './FinanceBatchEditor.vue'
import { formatMoney } from '../model'

const props = withDefaults(defineProps<{ source: FinanceSource; instanceId: string; startMs: number; endMs: number; accounts?: Array<{ id: string; name: string }> }>(), { accounts: () => [] })
const emit = defineEmits<{ changed: [] }>()
const optionsId = `finance-accounts-${getCurrentInstance()!.uid}`
const kindLabels = computed<Record<FinanceEventKind, string>>(() => ({ purchase: t('costComponents.purchase'), renewal: t('costComponents.renewal'), refund: t('costComponents.refunds'), termination_loss: t('costComponents.terminationLoss') }))
const snapshot = ref<FinanceSnapshot | null>(null)
const error = ref('')
const loading = ref(false)
const saving = ref(false)
const editing = ref(false)
const pendingVoid = ref<FinanceEvent | null>(null)
const accountFilter = ref('')
const channelFilter = ref('')
const planFilter = ref('')
const listMode = ref<'current' | 'all'>('current')
const offset = ref(0)
const batchOpen = ref(false)
const batchInitial = ref<FinanceBatch | null>(null)
const related = ref<FinanceEvent[]>([])
const relatedLoading = ref(false)
const relatedError = ref('')
let relatedSequence = 0
const epochKeys = { occurredAt: 'occurredAtMs', coverageStart: 'coverageStartMs', coverageEnd: 'coverageEndMs' } as const
const original = ref<({ event: Pick<FinanceEvent, (typeof epochKeys)[keyof typeof epochKeys]> } & Record<keyof typeof epochKeys, string>) | null>(null)
let generation = 0
let readSequence = 0
const form = reactive({ id: '', accountId: '', kind: 'purchase' as FinanceEventKind, amount: '', currency: 'CNY' as FinanceCurrency, occurredAt: '', coverageStart: '', coverageEnd: '', note: '', purchaseChannel: '', planLabel: '', relatedEventId: '' })
const isPurchase = computed(() => form.kind === 'purchase' || form.kind === 'renewal')
const relatedOptions = computed(() => related.value.filter(event => event.id !== form.id && (event.kind === 'purchase' || event.kind === 'renewal' || (form.kind === 'refund' && event.kind === 'termination_loss'))))
const times = computed(() => ({ occurredAt: resolveTime('occurredAt'), coverageStart: resolveTime('coverageStart'), coverageEnd: resolveTime('coverageEnd') }))
const validForm = computed(() => {
  const { occurredAt, coverageStart, coverageEnd } = times.value
  return form.accountId.trim() && Number.isFinite(Number(form.amount)) && Number(form.amount) > 0 && occurredAt != null && Number.isFinite(occurredAt) && (!isPurchase.value || (!form.coverageStart && !form.coverageEnd) || (coverageStart != null && coverageEnd != null && Number.isFinite(coverageStart) && Number.isFinite(coverageEnd) && coverageEnd > coverageStart))
})
const money = (amount: number, currency: FinanceCurrency) => formatMoney(amount, currency, 4)
const when = (value: number) => new Date(value).toLocaleString(getLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const accountName = (id: string) => props.accounts.find(account => account.id === id)?.name ?? id
const localInput = (time: number) => { const date = new Date(time); return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23) }
const errorText = (failure: unknown) => failure instanceof Error ? failure.message : String(failure)

function resolveTime(field: keyof typeof epochKeys): number | null {
  if (original.value && form[field] === original.value[field]) return original.value.event[epochKeys[field]] ?? null
  return form[field] ? new Date(form[field]).getTime() : null
}

async function reload() {
  const sequence = ++readSequence
  loading.value = true
  error.value = ''
  try {
    const result = await getFinanceLedger({ source: props.source, instanceId: props.instanceId, accountId: accountFilter.value || null, startMs: props.startMs, endMs: props.endMs, purchaseChannel: channelFilter.value || null, planLabel: planFilter.value || null, listMode: listMode.value, offset: offset.value, limit: 100 })
    if (sequence === readSequence) snapshot.value = result
  } catch (failure) { if (sequence === readSequence) error.value = errorText(failure) }
  finally { if (sequence === readSequence) loading.value = false }
}

async function openEditor(event?: FinanceEvent) {
  if (event?.batchId) { await openBatch(event.batchId); return }
  batchOpen.value = false
  const occurredAtMs = event?.occurredAtMs ?? Date.now()
  Object.assign(form, { id: event?.id ?? '', accountId: event?.accountId ?? accountFilter.value, kind: event?.kind ?? 'purchase', amount: event ? String(event.amount) : '', currency: event?.currency ?? 'CNY', occurredAt: localInput(occurredAtMs), coverageStart: event?.coverageStartMs != null ? localInput(event.coverageStartMs) : '', coverageEnd: event?.coverageEndMs != null ? localInput(event.coverageEndMs) : '', note: event?.note ?? '', purchaseChannel: event?.purchaseChannel ?? '', planLabel: event?.planLabel ?? '', relatedEventId: event?.relatedEventId ?? '' })
  original.value = { event: { occurredAtMs, coverageStartMs: event?.coverageStartMs, coverageEndMs: event?.coverageEndMs }, occurredAt: form.occurredAt, coverageStart: form.coverageStart, coverageEnd: form.coverageEnd }
  editing.value = true
}

async function openBatch(batchId?: string) {
  const revision = generation
  editing.value = false; batchOpen.value = false; batchInitial.value = null; error.value = ''
  if (batchId) {
    saving.value = true
    try { const result = await getFinanceBatch({ source: props.source, instanceId: props.instanceId }, batchId); if (revision !== generation) return; batchInitial.value = result }
    catch (failure) { if (revision === generation) error.value = errorText(failure); return }
    finally { if (revision === generation) saving.value = false }
  }
  if (revision === generation) batchOpen.value = true
}
async function batchSaved() { batchOpen.value = false; emit('changed'); await reload() }

async function submit() {
  if (!validForm.value || saving.value) return
  const revision = generation
  saving.value = true
  error.value = ''
  try {
    await saveFinanceEvent({ id: form.id || undefined, source: props.source, instanceId: props.instanceId, accountId: form.accountId.trim(), kind: form.kind, amount: Number(form.amount), currency: form.currency, occurredAtMs: times.value.occurredAt!, coverageStartMs: isPurchase.value ? times.value.coverageStart : null, coverageEndMs: isPurchase.value ? times.value.coverageEnd : null, note: form.note.trim() || null, purchaseChannel: isPurchase.value ? form.purchaseChannel.trim() || null : null, planLabel: isPurchase.value ? form.planLabel.trim() || null : null, relatedEventId: isPurchase.value ? null : form.relatedEventId || null })
    if (revision !== generation) return
    editing.value = false
    emit('changed')
    await reload()
  } catch (failure) { if (revision === generation) error.value = errorText(failure) }
  finally { if (revision === generation) saving.value = false }
}

async function confirmVoid() {
  const event = pendingVoid.value
  if (!event || saving.value) return
  const revision = generation
  saving.value = true
  try {
    const scope = { source: event.source, instanceId: event.instanceId }
    if (event.batchId) await voidFinanceBatch(scope, event.batchId)
    else await voidFinanceEvent(scope, event.id)
    if (revision !== generation) return
    pendingVoid.value = null
    if (form.id === event.id) editing.value = false
    if (event.batchId === batchInitial.value?.batchId) batchOpen.value = false
    emit('changed')
    await reload()
  } catch (failure) { if (revision === generation) error.value = errorText(failure) }
  finally { if (revision === generation) saving.value = false }
}

watch(() => [props.source, props.instanceId], () => { generation++; accountFilter.value = ''; channelFilter.value = ''; planFilter.value = ''; editing.value = false; batchOpen.value = false; original.value = null; pendingVoid.value = null; saving.value = false; snapshot.value = null })
watch(() => [props.source, props.instanceId, props.startMs, props.endMs, accountFilter.value, channelFilter.value, planFilter.value, listMode.value], () => { if (offset.value) offset.value = 0; else void reload() }, { immediate: true })
watch(offset, reload)
watch(() => [editing.value, form.accountId, form.currency, isPurchase.value, props.source, props.instanceId], async () => {
  const sequence = ++relatedSequence; related.value = []; relatedError.value = ''; relatedLoading.value = false
  if (!editing.value || isPurchase.value || !form.accountId.trim()) return
  relatedLoading.value = true
  try { const events = await getFinanceRelatedEvents({ source: props.source, instanceId: props.instanceId }, form.accountId.trim(), form.currency); if (sequence === relatedSequence) related.value = events }
  catch (failure) { if (sequence === relatedSequence) relatedError.value = errorText(failure) }
  finally { if (sequence === relatedSequence) relatedLoading.value = false }
})
defineExpose({ reload })
</script>

<style scoped>
.finance-events { color: var(--cost-text, #e9ede6); padding: 16px 0; border-top: 1px solid var(--cost-line, #303830); font-size: 12px; }
.finance-toolbar, .finance-row-actions, .finance-form-actions { display: flex; align-items: center; gap: 8px; }
.finance-toolbar { flex-wrap: wrap; }
.finance-toolbar h3 { margin: 0 auto 0 0; font-size: 14px; font-weight: 650; }
.finance-events :is(input, select, button) { font: inherit; color: inherit; border: 1px solid var(--cost-line-strong, #424d43); border-radius: 4px; background: var(--cost-panel, #171a17); }
.finance-events :is(input, select) { min-width: 0; min-height: 32px; padding: 6px 8px; }
.finance-toolbar select { max-width: min(240px, 100%); }
.finance-button, .finance-icon { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 10px; cursor: pointer; }
.finance-icon { width: 32px; height: 32px; padding: 0; flex-shrink: 0; }
.finance-primary { background: var(--cost-lime, #b9e55a) !important; color: #151912 !important; }
.finance-events button:disabled { opacity: .45; cursor: default; }
.finance-events :is(input, select, button):focus-visible { outline: 2px solid var(--cost-lime, #b9e55a); outline-offset: 2px; }
.finance-summary { margin: 12px 0; }
.finance-summary-row { display: flex; flex-wrap: wrap; gap: 10px 20px; padding: 7px 0; }
.finance-summary-row span, .finance-status { color: var(--cost-muted, #8f9b91); }
.finance-summary-row b { color: var(--cost-text, #e9ede6); font-variant-numeric: tabular-nums; font-weight: 500; }
.finance-summary-row small, .finance-warning { color: var(--cost-gold, #dfbc4c); }
.finance-error { color: #f49a9a; overflow-wrap: anywhere; }
.finance-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 12px; margin: 14px 0; padding: 14px 0; border-block: 1px solid var(--cost-line, #303830); }
.finance-form label { display: flex; flex-direction: column; gap: 6px; color: var(--cost-muted, #8f9b91); min-width: 0; }
.finance-note { grid-column: 1 / -1; }
.finance-form-actions { grid-column: 1 / -1; justify-content: flex-end; flex-wrap: wrap; }
.finance-table-scroll { width: 100%; overflow-x: auto; }
.finance-events table { width: 100%; border-collapse: collapse; text-align: left; }
.finance-events th { color: var(--cost-muted, #8f9b91); font-weight: 500; white-space: nowrap; }
.finance-events :is(th, td) { padding: 9px 10px; border-bottom: 1px solid var(--cost-line, #303830); vertical-align: top; }
.finance-events td { min-width: 70px; overflow-wrap: anywhere; }
.finance-amount { white-space: nowrap; font-variant-numeric: tabular-nums; }
.finance-row-note { max-width: 240px; }
.finance-voided { color: var(--cost-muted, #8f9b91); }
.finance-voided .finance-amount { text-decoration: line-through; }
.finance-pagination { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 12px; color: var(--cost-muted, #8f9b91); }
@media (max-width: 600px) { .finance-summary-row { gap: 8px 12px; } .finance-toolbar h3 { flex-basis: 100%; } }
</style>
