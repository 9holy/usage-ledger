<template>
  <!-- 成本中心风格的 cockpit 专用面板(免登录):复用 TruthfulMetric + cost 样式体系 -->
  <div class="cost-page cost-cockpit-only">
    <!-- 顶部工具条 -->
    <header class="cost-toolbar">
      <div class="cost-brand-block">
        <div class="cost-page-heading cost-page-heading--compact">
          <div>
            <span>COCKPIT / LOCAL DATA</span>
            <h2>{{ t('desktop.cockpit.title') }}</h2>
            <p>{{ stateLabel }} · {{ t('desktop.cockpit.localRead') }}</p>
          </div>
        </div>
      </div>
      <div class="cost-workspaces">
        <button type="button" class="cost-source-toggle active" @click="router.push('/connect')">
          <ArrowLeft :size="15" />
          <span class="cost-source-name">{{ t('desktop.cockpit.back') }}</span>
        </button>
      </div>
      <div class="cockpit-toolbar-actions">
        <span class="cost-refresh-stamp">{{ stats?.updatedAt ? t('desktop.cockpit.updated', { time: formatTime(stats.updatedAt) }) : '—' }}</span>
        <button type="button" class="cockpit-refresh" :title="t('desktop.cockpit.refresh')" :aria-label="t('desktop.cockpit.refresh')" :disabled="loading" @click="loadData"><RefreshCw :size="16" :class="{ 'cockpit-spin': loading }" /></button>
      </div>
    </header>

    <main class="cost-body" :aria-busy="loading">
      <div v-if="error" class="cost-read-error" role="alert"><CircleAlert :size="16" /><div><span>{{ error }}</span><small v-if="stats">{{ t('desktop.cockpit.retained') }}</small></div></div>
      <!-- 加载/空状态 -->
      <div v-if="loading" class="cost-empty" role="status">
        <span>{{ t('desktop.cockpit.loading') }}</span>
      </div>
      <div v-else-if="!stats && !error" class="cost-empty" role="status">
        <span>{{ t('desktop.cockpit.empty') }}</span>
        <small v-if="state?.reason">{{ state.reason }}</small>
      </div>

      <!-- 数据就绪 -->
      <section v-else-if="stats && !loading" class="cost-workspace cost-unified" aria-labelledby="cockpit-title">
        <div class="cost-section-heading">
          <span>COCKPIT / COST OVERVIEW</span>
          <h2 id="cockpit-title">{{ t('desktop.cockpit.overview') }}</h2>
          <p>{{ t('desktop.cockpit.budgetReady') }}</p>
        </div>

        <!-- 总成本大数 -->
        <div class="cost-unified-total">
          <div class="cost-donut-wrap">
            <div class="cost-donut cost-donut--unified">
              <div>
                <strong :class="totalValueClass">{{ formatUsd(displayTotalUsd, 2) }}</strong>
                <span>{{ t('desktop.cockpit.totalUsd') }}</span>
              </div>
            </div>
          </div>
          <div class="cost-metric-grid">
            <MetricCell :label="t('desktop.cockpit.cost')" :value="formatUsd(displayTotalUsd, 2)" :note="costNote" :state="costState" accent="lime" />
            <MetricCell :label="t('desktop.cockpit.totalTokens')" :value="formatTokens(stats.totals.totalTokens)" :note="t('desktop.cockpit.localStats')" :state="truthfulState(stats.totals.totalTokens)" />
            <MetricCell :label="t('desktop.cockpit.requests')" :value="formatInteger(stats.totals.requestCount)" :note="t('desktop.cockpit.localStats')" :state="truthfulState(stats.totals.requestCount)" />
            <MetricCell :label="t('desktop.cockpit.results')" :value="`${formatInteger(stats.totals.successCount)} / ${formatInteger(stats.totals.failureCount)}`" :note="t('desktop.cockpit.requestResults')" :state="truthfulStateAll(stats.totals.successCount, stats.totals.failureCount)" />
          </div>
        </div>

        <!-- 口径提示条 -->
        <div class="cost-provenance-strip">
          <div><CircleCheck :size="15" /><strong>{{ costProvenanceTitle }}</strong><span>{{ costProvenanceDetail }}</span></div>
          <div><TrendingUp :size="15" /><strong>{{ t('desktop.cockpit.directRead') }}</strong><span>{{ t('desktop.cockpit.directReadDetail') }}</span></div>
        </div>

        <!-- token 结构 -->
        <div class="cost-metric-grid cost-metric-grid--tokens">
          <MetricCell label="Input Tokens" :value="formatTokens(stats.totals.inputTokens)" :state="truthfulState(stats.totals.inputTokens)" />
          <MetricCell label="Output Tokens" :value="formatTokens(stats.totals.outputTokens)" :state="truthfulState(stats.totals.outputTokens)" />
          <MetricCell label="Cached Tokens" :value="formatTokens(stats.totals.cachedTokens)" :state="truthfulState(stats.totals.cachedTokens)" />
          <MetricCell label="Reasoning Tokens" :value="formatTokens(stats.totals.reasoningTokens)" :state="truthfulState(stats.totals.reasoningTokens)" />
        </div>

        <!-- codex 账号明细表 -->
        <div v-if="accountRows.length > 0" class="cost-table-wrap">
          <div class="cost-section-heading">
            <span>CODEX ACCOUNTS / COST DETAIL</span>
            <h2>{{ t('desktop.cockpit.accounts') }}</h2>
            <p>{{ t('desktop.cockpit.sorted') }} · {{ planCoverageNote }}</p>
          </div>
          <div class="cost-table-scroll" role="region" :aria-label="t('desktop.cockpit.accountTable')" tabindex="0">
            <table class="cost-table">
              <thead>
                <tr>
                  <th>{{ t('desktop.cockpit.email') }}</th><th>Plan</th><th>{{ t('desktop.cockpit.subscriptionEnd') }}</th>
                  <th class="num">{{ t('desktop.cockpit.requests') }}</th><th class="num">Input</th><th class="num">Output</th><th class="num">{{ t('desktop.cockpit.costUsd') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="a in accountRows" :key="a.accountId">
                  <td><strong>{{ a.email || a.accountId }}</strong><small>{{ a.accountId }}</small></td>
                  <td><span class="cost-badge" :class="planBadgeClass(a.planType)">{{ a.planType || '—' }}</span></td>
                  <td><small>{{ a.subscriptionUntil || '—' }}</small></td>
                  <td class="num">{{ formatInteger(a.usage.requestCount) }}</td>
                  <td class="num">{{ formatTokens(a.usage.inputTokens) }}</td>
                  <td class="num">{{ formatTokens(a.usage.outputTokens) }}</td>
                  <td class="num" :class="a.costIsLowerBound ? 'cost-unknown-value' : costEmphasisClass(a.costUsd)">{{ formatUsd(a.costUsd, 2) }}<small v-if="a.costIsLowerBound" class="cost-muted">{{ t('desktop.cockpit.lowerBound') }}</small><small v-else-if="!a.costIsOurs && a.costUsd != null" class="cost-muted">{{ t('desktop.cockpit.sourceEstimate') }}</small></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usageLocale } from '@/utils/usageFormat'
import { useRouter } from 'vue-router'
import { ArrowLeft, CircleAlert, CircleCheck, RefreshCw, TrendingUp } from '@lucide/vue'
import MetricCell from '@/features/cost-center/components/TruthfulMetric.vue'
import {
  getCockpitConnectionState,
  getCockpitStats,
  getCockpitCodexAccounts,
  getCockpitRequestLogSummary,
  getCockpitLocalAccess,
  type CockpitStats,
  type CockpitConnectionState,
  type CockpitCodexAccount,
} from '@/api/cockpit'
import { errMsg } from '@/stores/connection'
import { cockpitSourceCostOrNull, cockpitSplitCostUsd, isCockpitSentinelZero } from '@/features/cost-center/cockpitAdapter'
import { isUnknownCostBasis } from '@/features/cost-center/costBasis'
import { cockpitEffectivePriceSets, cockpitPriceSetFor } from '@/features/cost-center/cockpitPriceBook'
import { planBadgeClass } from '@/features/cost-center/planBadge'
import { truthfulState } from '@/features/cost-center/honestValues'
import type { DataAvailability } from '@/features/cost-center/dataState'
import { formatNumberLocaleString } from '@/utils/format'

const router = useRouter()
const { t } = useI18n()

const state = ref<CockpitConnectionState | null>(null)
const stats = ref<CockpitStats | null>(null)
const codexAccounts = ref<CockpitCodexAccount[]>([])
const loading = ref(true)
const readError = ref<{ cause: unknown } | null>(null)
const error = computed(() => readError.value == null ? '' : errMsg(readError.value.cause, t('desktop.cockpit.readFailed')))

interface AccountRow {
  accountId: string
  email?: string
  planType?: string
  subscriptionUntil?: string
  usage: CockpitStats['accounts'][number]['usage']
  /** 本项目按价目表自算的累计成本(USD);costIsOurs=false 时是数据源估算。
   *  null = 数据源对该账号报了哨兵 0(有用量、无单价)或没给字段 ⇒ 模板显示「无数据」。 */
  costUsd: number | null
  costIsOurs: boolean
  /** 自算值里有"算不出"的组 ⇒ costUsd 只是下界(模板追加「下界」标注) */
  costIsLowerBound: boolean
  /** 该账号能否在 codex_accounts.json 里匹配到(决定 Plan/订阅到期是否有值) */
  hasPlan: boolean
}
const accountRows = ref<AccountRow[]>([])
/** 本项目自算的总累计成本(USD);null = 单请求用量库不可用或全部组都算不出 */
const selfTotalUsd = ref<number | null>(null)
/**
 * 自算口径的状态 —— 单一事实来源。不能只用一个 `selfTotalUsd: number | null` 表达:
 * "全部算不出"与"库不可用"都会是 null,但**归因完全不同**(前者要标注无单价,后者才是回退数据源)。
 *  · 'ok'          全部组都算得出
 *  · 'partial'     部分组算不出 ⇒ selfTotalUsd 是**下界**
 *  · 'all-unknown' 所有组都算不出 ⇒ selfTotalUsd 为 null
 *  · 'no-db'       单请求用量库不可用/无数据 ⇒ selfTotalUsd 为 null
 */
const selfTotalState = ref<'ok' | 'partial' | 'all-unknown' | 'no-db'>('no-db')

const stateLabel = computed(() => {
  if (state.value === null) return t('desktop.cockpit.checking')
  // 不显示「运行中」:getCockpitConnectionState 的 running 等同 available(只判本地文件可读,
  // 不判进程存活),声称"运行中"等于声称一件没掌握的事。
  if (state.value.available) return t('desktop.cockpit.ready')
  return state.value.reason || t('desktop.cockpit.notInstalled')
})

/**
 * 数据源口径的成本总额。**不是** `stats.totals.estimatedCostUsd` 的裸值 ——
 * cockpit 那个字段是**哨兵 0**:有用量、但模型没匹配到单价时也写 0
 * (源码 `codex_local_access_routing_pricing.rs:1824/:1845` + TS 层
 * `codexWindowStats.ts:104` 的 `?? 0`;本机实测样本见 `cockpitSourceCostOrNull` 的注释)。
 * 判定收在 `cockpitSourceCostOrNull` 一处,本页不自写第二份。
 * null = 拿不到 → 模板渲染「无数据」而不是 `$0.00`。
 */
const sourceTotalUsd = computed<number | null>(() => cockpitSourceCostOrNull(stats.value?.totals))

/** 页面上真正展示的成本:本项目自算优先,否则回退数据源口径(哨兵 0 已在上面置 null)。 */
const displayTotalUsd = computed<number | null>(() => selfTotalUsd.value ?? sourceTotalUsd.value)

/**
 * 成本口径徽章:**两种口径都不是实测**,因此绝不标 measured(避免与真实实测值同外观)。
 * - displayTotalUsd 有值:用量 × 本项目价目表**自算**(或回退数据源估算) → estimated
 * - 连数据源估算都拿不到(字段缺失 / 哨兵 0):不可用 → unavailable
 */
const costState = computed<DataAvailability>(() => (displayTotalUsd.value != null ? 'estimated' : 'unavailable'))

/** 成本口径说明,与 costState 同源分支。★ 各种原因分别说,不共用一句文案 */
const costNote = computed(() => {
  switch (selfTotalState.value) {
    case 'ok': return t('desktop.cockpit.priced')
    case 'partial': return t('desktop.cockpit.partialPriced')
    case 'all-unknown': return sourceTotalUsd.value != null
      ? t('desktop.cockpit.noPricesFallback')
      : t('desktop.cockpit.neitherPrices')
    default: break
  }
  if (sourceTotalUsd.value != null) return t('desktop.cockpit.sourceFallback')
  return isCockpitSentinelZero(stats.value?.totals)
    ? t('desktop.cockpit.sentinelUnknown')
    : t('desktop.cockpit.costMissing')
})

/**
 * 口径标题:不写死「事实成本」。
 * 自算是按本项目价目表推出来的,回退是 cockpit 自带估算 —— 都不该顶着"事实"二字。
 */
const costProvenanceTitle = computed(() => {
  if (selfTotalState.value === 'ok') return t('desktop.cockpit.calculatedTitle')
  if (selfTotalState.value === 'partial') return t('desktop.cockpit.partialTitle')
  if (sourceTotalUsd.value != null) return selfTotalState.value === 'all-unknown'
    ? t('desktop.cockpit.fallbackTitle')
    : t('desktop.cockpit.sourceTitle')
  return t('desktop.cockpit.costUnknown')
})

/** 提示条第二行的口径细节,与 costProvenanceTitle 同源分支
 *  (此前写死成两态,「下界」与「哨兵 0」两种情况都说不清) */
const costProvenanceDetail = computed(() => {
  switch (selfTotalState.value) {
    case 'ok': return t('desktop.cockpit.calculatedDetail')
    case 'partial': return t('desktop.cockpit.partialDetail')
    case 'all-unknown': return t('desktop.cockpit.noPricesDetail')
    default: break
  }
  if (sourceTotalUsd.value != null) {
    return t('desktop.cockpit.sourceDetail')
  }
  return isCockpitSentinelZero(stats.value?.totals)
    ? t('desktop.cockpit.sentinelDetail')
    : t('desktop.cockpit.costMissing')
})

/** 大数的强调色:lime 在本页语义是「实测 / 健康 / 正向」。
 *  只有全部组都自算出来('ok')才配它;下界、全未知、回退数据源、无数据一律中性色。 */
const totalValueClass = computed(() => (selfTotalState.value === 'ok' ? 'cost-emphasis' : 'cost-unknown-value'))

/** 能匹配到 codex_accounts.json 的账号数(Plan/订阅到期的真实覆盖数) */
const planMatchedCount = computed(() => accountRows.value.filter(r => r.hasPlan).length)

/** 表头覆盖率标注:让满屏「—」有解释,而不是让用户自己猜 */
const planCoverageNote = computed(() => {
  const total = accountRows.value.length
  if (total === 0) return t('desktop.cockpit.noPlan')
  return t('desktop.cockpit.planCoverage', { matched: planMatchedCount.value, total })
})

function formatUsd(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(Number(value))) return t('desktop.cockpit.noData')
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}
function formatInteger(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return t('desktop.cockpit.noData')
  return formatNumberLocaleString(Math.round(Number(value)))
}
function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return t('desktop.cockpit.noData')
  const n = Number(value)
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return formatInteger(n)
}
/**
 * 强调色(lime)只给「真的有值」的数字:绿色在本页语义是「实测 / 健康 / 正向」,
 * 「无数据」必须走中性色 cost-unknown-value,绝不能顶着 lime 出现。
 */
function costEmphasisClass(value: unknown): string {
  if (value == null || value === '') return 'cost-unknown-value'
  return Number.isFinite(Number(value)) ? 'cost-emphasis' : 'cost-unknown-value'
}

/** 同格展示多个值:全部有值才算实测,任一缺失一律不可用(避免「0 / 无数据」被当成实测) */
function truthfulStateAll(...values: unknown[]): DataAvailability {
  return values.every(v => truthfulState(v) === 'measured') ? 'measured' : 'unavailable'
}

function formatTime(ts: number | undefined): string {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString(usageLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

async function loadData() {
  loading.value = true
  readError.value = null
  try {
    const [s, st, accounts, cumulative, localAccess] = await Promise.all([
      getCockpitConnectionState(),
      getCockpitStats(),
      getCockpitCodexAccounts(),
      // 累计(全量)口径,不要时间桶:本页只展示汇总与账号明细
      getCockpitRequestLogSummary(1, null, null, false),
      // 用户在 cockpit 里手动配的覆盖价(与成本中心同口径:覆盖价优先于内置价目表)
      getCockpitLocalAccess(),
    ])
    state.value = s
    stats.value = st
    codexAccounts.value = accounts
    if (st) {
      // 本项目价目表(内置价目 + 用户在 cockpit 配的覆盖价) × 分档 token 自算
      const sets = cockpitEffectivePriceSets(localAccess?.modelPricings)
      // ★ 三态桶:逐组记「算得出 / 算不出」,不能只累加 cost ——
      //   `cockpitSplitCostUsd` 在没有该模型单价时返回 cost=0 且 basis='no_price_no_estimate',
      //   只累加就等于把那部分静默当 $0(自算值偏小且看不出偏小)。
      //   规则:全未知 ⇒ null;部分未知 ⇒ 已知部分之和(**真实下界**)+ 标注;全已知 ⇒ 求和。
      const byAccount = new Map<string, { sum: number; known: number; unknown: number }>()
      let total = 0
      let anyKnown = false
      let anyUnknown = false
      if (cumulative?.available && cumulative.groups?.length) {
        for (const g of cumulative.groups) {
          const { cost, costBasis } = cockpitSplitCostUsd(g, cockpitPriceSetFor(sets, g.model), 1)
          const unknown = isUnknownCostBasis(costBasis.kind)
          if (unknown) anyUnknown = true
          else anyKnown = true
          total += cost
          if (g.accountId) {
            const cur = byAccount.get(g.accountId) ?? { sum: 0, known: 0, unknown: 0 }
            cur.sum += cost
            if (unknown) cur.unknown += 1
            else cur.known += 1
            byAccount.set(g.accountId, cur)
          }
        }
        selfTotalUsd.value = anyKnown ? total : null
        selfTotalState.value = anyKnown ? (anyUnknown ? 'partial' : 'ok') : 'all-unknown'
      } else {
        selfTotalUsd.value = null
        selfTotalState.value = 'no-db'
      }
      const planMap = new Map(accounts.map(a => [a.id, a]))
      accountRows.value = st.accounts
        .map(a => {
          const meta = planMap.get(a.accountId)
          const ours = byAccount.get(a.accountId)
          // 一个"算得出"的组都没有 ⇒ 不给数字(0 会冒充"这个账号不花钱")
          const hasOurs = ours != null && ours.known > 0
          return {
            accountId: a.accountId,
            email: a.email || meta?.email,
            planType: meta?.plan_type,
            subscriptionUntil: meta?.subscription_active_until?.slice(0, 10),
            usage: a.usage,
            // 自算优先;没有自算才回退数据源口径(哨兵 0 由 cockpitSourceCostOrNull 置 null)
            costUsd: hasOurs ? ours!.sum : cockpitSourceCostOrNull(a.usage),
            costIsOurs: hasOurs,
            /** 自算值里有"算不出"的组 ⇒ 这个数是**下界**,不是完整成本 */
            costIsLowerBound: hasOurs && ours!.unknown > 0,
            hasPlan: !!meta,
          }
        })
        .sort((x, y) => (y.costUsd ?? -1) - (x.costUsd ?? -1))
    }
  } catch (e) {
    readError.value = { cause: e }
  } finally {
    loading.value = false
  }
}
onMounted(loadData)
</script>

<style scoped>
/* ===== cost 样式体系(从 CostCenterView 内联,保持视觉统一) ===== */
.cost-page {
  --cost-bg: #0d110e;
  --cost-panel: #131814;
  --cost-line: #303830;
  --cost-line-strong: #424d43;
  --cost-muted: #7f8b81;
  --cost-lime: #b9e55a;
  --cost-gold: #dfbc4c;
  --cost-blue: #7eb6d8;
  min-height: 100dvh;
  min-width: 0;
  width: 100%;
  letter-spacing: 0;
  background: var(--cost-bg);
  color: #e4e9e1;
  font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
}

.cost-toolbar {
  position: sticky; z-index: 45; top: 0;
  display: grid; min-height: 94px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: stretch;
  border-bottom: 1px solid var(--cost-line-strong);
  background: rgb(13 17 14 / 96%); backdrop-filter: blur(10px);
}
.cost-brand-block { padding: 12px 22px; }
.cost-eyebrow, .cost-section-heading > span, .cost-page-heading > div > span {
  color: var(--cost-lime); font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10px; letter-spacing: 0;
}
.cost-page-heading { display: flex; min-height: 108px; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 6px 22px; }
.cost-page-heading--compact { min-height: auto; padding: 0; }
.cost-page-heading h2 { margin: 6px 0 0; font-size: 29px; color: #f0f3ed; }
.cost-brand-block p, .cost-section-heading p {
  margin: 5px 0 0; color: var(--cost-muted);
  font-family: 'Cascadia Mono', Consolas, monospace; font-size: 10px;
}

.cost-workspaces { display: flex; align-items: center; gap: 0; border-right: 1px solid var(--cost-line); border-left: 1px solid var(--cost-line); }
.cost-source-toggle { display: flex; align-items: center; gap: 9px; padding: 9px 14px; cursor: pointer; border: 0; background: transparent; color: #89948b; transition: color .15s; }
.cost-source-toggle.active { color: var(--cost-lime); }
.cost-source-name { font-size: 11px; font-family: 'Cascadia Mono', monospace; }

.cockpit-toolbar-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 22px; min-width: 0; }
.cost-refresh-stamp { min-width: 0; overflow-wrap: anywhere; color: #808b82; font: 11px 'Cascadia Mono', monospace; }
.cockpit-refresh { display: inline-flex; width: 36px; height: 36px; flex: 0 0 36px; align-items: center; justify-content: center; border: 1px solid var(--cost-line-strong); border-radius: 4px; background: var(--cost-panel); color: var(--cost-muted); }
.cockpit-refresh:hover:not(:disabled) { color: #e4e9e1; background: #1b211b; }
.cockpit-refresh:disabled { opacity: .45; cursor: default; }
.cost-page :is(button, [tabindex]):focus-visible { outline: 2px solid var(--cost-lime); outline-offset: -2px; }

.cost-body { padding: 18px 22px 40px; min-width: 0; }
.cost-empty { display: grid; place-items: center; gap: 8px; min-height: 240px; color: var(--cost-muted); font-size: 13px; text-align: center; }
.cost-empty small { color: #69746b; font: 10px 'Cascadia Mono', monospace; }
.cost-empty { min-width: 0; overflow-wrap: anywhere; }
.cost-read-error { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 18px; padding: 12px 14px; color: #e39787; border: 1px solid #72483d; background: #30201c; font-size: 12px; overflow-wrap: anywhere; }
.cost-read-error svg { flex-shrink: 0; }
.cost-read-error > div { min-width: 0; }
.cost-read-error small { display: block; margin-top: 5px; color: var(--cost-muted); }

.cost-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; min-width: 0; }
.cost-section-heading { align-self: center; padding: 22px; }
.cost-section-heading h2 { margin: 8px 0 0; font-size: 22px; color: #f0f3ed; }

.cost-unified-total { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 22px; min-width: 0; align-items: stretch; border: 1px solid var(--cost-line); background: var(--cost-panel); }
.cost-donut-wrap { display: grid; place-items: center; }
.cost-donut { display: grid; width: 140px; height: 140px; place-items: center; border-radius: 50%; }
.cost-donut > div { display: grid; width: 102px; height: 102px; place-items: center; align-content: center; border-radius: 50%; background: var(--cost-panel); }
.cost-donut strong { max-width: 100%; overflow-wrap: anywhere; text-align: center; font: 700 17px/1.25 'Cascadia Mono', monospace; }
.cost-donut span { margin-top: 5px; color: var(--cost-muted); font-size: 10px; }
.cost-donut--unified { width: 170px; height: 170px; background: radial-gradient(circle, rgb(185 229 90 / 28%), transparent 70%); }
.cost-donut--unified > div { width: 128px; height: 128px; }
.cost-donut--unified strong { font-size: 22px; }

.cost-metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); min-width: 0; border-left: 1px solid var(--cost-line); }
.cost-metric-grid--tokens { border: 1px solid var(--cost-line); background: var(--cost-panel); }

/* TruthfulMetric 的 cost-metric-cell 布局(组件 scoped 里只放组件自身规则,这里补栅格 / 边框)。
   Vue scoped CSS 只把父组件的 scope id 打在子组件的根元素上,所以只有末位落在根元素本身
   或其伪元素上的规则才生效 —— 下面 .cost-metric-cell / :last-child / ::before / .accent-*::before 都属于这类。
   反之,末位落在子组件内部元素(span / strong / small / .cost-metric-cell__state)的规则永不匹配:
   原先的 `.cost-metric-cell > span` / `> strong` / `> small` / `.accent-* > strong` / `.cost-metric-cell__state`
   已全部移入 TruthfulMetric.vue 内实现(组件自己的 scope id 会正确落在内部元素上),不要再在这里补写。
   注意:下面的 .accent-*::before 左色条虽是活规则,但 accent 类只在该格 state === 'measured' 时由组件绑定,
   所以「无数据 / 不可用 / 估算 / 旧数据」的格子不会带强调色。 */
.cost-metric-cell { position: relative; display: flex; min-width: 0; flex-direction: column; justify-content: center; padding: 13px 16px; border-right: 1px solid var(--cost-line); border-bottom: 1px solid var(--cost-line); }
.cost-metric-cell:last-child { border-right: 0; }
.cost-metric-cell::before { position: absolute; top: 0; bottom: 0; left: 0; width: 2px; content: ''; background: transparent; }
.cost-metric-cell.accent-lime::before { background: var(--cost-lime); }
.cost-metric-cell.accent-gold::before { background: var(--cost-gold); }
.cost-metric-cell.accent-blue::before { background: var(--cost-blue); }

.cost-provenance-strip { display: flex; flex-wrap: wrap; gap: 18px; padding: 14px 16px; background: var(--cost-panel); border: 1px solid var(--cost-line); }
.cost-provenance-strip > div { display: grid; grid-template-columns: 18px minmax(0, 1fr); flex: 1 1 260px; gap: 8px; min-width: 0; }
.cost-provenance-strip svg { grid-row: 1 / span 2; color: var(--cost-lime); }
.cost-provenance-strip strong { font-size: 10px; color: #e4e9e1; }
.cost-provenance-strip span { margin-top: 3px; color: var(--cost-muted); font-size: 9px; overflow-wrap: anywhere; }

.cost-table-wrap { min-width: 0; border: 1px solid var(--cost-line); background: var(--cost-panel); }
.cost-table-wrap .cost-section-heading { padding: 14px 16px; }
.cost-table-scroll { min-width: 0; max-width: 100%; max-height: 460px; overflow: auto; }
.cost-table { width: 100%; min-width: 880px; border-collapse: collapse; font-size: 11px; }
.cost-table th { position: sticky; top: 0; z-index: 2; height: 40px; padding: 0 12px; color: #77847a; background: #202720; border-bottom: 1px solid #2d352e; text-align: left; font-weight: 500; }
.cost-table th.num, .cost-table td.num { text-align: right; font-family: 'Cascadia Mono', Consolas, monospace; }
.cost-table td { padding: 9px 12px; border-bottom: 1px solid #293129; vertical-align: middle; overflow-wrap: anywhere; }
.cost-table td strong { display: block; color: #e4e9e1; font: 600 11px 'Cascadia Mono', monospace; }
.cost-table td small { display: block; margin-top: 3px; color: #69756b; font: 9px 'Cascadia Mono', monospace; }
.cost-table tbody tr:hover { background: rgb(185 229 90 / 4%); }
.cost-emphasis { color: var(--cost-lime); font-weight: 700; }
/* 甜甜圈中央大数与表格成本列共用同一对类:有值才给 lime,空 / 无数据走中性色。 */
.cost-donut strong.cost-emphasis { color: var(--cost-lime); }
/* 「无从判断」统一中性色。!important 是必需的:.cost-donut--unified strong(0-2-1) 等规则
   特异性高于本类(0-2-0),否则「无数据」会退化成与正常值同色,中性色契约形同虚设。 */
.cost-unknown-value { color: #9aa79b !important; }
.cost-badge { display: inline-block; padding: 3px 8px; font: 9px 'Cascadia Mono', monospace; border: 1px solid var(--cost-line-strong); }
.cost-badge.plan-plus { color: #c9a3e8; border-color: #6b4a8a; }
.cost-badge.plan-team { color: #79b6d9; border-color: #3a5a7a; }
.cost-badge.plan-API_KEY { color: var(--cost-gold); border-color: #7a6438; }
.cost-badge.plan-k12 { color: var(--cost-lime); border-color: #5a7a3a; }
.cost-badge.plan-unknown { color: var(--cost-muted); }

@media (max-width: 1180px) {
  .cost-unified-total { grid-template-columns: minmax(0, 1fr); }
  .cost-metric-grid--tokens { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .cost-toolbar { grid-template-columns: minmax(0, 1fr) auto; }
  .cost-brand-block { grid-column: 1/-1; }
  .cost-workspaces { border-left: 0; border-right: 0; padding-left: 8px; }
  .cockpit-toolbar-actions { padding: 8px 16px; }
  .cost-body { padding: 18px 16px 32px; }
  .cost-metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.cost-brand-block,.cost-page-heading>div,.cost-section-heading{min-width:0;overflow-wrap:anywhere}.cost-workspaces svg{flex-shrink:0}.cockpit-spin{animation:cockpit-spin 1s linear infinite}@keyframes cockpit-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.cockpit-spin{animation:none}}
</style>
