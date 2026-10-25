<template>
  <aside v-if="account" ref="inspector" class="cost-inspector" role="dialog" aria-modal="false" aria-labelledby="cost-profile-title">
    <header class="cost-inspector__header">
      <div>
        <span class="cost-kicker">{{ t('costComponents.accountCostProfile') }}</span>
        <h2 id="cost-profile-title">{{ inspectorTitle }}</h2>
        <p>{{ accountCount && accountCount > 1 ? t('costComponents.accountsFormBasedOn', { p0: accountCount, p1: account.name }) : account.name }}</p>
      </div>
      <button type="button" class="cost-icon-button" :aria-label="t('costComponents.closeCostSettings')" :title="t('costComponents.closeEsc')" @click="$emit('close')">
        <X :size="18" />
      </button>
    </header>

    <div class="cost-inspector__body">
      <section v-if="isMetered" class="cost-metered-card">
        <span class="cost-kicker">{{ t('costComponents.automaticTokenBilling') }}</span>
        <h3>{{ upstreamOrigin }}</h3>
        <strong> {{ t('costComponents.noPurchaseAmountRequired') }} </strong>
        <p>{{ meteredExplanation }}</p>
        <div class="cost-metered-flow" :aria-label="t('costComponents.usageBasedCostCalculationSteps')">
          <template v-for="(step, index) in meteredFlowSteps" :key="step"><i v-if="index > 0">→</i><span>{{ step }}</span></template>
        </div>
      </section>

      <section v-if="isMetered" class="cost-inspector__summary cost-inspector__summary--metered">
        <div>
          <span> {{ t('costComponents.usageBasedBillingBasis') }} </span>
          <strong>Token</strong>
          <small> {{ t('costComponents.inputTokensCacheHitsOutputTokens') }} </small>
        </div>
        <div>
          <span> {{ t('costComponents.accountCostMultiplier') }} </span>
          <strong>{{ accountMultiplierText }}</strong>
          <small>{{ accountMultiplierNote }}</small>
        </div>
        <div>
          <span> {{ t('costComponents.fixedAdditionalCost') }} </span>
          <strong>{{ resolved.source === 'custom' ? formatMoney(currentHourly, form.currency, 5) + '/h' : t('costComponents.none') }}</strong>
          <small> {{ t('costComponents.optionalDoesNotReplaceTokenCost') }} </small>
        </div>
      </section>

      <button
        v-if="isMetered && !showFixedProfileEditor"
        type="button"
        class="cost-overhead-toggle"
        data-testid="enable-fixed-overhead"
        @click="fixedEditorOpen = true"
      > {{ t('costComponents.monthlyRentRechargeFeesOrDedicatedLine') }} </button>

      <section v-if="showFixedProfileEditor" class="cost-inspector__summary">
        <div>
          <span>{{ isMetered ? t('costComponents.accruedFixedAdditionalCost') : t('costComponents.accruedPurchaseCostConfiguredEstimate') }}</span>
          <strong>{{ formatMoney(currentAccrued, form.currency, 4) }}</strong>
        </div>
        <div>
          <span>{{ isMetered ? t('costComponents.hourlyFixedAdditionalCost') : t('costComponents.hourlyCostConfiguredEstimate') }}</span>
          <strong>{{ formatMoney(currentHourly, form.currency, 5) }}</strong>
        </div>
        <div>
          <span> {{ t('costComponents.elapsedCostPeriod') }} </span>
          <strong>{{ currentElapsed.toFixed(1) }} h</strong>
        </div>
      </section>

      <div v-if="showFixedProfileEditor && !isMetered" class="cost-form-field">
        <label for="cost-plan"> {{ t('costComponents.detectedPlan') }} </label>
        <div id="cost-plan" class="cost-readonly-row">
          <span>{{ planLabel }}</span>
          <button type="button" class="cost-text-button" @click="applyPlanDefault"> {{ t('costComponents.applyUsOfficialDefaultPrice') }} </button>
        </div>
        <small class="cost-official-price-note"> {{ t('costComponents.plusMonthProFromBusinessFormerTeam') }} </small>
      </div>

      <div v-if="showFixedProfileEditor" class="cost-form-grid">
        <div class="cost-form-field">
          <label for="cost-amount">{{ isMetered ? t('costComponents.fixedAdditionalAmount') : t('costComponents.purchaseAmount') }}</label>
          <input id="cost-amount" v-model.number="form.amount" type="number" min="0" step="0.01" inputmode="decimal" />
        </div>
        <div class="cost-form-field">
          <label for="cost-currency"> {{ t('costComponents.currency') }} </label>
          <select id="cost-currency" v-model="form.currency">
            <option value="CNY"> {{ t('costComponents.cnyChineseYuan') }} </option>
            <option value="USD"> {{ t('costComponents.usdUsDollar') }} </option>
          </select>
        </div>
      </div>

      <div v-if="showFixedProfileEditor" class="cost-form-field">
        <label for="cost-cycle"> {{ t('costComponents.billingCycle') }} </label>
        <select id="cost-cycle" v-model="form.billing_cycle">
          <option value="hourly"> {{ t('costComponents.hourly') }} </option>
          <option value="daily"> {{ t('costComponents.daily') }} </option>
          <option value="weekly"> {{ t('costComponents.weekly') }} </option>
          <option value="monthly"> {{ t('costComponents.monthlyHours') }} </option>
          <option value="one_time"> {{ t('costComponents.oneTime') }} </option>
        </select>
      </div>

      <div v-if="showFixedProfileEditor" class="cost-form-field">
        <label for="cost-started"> {{ t('costComponents.costStartTime') }} </label>
        <input id="cost-started" v-model="form.started_at" type="datetime-local" :min="joinedAtLocal" />
        <small> {{ t('costComponents.accountJoinedAt') }} {{ formatDateTime(account.created_at) }} {{ t('costComponents.costsCannotStartBeforeThisTime') }} </small>
      </div>

      <section v-if="showFixedProfileEditor" class="cost-form-note">
        <Clock3 :size="16" />
        <p v-if="isMetered">{{ meteredFixedOverheadNote }}</p>
        <p v-else> {{ t('costComponents.theseFiguresAreDerivedFromCostSettings') }} </p>
      </section>

      <section class="cost-form-meta">
        <div><span> {{ t('costComponents.platform') }} </span><strong>{{ account.platform }}</strong></div>
        <div><span> {{ t('costComponents.accountType') }} </span><strong>{{ account.type }}</strong></div>
        <div><span> {{ t('costComponents.costMode') }} </span><strong>{{ isMetered ? t('costComponents.automaticModelUsageBilling') : t('costComponents.fixedSubscriptionPurchase') }}</strong></div>
        <div><span> {{ t('costComponents.configurationSource') }} </span><strong>{{ configurationSourceLabel }}</strong></div>
        <div><span> {{ t('costComponents.algorithmVersion') }} </span><strong>v{{ resolved.algorithm_version }}</strong></div>
      </section>
    </div>

    <footer class="cost-inspector__footer">
      <button type="button" class="cost-button cost-button--quiet" @click="$emit('close')">{{ isMetered && !showFixedProfileEditor ? t('costComponents.done') : t('costComponents.cancel') }}</button>
      <button v-if="showFixedProfileEditor" type="button" class="cost-button cost-button--primary" :disabled="saving || !isValid" @click="submit">
        <LoaderCircle v-if="saving" class="cost-spin" :size="16" />
        <Save v-else :size="16" />
        {{ isMetered ? t('costComponents.saveFixedAdditionalCost') : t('costComponents.saveCostSettings') }}
      </button>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Clock3, LoaderCircle, Save, X } from '@lucide/vue'
import type { SourceAccount as Account } from '../sourceTypes'
import {
  DEFAULT_MONTHLY_PRICES_USD,
  COST_ALGORITHM_VERSION,
  accruedCost,
  elapsedHours,
  formatMoney,
  hourlyRate,
  inferPlan,
  resolveAccountBillingMode,
  resolveCostProfile,
  type BillingCycle,
  type CostCurrency,
  type CostProfile,
} from '../model'
import { classifyUpstreamProvider, describeUpstreamOrigin } from '../upstreamProvider'
import { formatDate as formatDateByLocale } from '@/utils/format'

const props = defineProps<{
  /** 当前连接源。**必填**:本组件的按量成本文案会点名数据来源与价格来源 ——
   *  sub2api 读 `usage_logs`,价格取渠道自定义价格 / 官方模型价格目录,且有账号费率(倍率)层;
   *  cliproxy 读 CPA `usage_events`,价格只有 LiteLLM 单价,且**无**渠道价与账号费率;
   *  cockpit 读本机单请求用量库,价格只有本地价目表,同样无渠道价与账号费率。
   *  缺省一个值等于默认对两个源说错话,故不给默认值,让调用点必须显式声明。 */
  sourceKind: 'sub2api' | 'cliproxy' | 'cockpit'
  account: Account | null
  accountCount?: number
  saving: boolean
  now: Date
}>()

const emit = defineEmits<{
  close: []
  save: [profile: CostProfile]
}>()

const form = reactive<{
  amount: number
  currency: CostCurrency
  billing_cycle: BillingCycle
  started_at: string
}>({ amount: 0, currency: 'CNY', billing_cycle: 'monthly', started_at: '' })
const fixedEditorOpen = ref(false)
const inspector = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
watch(() => props.account?.id, async (id, previous) => {
  if (id != null && previous == null) {
    returnFocus = document.activeElement as HTMLElement | null
    await nextTick()
    if (props.account?.id === id) inspector.value?.querySelector<HTMLButtonElement>('button')?.focus()
  } else if (id == null && returnFocus?.isConnected) {
    returnFocus.focus()
    returnFocus = null
  }
}, { immediate: true })

function toLocalInput(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function toIso(value: string, fallback: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback
}

watch(
  () => props.account,
  (account) => {
    if (!account) return
    const profile = resolveCostProfile(account)
    form.amount = profile.amount
    form.currency = profile.currency
    form.billing_cycle = profile.billing_cycle
    form.started_at = toLocalInput(profile.started_at)
    fixedEditorOpen.value = resolveAccountBillingMode(account) === 'metered' && profile.source === 'custom'
  },
  { immediate: true },
)

const plan = computed(() => props.account ? inferPlan(props.account) : 'unknown')
const planLabel = computed(() => plan.value === 'unknown' ? t('costComponents.unrecognized') : plan.value.toUpperCase())
const billingMode = computed(() => props.account ? resolveAccountBillingMode(props.account) : 'subscription')
const isMetered = computed(() => billingMode.value === 'metered')
const showFixedProfileEditor = computed(() => !isMetered.value || fixedEditorOpen.value)
const inspectorTitle = computed(() => {
  if (props.accountCount && props.accountCount > 1) return isMetered.value ? t('costComponents.batchFixedAdditionalCost') : t('costComponents.batchCostSettings')
  return isMetered.value ? t('costComponents.apiUsageBasedCost') : t('costComponents.accountCostSettings')
})
const upstreamProvider = computed(() => props.account ? classifyUpstreamProvider(props.account) : 'other')
const upstreamOrigin = computed(() => props.account ? describeUpstreamOrigin(props.account) : t('costComponents.upstreamApi'))
/** 该源的按量成本取自哪张用量表:只有 sub2api 读 `usage_logs`。
 *  cliproxy 是 CPA `usage_events`,cockpit 是本机单请求用量库 —— 三源都不是同一张表。 */
const meteredUsageSourceLabel = computed(() => {
  if (props.sourceKind === 'sub2api') return 'usage_logs'
  if (props.sourceKind === 'cliproxy') return 'CPA usage_events'
  return t('costComponents.cockpitLocalUsageDatabase')
})
/** 该源的价格来源:只有 sub2api 才分「渠道自定义价格 / 官方模型价格目录」;
 *  cliproxy 只有 LiteLLM 单价,cockpit 只有本地价目表 —— 这两个源没有渠道价。 */
const meteredPriceSource = computed(() => {
  if (props.sourceKind === 'sub2api') return upstreamProvider.value === 'relay' ? t('costComponents.customChannelPrices') : t('costComponents.officialModelPriceCatalog')
  if (props.sourceKind === 'cliproxy') return t('costComponents.litellmUnitPrices')
  return t('costComponents.localPriceBook')
})
/** 按量成本的计算链。只有 sub2api 存在「账号倍率」这一层(cliproxy / cockpit 的账号对象
 *  不带 rate_multiplier,CostCenterView 已注明这两源「无账号费率」),该步只对 sub2api 出现。 */
const meteredFlowSteps = computed<string[]>(() => {
  const base = [meteredUsageSourceLabel.value, t('costComponents.actualUpstreamModel'), meteredPriceSource.value]
  return props.sourceKind === 'sub2api' ? [...base, t('costComponents.accountMultiplier')] : base
})
const meteredExplanation = computed(() => {
  if (props.sourceKind === 'sub2api') {
    return upstreamProvider.value === 'relay'
      ? t('costComponents.relayChannelPricesTakePriorityTheModel')
      : t('costComponents.actualTokensCacheHitsAndTheUpstream')
  }
  if (props.sourceKind === 'cliproxy') {
    return t('costComponents.thisSourceHasNoAvailableChannelPrices')
  }
  return t('costComponents.thisSourceHasNoAvailableRevenueLayer')
})
/** 固定附加成本说明:三源的用量来源与价格来源各不相同,不能统一说成 usage_logs + 渠道价。 */
const meteredFixedOverheadNote = computed(() => {
  if (props.sourceKind === 'sub2api') return t('costComponents.configureOnlyFixedCostsInAdditionTo')
  if (props.sourceKind === 'cliproxy') return t('costComponents.configureOnlyFixedCostsInAdditionTom210')
  return t('costComponents.configureOnlyFixedCostsInAdditionTom211')
})
const accountRateMultiplier = computed(() => {
  const value = Number(props.account?.rate_multiplier ?? 1)
  return Number.isFinite(value) && value >= 0 ? value : 1
})
/** 账号费率(倍率)只有 sub2api 有。cliproxy / cockpit 的账号对象不带 rate_multiplier,
 *  把兜底的 1 渲染成「×1.0000」等于宣称该源有账号费率层且恰好为 1 ⇒ 两源一律显示「—」。 */
const accountMultiplierText = computed(() => props.sourceKind === 'sub2api'
  ? `×${accountRateMultiplier.value.toFixed(4)}`
  : '—')
const accountMultiplierNote = computed(() => {
  if (props.sourceKind === 'sub2api') return t('costComponents.relayDiscountOrActualProcurementMultiplier')
  if (props.sourceKind === 'cliproxy') return t('costComponents.noAccountRateBasisEstimatedUsingLitellm')
  return t('costComponents.noAccountRateBasisCalculatedUsingThe')
})
const resolved = computed(() => props.account ? resolveCostProfile(props.account) : {
  amount: 0,
  currency: 'CNY' as CostCurrency,
  billing_cycle: 'monthly' as BillingCycle,
  started_at: new Date().toISOString(),
  source: 'default' as const,
  algorithm_version: COST_ALGORITHM_VERSION,
})
const configurationSourceLabel = computed(() => {
  if (isMetered.value) return resolved.value.source === 'custom' ? t('costComponents.automaticUsageFixedAdditionalCost') : meteredPriceSource.value
  return resolved.value.source === 'custom' ? t('costComponents.userDefined') : t('costComponents.planDefault')
})
const joinedAtLocal = computed(() => props.account ? toLocalInput(props.account.created_at) : '')
const draftProfile = computed<CostProfile>(() => ({
  amount: Number(form.amount) || 0,
  currency: form.currency,
  billing_cycle: form.billing_cycle,
  started_at: props.account ? maxStartTime(toIso(form.started_at, props.account.created_at), props.account.created_at) : new Date().toISOString(),
  source: 'custom',
  algorithm_version: COST_ALGORITHM_VERSION,
}))
const currentAccrued = computed(() => accruedCost(draftProfile.value, props.now))
const currentHourly = computed(() => hourlyRate(draftProfile.value))
const currentElapsed = computed(() => elapsedHours(draftProfile.value.started_at, props.now))
const isValid = computed(() => Number.isFinite(Number(form.amount)) && Number(form.amount) >= 0 && Boolean(form.started_at))

function maxStartTime(requested: string, joinedAt: string): string {
  return new Date(requested).getTime() < new Date(joinedAt).getTime() ? joinedAt : requested
}

function applyPlanDefault() {
  form.amount = DEFAULT_MONTHLY_PRICES_USD[plan.value]
  form.currency = 'USD'
  form.billing_cycle = 'monthly'
  if (props.account) form.started_at = toLocalInput(props.account.created_at)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? formatDateByLocale(date) : t('costComponents.noData')
}

function submit() {
  if (!isValid.value) return
  emit('save', draftProfile.value)
}
</script>

<style scoped>
.cost-inspector {
  position: fixed;
  z-index: 100;
  top: var(--desktop-titlebar-height, 0px);
  right: 0;
  bottom: 0;
  display: flex;
  width: min(430px, 100vw);
  flex-direction: column;
  color: #e7ece4;
  background: #111511;
  border-left: 1px solid #465047;
  box-shadow: -18px 0 48px rgb(0 0 0 / 32%);
  border-radius: 16px 0 0 16px;
  font-family: 'Segoe UI Variable', 'Microsoft YaHei UI', sans-serif;
}

.cost-inspector__header,
.cost-inspector__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid #303830;
  background: #111511;
}

.cost-inspector__header h2 { margin: 3px 0 0; font-size: 20px; font-weight: 680; }
.cost-inspector__header > div { min-width: 0; }
.cost-inspector__header p { margin: 4px 0 0; color: #8b968d; font-family: 'Cascadia Mono', monospace; font-size: 12px; overflow-wrap: anywhere; }
.cost-kicker { color: #b9e55a; font-family: 'Cascadia Mono', monospace; font-size: 10px; letter-spacing: 0; }
.cost-icon-button { display: grid; flex: 0 0 34px; width: 34px; height: 34px; place-items: center; color: #aab4aa; background: transparent; border: 1px solid #374037; }
.cost-icon-button:active { transform: translateY(1px); background: #202720; }

.cost-inspector__body { flex: 1; min-height: 0; overflow: auto; padding: 20px; }
.cost-metered-card { margin-bottom: 16px; padding: 18px; background: linear-gradient(135deg, #1b2418, #131913); border: 1px solid #50643b; border-radius: 12px; }
.cost-metered-card h3 { margin: 8px 0 4px; color: #eef3e9; font-size: 18px; }
.cost-metered-card > strong { display: block; color: #b9e55a; font-size: 21px; }
.cost-metered-card > p { margin: 10px 0 0; color: #a4aea4; font-size: 12px; line-height: 1.7; }
.cost-metered-flow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 14px; color: #aab5a8; font-family: 'Cascadia Mono', monospace; font-size: 10px; }
.cost-metered-flow span { padding: 5px 7px; background: #111711; border: 1px solid #354136; border-radius: 6px; }
.cost-metered-flow i { color: #b9e55a; font-style: normal; }
.cost-overhead-toggle { width: 100%; margin: 0 0 18px; padding: 11px 13px; color: #b9e55a; background: #151b15; border: 1px dashed #536143; border-radius: 9px; font-size: 12px; text-align: left; }
.cost-overhead-toggle:active { background: #20291e; }
.cost-inspector__summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 20px; border: 1px solid #394239; border-radius: 8px; }
.cost-inspector__summary div { min-width: 0; padding: 14px; border-right: 1px solid #394239; border-bottom: 1px solid #394239; overflow-wrap: anywhere; }
.cost-inspector__summary div:last-child { border-right: 0; border-bottom: 0; }
.cost-inspector__summary span, .cost-form-meta span { display: block; color: #7f8b81; font-size: 11px; }
.cost-inspector__summary strong { display: block; margin-top: 5px; color: #c4ed63; font-family: 'Cascadia Mono', monospace; font-size: 17px; }
.cost-inspector__summary small { display: block; margin-top: 5px; color: #707c72; font-size: 10px; line-height: 1.45; }
.cost-inspector__summary--metered strong { font-size: 15px; }

.cost-form-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.cost-form-field { margin-bottom: 16px; }
.cost-form-field label { display: block; margin-bottom: 7px; color: #9ea89f; font-size: 12px; }
.cost-form-field input, .cost-form-field select { width: 100%; height: 40px; padding: 0 11px; color: #eef2e9; background: #171c17; border: 1px solid #3a443b; border-radius: 9px; outline: none; }
.cost-form-field input:focus, .cost-form-field select:focus { border-color: #b9e55a; box-shadow: 0 0 0 1px #b9e55a; }
.cost-form-field small { display: block; margin-top: 7px; color: #727e74; line-height: 1.5; }
.cost-form-field .cost-official-price-note { color: #8f9b91; }
.cost-readonly-row { display: flex; min-height: 40px; align-items: center; justify-content: space-between; gap: 12px; padding: 0 10px; background: #171c17; border: 1px solid #3a443b; border-radius: 9px; }
.cost-readonly-row span { color: #d9dfd5; font-family: 'Cascadia Mono', monospace; }
.cost-text-button { padding: 4px; color: #b9e55a; background: transparent; border: 0; font-size: 11px; }
.cost-text-button:active { color: #e3ff9d; }
.cost-form-note { display: flex; gap: 10px; margin: 20px 0; padding: 13px; color: #a6b0a6; background: #1a2118; border-left: 2px solid #b9e55a; }
.cost-form-note p { margin: 0; font-size: 12px; line-height: 1.65; }
.cost-form-meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: #303830; border: 1px solid #303830; border-radius: 11px; overflow: hidden; }
.cost-form-meta div { min-width: 0; padding: 11px; background: #151a15; }
.cost-form-meta strong { display: block; margin-top: 4px; color: #dbe1d8; font-size: 12px; font-weight: 550; overflow-wrap: anywhere; }

.cost-inspector__footer { position: relative; z-index: 1; flex-wrap: wrap; justify-content: flex-end; border-top: 1px solid #303830; border-bottom: 0; box-shadow: 0 -12px 24px rgb(0 0 0 / 16%); }
.cost-button { display: inline-flex; height: 40px; align-items: center; gap: 8px; padding: 0 15px; color: #dbe1d8; background: #1a201a; border: 1px solid #465047; border-radius: 9px; }
.cost-button:active { transform: translateY(1px); }
.cost-button--primary { color: #10140f; background: #b9e55a; border-color: #b9e55a; font-weight: 700; }
.cost-button:disabled { opacity: .48; }
.cost-spin { animation: cost-spin .8s linear infinite; }

@keyframes cost-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cost-spin { animation-duration: 1.8s; } }
@media (max-width: 520px) {
  .cost-inspector { width: 100vw; border-radius: 0; }
  .cost-inspector__header, .cost-inspector__footer { padding-inline: 16px; }
  .cost-inspector__body { padding: 16px; }
  .cost-inspector__summary { grid-template-columns: 1fr 1fr; }
  .cost-inspector__summary div:last-child { grid-column: 1 / -1; border-right: 0; }
  .cost-form-grid { grid-template-columns: 1fr; gap: 0; }
}
.cost-inspector__footer { flex-wrap: wrap; }
.cost-button { height: auto; min-height: 40px; max-width: 100%; padding-block: 8px; white-space: normal; overflow-wrap: anywhere; }
.cost-metered-flow { flex-wrap: wrap; }
</style>
