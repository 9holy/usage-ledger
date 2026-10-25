import { costDataText } from './costDataText'
export type DataAvailability =
  | 'loading'
  | 'measured'
  | 'estimated'
  | 'empty'
  | 'partial'
  | 'unavailable'
  | 'stale'

export type CostCenterSourceKey =
  | 'accounts'
  | 'costLoss'
  | 'dashboard'
  | 'todayStats'
  | 'rangeStats'
  | 'accountUsage'
  | 'models'
  | 'modelRoutes'
  | 'modelAudit'
  | 'pricing'
  | 'ops'
  | 'settings'
  | 'exchangeRate'
  | 'economics'

export interface DataSourceState {
  key: CostCenterSourceKey
  label: string
  status: DataAvailability
  reason: string
  updatedAt: string | null
}

const SOURCE_LABELS: Record<CostCenterSourceKey, string> = {
  get accounts() { return costDataText('accountsAndScheduling') },
  get costLoss() { return costDataText('terminalLossLedger') },
  get dashboard() { return costDataText('usageRecordsAndCostTrends') },
  get todayStats() { return costDataText('accountUsageToday') },
  get rangeStats() { return costDataText('accountUsageInThisWindow') },
  get accountUsage() { return costDataText('upstreamQuotaWindows') },
  get models() { return costDataText('modelCostStatistics') },
  get modelRoutes() { return costDataText('modelRouteRecords') },
  get modelAudit() { return costDataText('modelAuditResponseDeclaredModel') },
  get pricing() { return costDataText('modelPriceCatalog') },
  get ops() { return costDataText('operationalQuality') },
  get settings() { return costDataText('schedulerSettings') },
  get exchangeRate() { return costDataText('usdToCnyExchangeRate') },
  get economics() { return costDataText('economicSamplesAndForecasts') },
}

export const COST_CENTER_SOURCE_KEYS = Object.keys(SOURCE_LABELS) as CostCenterSourceKey[]

export function createDataSourceStates(status: DataAvailability = 'loading'): Record<CostCenterSourceKey, DataSourceState> {
  return Object.fromEntries(COST_CENTER_SOURCE_KEYS.map((key) => [key, {
    key,
    get label() { return SOURCE_LABELS[key] },
    status,
    get reason() { return status === 'loading' ? costDataText('readingData') : '' },
    updatedAt: null,
  }])) as Record<CostCenterSourceKey, DataSourceState>
}

export function sourceState(
  key: CostCenterSourceKey,
  status: DataAvailability,
  reason: string | (() => string) = '',
  updatedAt: Date | null = status === 'loading' ? null : new Date(),
): DataSourceState {
  return {
    key,
    get label() { return SOURCE_LABELS[key] },
    status,
    get reason() { return typeof reason === 'function' ? reason() : reason },
    updatedAt: updatedAt?.toISOString() ?? null,
  }
}

export function hasUsableData(state: DataSourceState | undefined): boolean {
  return state != null && ['measured', 'estimated', 'empty', 'partial', 'stale'].includes(state.status)
}

export function hasMeasuredData(state: DataSourceState | undefined): boolean {
  return state != null && ['measured', 'empty', 'partial', 'stale'].includes(state.status)
}

export function dataAvailabilityLabel(status: DataAvailability): string {
  return ({
    get loading() { return costDataText('loading') },
    get measured() { return costDataText('measured') },
    get estimated() { return costDataText('estimated') },
    get empty() { return costDataText('noRecords') },
    get partial() { return costDataText('partiallyAvailable') },
    get unavailable() { return costDataText('unavailable') },
    get stale() { return costDataText('staleData') },
  })[status]
}

export function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * 趋势值合计:过滤掉 null/非有限值后求和;**全为空**时才返回 null。
 *
 * ★ 2026-09-27(Bug B 修复,用户反馈"月数据很多没有"):
 *   旧实现在**任一**值为 null 时整笔返回 null。30d 窗口实测有 10 个无单价的桶
 *   (`actual_cost` = null,源既无本地单价也无估算),于是「窗口自算成本 / 毛利 /
 *   每 USD 采购 / 回本率」等一整排 KPI 全部渲染成「无数据」——而同一屏的趋势图、
 *   模型表明明有数,自相矛盾。
 *
 *   这与 `costBasis` 的**三态桶**规则是同一条(见 MEMORY.md 成本中心红线):
 *   全未知 ⇒ null;部分未知 ⇒ **已知部分之和**(它是真实的**下界**,丢掉是误伤)。
 *   本函数是"部分未知"在趋势合计上的唯一落地入口。
 *
 * 语义边界:`values` 为空数组 ⇒ null(没有可加的量,不是"和为 0")。
 */
export function sumFiniteTrendValues(values: unknown[]): number | null {
  const nonNull = values.map(finiteOrNull).filter((value): value is number => value != null)
  return nonNull.length === 0 ? null : nonNull.reduce((sum, value) => sum + value, 0)
}

export function unavailableValueLabel(state?: DataSourceState): string {
  if (!state) return costDataText('noData')
  if (state.status === 'loading') return costDataText('loading')
  if (state.status === 'empty') return costDataText('noRecords')
  if (state.status === 'stale') return costDataText('staleData')
  return costDataText('noData')
}

/**
 * 「号池运行状态」的数据状态 —— **三态穷举**(cliproxy / cockpit / sub2api),单一入口。
 *
 * 为什么必须是三态:`partial` 在本格只由「有账号未主动探测」产生,而**探测能力三源不同** ——
 * sub2api 走 `adminAPI.testAccount`;cliproxy 走 CPA **历史**延迟;
 * **cockpit 是本地用量采集源,没有探测通道**。
 * 写成 `connectionType === 'cliproxy' ? A : B` 会把 cockpit 当成 sub2api ⇒
 * 它的「号池运行状态」永久 `partial` + 「N 个未主动探测」,而那个 N 恒等于账号总数。
 * 这是**结构性做不到**,不是「还没做」—— 与「源不支持采样 ≠ 待采样」同一条口径。
 *
 * 做成纯函数而不是视图里的 computed,是为了让这条契约能被**直接测**(见 `dataState.test.ts`),
 * 而不是靠扫源码文本 —— 文本扫描抓不住 `computed(() => true)` 这种语义改动。
 */
export function poolHealthStateFor(input: {
  source: 'sub2api' | 'cliproxy' | 'cockpit'
  cliproxyRequestTotal: number
  unverifiedProbeCount: number
  /** `accountEconomics` 不存在时为 `null`(该源没有经济学快照)。 */
  economicsStatus: DataAvailability | null
  accountsStatus: DataAvailability
}): DataAvailability {
  if (input.source === 'cliproxy') return input.cliproxyRequestTotal > 0 ? 'measured' : 'unavailable'
  // 只有**有探测通道的源**才可能因为「还没探测」而处于 partial。
  if (input.source !== 'cockpit' && input.unverifiedProbeCount > 0) return 'partial'
  return input.economicsStatus ?? input.accountsStatus
}

/**
 * 「N 个未主动探测」这句话的**单一措辞入口** —— 只对**有探测通道的源**成立。
 * cockpit 结构性做不到,不得声称它「还没探测」。
 */
export function probeAvailabilityNote(
  source: 'sub2api' | 'cliproxy' | 'cockpit',
  unverifiedCount: number,
): string {
  return source === 'cockpit' ? costDataText('theLocalCollectorHasNoActiveProbeChannel') : costDataText('accountsHaveNotBeenActivelyProbed', { p0: unverifiedCount })
}
