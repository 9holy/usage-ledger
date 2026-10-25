import { costDataText } from './costDataText'
import type { TrendDataPoint } from '@/types'
import type { SourceAdminUsageLog as AdminUsageLog } from './sourceTypes'
import type { CostBasisKind } from './costBasis'
import { worstCostBasisKind } from './costBasis'
import type { CostCenterRange } from './useCostCenterData'
import { accountCostSnapshot, sumTokenCounts, uniqueUsageLogs } from './modelCostAnalysis'

export interface CostTrendDataPoint extends Omit<TrendDataPoint, 'cost' | 'actual_cost' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens' | 'total_tokens'> {
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens?: number | null
  total_tokens: number | null
  cost: number | null
  actual_cost: number | null
  account_cost?: number | null
  /** 本桶成本的计价依据。`no_price_no_estimate` = 桶内**全部**模型无单价且源无估算
   *  ⇒ cost/actual_cost/account_cost 均为 null(图表断点),不得补 0。
   *  `source_estimate` = 桶内**部分**模型无单价 ⇒ 数值只是下界,展示层必须标注「部分模型无单价」。
   *  省略 = 全部有单价。 */
  costBasis?: CostBasisKind
}

/** null 安全加法:任一侧为 null(未知)⇒ 结果 null。**不得**用 `|| 0` 把未知当 0 参与累加。 */
function addNullableCost(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left == null || right == null) return null
  return left + right
}

/** null/空/非有限 → null。**不要**用 `Number(x || 0)`:那会把"该源不掌握"静默变成真实 0。 */
function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const RANGE_MILLISECONDS: Record<CostCenterRange, number> = {
  today: 24 * 60 * 60 * 1000,
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

export const TREND_BUCKET_MILLISECONDS: Record<CostCenterRange, number> = {
  today: 15 * 60 * 1000,
  '1m': 5 * 1000,
  '5m': 15 * 1000,
  '30m': 60 * 1000,
  '1h': 60 * 1000,
  '6h': 5 * 60 * 1000,
  '24h': 15 * 60 * 1000,
  '7d': 2 * 60 * 60 * 1000,
  '30d': 6 * 60 * 60 * 1000,
}

/** 窗口中文名(单一来源:视图标签与 store 状态文案共用,避免两套映射漂移)。 */
export const COST_CENTER_RANGE_LABELS: Record<CostCenterRange, string> = {
  get today() { return costDataText('today') },
  get '1m'() { return costDataText('last1Minute') },
  get '5m'() { return costDataText('last5Minutes') },
  get '30m'() { return costDataText('last30Minutes') },
  get '1h'() { return costDataText('last1Hour') },
  get '6h'() { return costDataText('last6Hours') },
  get '24h'() { return costDataText('last24Hours') },
  get '7d'() { return costDataText('last7Days') },
  get '30d'() { return costDataText('last30Days') },
}

export function costCenterRangeLabel(range: CostCenterRange): string {
  return COST_CENTER_RANGE_LABELS[range] ?? range
}

export function costTrendBucketHours(range: CostCenterRange): number {
  return TREND_BUCKET_MILLISECONDS[range] / (60 * 60 * 1000)
}

export function usageWindowBounds(range: CostCenterRange, end = new Date()): { start: Date; end: Date } {
  if (range === 'today') {
    const start = new Date(end)
    start.setHours(0, 0, 0, 0)
    const calendarEnd = new Date(start)
    calendarEnd.setDate(calendarEnd.getDate() + 1)
    return { start, end: calendarEnd }
  }
  return {
    start: new Date(end.getTime() - RANGE_MILLISECONDS[range]),
    end,
  }
}

export interface UsageQueryWindow { start: Date; end: Date }

/** Query/sample bounds, not the first and last observed requests, define a rate interval. */
export function usageWindowHours(window: UsageQueryWindow | null, coverage: UsageQueryWindow | null = window): number | null {
  if (!window || !coverage) return null
  const start = Math.max(window.start.getTime(), coverage.start.getTime())
  const end = Math.min(window.end.getTime(), coverage.end.getTime())
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 3_600_000 : null
}

export function usageWindowRate(amount: number | null, window: UsageQueryWindow | null, coverage: UsageQueryWindow | null = window): number | null {
  const hours = usageWindowHours(window, coverage)
  return amount == null || !Number.isFinite(amount) || hours == null ? null : amount / hours
}

export function usageBucketHours(timestamp: string, bucketHours: number, window: UsageQueryWindow | null): number | null {
  if (!Number.isFinite(bucketHours) || bucketHours <= 0) return null
  const start = parseTrendDate(timestamp)
  return usageWindowHours({ start, end: new Date(start.getTime() + bucketHours * 3_600_000) }, window)
}

export function localDateParameter(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function bucketStart(value: Date, range: CostCenterRange): Date {
  const size = TREND_BUCKET_MILLISECONDS[range]
  return new Date(Math.floor(value.getTime() / size) * size)
}

export function parseTrendDate(value: string): Date {
  const utcParts = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):?(\d{2})?:?(\d{2})?)?$/)
  if (utcParts) {
    // Sub2API's dashboard SQL formats timestamptz buckets without an offset.
    // PostgreSQL stores and aggregates those values in UTC, so interpreting the
    // string as browser-local time shifts every point and can filter the entire
    // series out of a rolling window.
    return new Date(Date.UTC(
      Number(utcParts[1]),
      Number(utcParts[2]) - 1,
      Number(utcParts[3]),
      Number(utcParts[4] ?? 0),
      Number(utcParts[5] ?? 0),
      Number(utcParts[6] ?? 0),
    ))
  }
  return new Date(value)
}

function emptyTrendPoint(date: Date): CostTrendDataPoint {
  return {
    date: date.toISOString(),
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    cost: 0,
    actual_cost: 0,
    account_cost: 0,
  }
}

function mergeTrendPoint(target: CostTrendDataPoint, source: CostTrendDataPoint): void {
  target.requests += Number(source.requests || 0)
  target.input_tokens = sumTokenCounts(target.input_tokens, source.input_tokens)
  target.output_tokens = sumTokenCounts(target.output_tokens, source.output_tokens)
  target.cache_creation_tokens = sumTokenCounts(target.cache_creation_tokens, source.cache_creation_tokens)
  target.cache_read_tokens = sumTokenCounts(target.cache_read_tokens, source.cache_read_tokens)
  target.total_tokens = sumTokenCounts(target.total_tokens, source.total_tokens)
  // 成本 null 传播:任一侧未知 ⇒ 合并结果未知(null + 已知 ≠ 已知)。
  target.cost = addNullableCost(target.cost, source.cost)
  target.actual_cost = addNullableCost(target.actual_cost, source.actual_cost)
  target.account_cost = addNullableCost(target.account_cost ?? null, source.account_cost ?? null)
  // basis 取更差一侧:任一子项算不出来 ⇒ 整桶不能标成"已计价"。
  target.costBasis = worstCostBasisKind(target.costBasis, source.costBasis)
}

export function fillCostTrendBuckets(
  points: CostTrendDataPoint[],
  range: CostCenterRange,
  start: Date,
  end: Date,
): CostTrendDataPoint[] {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) return []

  const bucketMilliseconds = TREND_BUCKET_MILLISECONDS[range]
  const firstBucket = bucketStart(start, range)
  const lastBucket = bucketStart(new Date(end.getTime() - 1), range)
  const buckets = new Map<number, CostTrendDataPoint>()

  for (const point of points) {
    const parsed = parseTrendDate(point.date)
    if (!Number.isFinite(parsed.getTime())) continue
    const bucket = bucketStart(parsed, range)
    const key = bucket.getTime()
    if (key < firstBucket.getTime() || key > lastBucket.getTime()) continue
    const merged = buckets.get(key) ?? emptyTrendPoint(bucket)
    mergeTrendPoint(merged, point)
    buckets.set(key, merged)
  }

  const result: CostTrendDataPoint[] = []
  for (let cursor = firstBucket.getTime(); cursor <= lastBucket.getTime(); cursor += bucketMilliseconds) {
    result.push(buckets.get(cursor) ?? emptyTrendPoint(new Date(cursor)))
  }
  return result
}

/** 单字段三态累加账:known / unknown **分开**计数,已知部分单独求和(可作真实下界)。
 *  三个成本字段必须各持一份账 —— 它们可以独立缺失(如 total_cost 有值而 actual_cost 缺)。 */
interface FieldTally {
  known: number
  unknown: number
  sum: number
}

/** 记一笔:值缺失 ⇒ unknown++;有值 ⇒ known++ 并累加。**不得**把缺失当 0 参与求和。 */
function tallyField(tally: FieldTally, value: number | null): void {
  if (value == null) {
    tally.unknown += 1
    return
  }
  tally.known += 1
  tally.sum += value
}

/** 字段三态取值:全未知 ⇒ null(图表断点);有已知 ⇒ 已知部分之和(部分未知时它是**真实下界**)。 */
function fieldValue(tally: FieldTally): number | null {
  return tally.unknown > 0 && tally.known === 0 ? null : tally.sum
}

/** 字段计价依据:全未知 ⇒ no_price_no_estimate;部分未知 ⇒ source_estimate(数值只是下界);全有值 ⇒ priced。 */
function fieldKind(tally: FieldTally): CostBasisKind {
  if (tally.unknown === 0) return 'priced'
  return tally.known > 0 ? 'source_estimate' : 'no_price_no_estimate'
}

function newFieldTally(): FieldTally {
  return { known: 0, unknown: 0, sum: 0 }
}

export function aggregateUsageWindow(
  logs: AdminUsageLog[],
  range: CostCenterRange,
  start: Date,
  end: Date,
): CostTrendDataPoint[] {
  const startMs = start.getTime()
  const endMs = end.getTime()
  const buckets = new Map<number, {
    point: CostTrendDataPoint
    cost: FieldTally
    actual: FieldTally
    account: FieldTally
  }>()

  for (const log of uniqueUsageLogs(logs)) {
    const createdAt = parseTrendDate(log.created_at)
    const timestamp = createdAt.getTime()
    if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp >= endMs) continue

    const bucket = bucketStart(createdAt, range)
    const key = bucket.getTime()
    let entry = buckets.get(key)
    if (!entry) {
      entry = {
        point: {
          date: bucket.toISOString(),
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
          cost: 0,
          actual_cost: 0,
          account_cost: 0,
        },
        cost: newFieldTally(),
        actual: newFieldTally(),
        account: newFieldTally(),
      }
      buckets.set(key, entry)
    }

    const { point } = entry
    point.requests += 1
    point.input_tokens = sumTokenCounts(point.input_tokens, log.input_tokens)
    point.output_tokens = sumTokenCounts(point.output_tokens, log.output_tokens)
    point.cache_creation_tokens = sumTokenCounts(point.cache_creation_tokens, log.cache_creation_tokens)
    point.cache_read_tokens = sumTokenCounts(point.cache_read_tokens, log.cache_read_tokens)
    point.total_tokens = sumTokenCounts(point.total_tokens, log.input_tokens, log.output_tokens, log.cache_creation_tokens, log.cache_read_tokens)
    // 三个成本字段**各自**记三态账(此前用 addNullableCost 逐笔「任一侧 null ⇒ null」,
    // 一条 NULL 会把整桶已知成本一起吞掉 —— 那是过度修正,不是诚实降级)。
    tallyField(entry.cost, nullableNumber(log.total_cost))
    tallyField(entry.actual, nullableNumber(log.actual_cost))
    tallyField(entry.account, accountCostSnapshot(log))
  }

  // 三态收口(照 W2 已确立规则,与 cockpit 用量库桶同规则):
  //   全未知 ⇒ 该字段 null(图表断点);部分未知 ⇒ 已知部分之和(**真实下界**)+ source_estimate;
  //   全有值 ⇒ 求和 + priced。桶级 costBasis 取三个字段里**更差**的一侧。
  const points: CostTrendDataPoint[] = []
  for (const { point, cost, actual, account } of buckets.values()) {
    point.cost = fieldValue(cost)
    point.actual_cost = fieldValue(actual)
    point.account_cost = fieldValue(account)
    point.costBasis = worstCostBasisKind(fieldKind(cost), fieldKind(actual), fieldKind(account))
    points.push(point)
  }

  return fillCostTrendBuckets(points, range, start, end)
}
