<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ApiUsage } from '@/api/usageAccounts'
import { monitorAmount, monitorAutomaticPriceSummary, type MonitorTotals } from '@/api/usageMonitor'
import { usageLocale } from '@/utils/usageFormat'

const props = defineProps<{ usage: ApiUsage }>()
const { t } = useI18n()
const amount = (totals: MonitorTotals) => {
  if (!totals.requestCount) return t('usageMonitor.text.noRequestsYet')
  return monitorAutomaticPriceSummary(totals).currencies
    .filter(row => row.identifiedSubtotal != null)
    .map(row => ['USD','CNY'].includes(row.currency)
      ? new Intl.NumberFormat(usageLocale(),{style:'currency',currency:row.currency,currencyDisplay:'narrowSymbol',...(row.identifiedSubtotal!>0 && row.identifiedSubtotal!<.01 ? {maximumSignificantDigits:6} : {maximumFractionDigits:2})}).format(row.identifiedSubtotal!)
      : monitorAmount(row.identifiedSubtotal!, row.currency)).join(' / ')
    || t('usageMonitor.text.identifiedAmountUnknown')
}
const week = computed(() => amount(props.usage.week.totals))
const month = computed(() => props.usage.month ? amount(props.usage.month.totals) : null)
</script>

<template>
  <section class="api-account" aria-label="API">
    <h3>API</h3>
    <div class="api-amounts">
      <div><span>{{ t('usageMonitor.text.apiUsedThisWeek') }}</span><strong>{{ week }}</strong></div>
      <div v-if="month"><span>{{ t('usageMonitor.text.usedThisMonth') }}</span><strong>{{ month }}</strong></div>
    </div>
    <small>{{ t('usageMonitor.text.requests6', { value0: usage.week.totals.requestCount }) }}</small>
    <slot />
  </section>
</template>

<style scoped>
.api-account{padding:18px 0;border-bottom:1px solid var(--cost-line)}h3{font-size:16px;margin:0 0 16px}.api-amounts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.api-amounts span,small{font-size:12px;color:var(--cost-muted)}.api-amounts strong{display:block;font-size:23px;color:var(--cost-gold);margin-top:7px;overflow-wrap:anywhere}.api-amounts>div+div strong{color:var(--usage-cache)}small{display:block;margin-top:12px}
</style>
