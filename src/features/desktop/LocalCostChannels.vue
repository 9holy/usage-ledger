<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ReceiptText } from '@lucide/vue'
import { getFinanceLedger, type FinanceSnapshot } from '@/api/financeLedger'
import { LOCAL_FINANCE_SCOPE } from '@/api/localCost'
import { usageLocale } from '@/utils/usageFormat'

const props = defineProps<{ snapshot: FinanceSnapshot | null; startMs: number; endMs: number; accounts: Array<{ id: string; name: string }> }>()
const emit = defineEmits<{ enter: [] }>()
const { t } = useI18n()
const channel = ref(''), loading = ref(false), error = ref(''), selected = ref<FinanceSnapshot | null>(null)
const data = computed(() => channel.value ? selected.value : props.snapshot)
let sequence = 0
watch(() => [channel.value, props.startMs, props.endMs, props.snapshot], async () => {
  const current = ++sequence
  selected.value = null; error.value = ''; loading.value = false
  if (!channel.value) return
  loading.value = true
  try {
    const result = await getFinanceLedger({ ...LOCAL_FINANCE_SCOPE, startMs: props.startMs, endMs: props.endMs, purchaseChannel: channel.value })
    if (current === sequence) selected.value = result
  } catch (failure) { if (current === sequence) error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { if (current === sequence) loading.value = false }
})
const money = (amount: number | null, currency: string) => amount == null ? t('costComponents.allocationIncomplete') : new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 4 }).format(amount)
const name = (id: string) => props.accounts.find(account => account.id === id)?.name ?? id
</script>

<template>
  <section class="local-channels">
    <header><div><h2>{{ t('desktop.localCost.channelCosts') }}</h2><span>{{ t('desktop.localCost.channelBasis') }}</span></div><select v-model="channel" :aria-label="t('costComponents.filterPurchaseChannels')"><option value="">{{ t('costComponents.allPurchaseChannels') }}</option><option v-for="item in snapshot?.purchaseChannels ?? []" :key="item">{{ item }}</option></select></header>
    <p v-if="loading" role="status">{{ t('desktop.localCost.loading') }}</p><p v-if="error" class="channel-error" role="alert">{{ error }}</p>
    <div v-if="data?.summary.hasEnteredFacts" class="channel-results"><div v-for="item in data.summary.currencies" :key="item.currency" class="channel-currency"><strong>{{ item.currency }}</strong><div><span>{{ t('desktop.localCost.cashPaid') }}</span><b>{{ money(item.cashOutlay, item.currency) }}</b></div><div><span>{{ t('costComponents.refunds') }}</span><b>{{ money(item.refunds, item.currency) }}</b></div><div><span>{{ t('desktop.localCost.subscriptionCost') }}</span><b>{{ money(item.accruedExpense, item.currency) }}</b></div><div><span>{{ t('desktop.localCost.confirmedLoss') }}</span><b>{{ money(item.recognizedLoss, item.currency) }}</b></div><div><span>{{ t('desktop.localCost.recordedCost') }}</span><b>{{ money(item.netExpense, item.currency) }}</b></div><div><span>{{ t('costComponents.remainingPrepaid') }}</span><b>{{ money(item.remainingPrepaid, item.currency) }}</b></div></div></div>
    <div v-if="data?.byAccount.length" class="channel-table"><table><thead><tr><th>{{ t('costComponents.account') }}</th><th>{{ t('costComponents.currency') }}</th><th>{{ t('desktop.localCost.cashPaid') }}</th><th>{{ t('desktop.localCost.subscriptionCost') }}</th><th>{{ t('desktop.localCost.confirmedLoss') }}</th><th>{{ t('desktop.localCost.recordedCost') }}</th><th>{{ t('costComponents.remainingPrepaid') }}</th></tr></thead><tbody><tr v-for="item in data.byAccount" :key="item.accountId + item.currency"><td>{{ name(item.accountId) }}</td><td>{{ item.currency }}</td><td>{{ money(item.cashOutlay, item.currency) }}</td><td>{{ money(item.accruedExpense, item.currency) }}</td><td>{{ money(item.recognizedLoss, item.currency) }}</td><td>{{ money(item.netExpense, item.currency) }}</td><td>{{ money(item.remainingPrepaid, item.currency) }}</td></tr></tbody></table></div>
    <div v-else-if="!loading && !error" class="channel-empty"><ReceiptText :size="28" /><h3>{{ t('desktop.localCost.noChannelCosts') }}</h3><button @click="emit('enter')">{{ t('desktop.localCost.enterPurchase') }}</button></div>
  </section>
</template>

<style scoped>
.local-channels{padding-top:24px}.local-channels>header{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}.local-channels h2{font-size:16px;margin:0;font-weight:550}.local-channels header span{display:block;font-size:11px;color:var(--cost-muted);margin-top:8px}.local-channels select{max-width:260px}.local-channels>p{font-size:12px;color:var(--cost-muted);margin:20px 0}.local-channels .channel-error{color:var(--cost-gold)}.channel-currency{display:grid;grid-template-columns:50px repeat(6,minmax(0,1fr));gap:18px;padding:25px 0;border-bottom:1px solid var(--cost-line);align-items:start}.channel-currency>strong{font-size:12px;color:var(--cost-blue)}.channel-currency span{display:block;font-size:11px;color:var(--cost-muted);line-height:1.6}.channel-currency b{display:block;font-weight:500;font-size:18px;margin-top:9px;overflow-wrap:anywhere}.channel-table{width:100%;overflow-x:auto;margin-top:24px}.channel-table table{width:100%;border-collapse:collapse;font-size:12px}.channel-table th,.channel-table td{padding:14px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--cost-line)}.channel-table th:first-child,.channel-table td:first-child{text-align:left}.channel-table th{font-weight:400;font-size:10px;color:var(--cost-muted);background:var(--cost-panel)}.channel-empty{padding:55px 20px;display:flex;flex-direction:column;align-items:center;gap:14px;color:var(--cost-muted)}.channel-empty h3{margin:0;font-size:13px;font-weight:400}.channel-empty button{border:1px solid var(--cost-line-strong);border-radius:4px;padding:8px 14px;color:var(--cost-text);background:var(--cost-panel)}@media(max-width:950px){.channel-currency{grid-template-columns:repeat(3,minmax(0,1fr))}.channel-currency>strong{grid-column:1/-1}}@media(max-width:550px){.channel-currency{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
