/**
 * ④ usageWindow 三态(per-field known/unknown)—— 2026-09-21 回归修复
 *
 * ## 修的是什么(过度修正回归)
 * `aggregateUsageWindow` 此前写成 `point.cost = addNullableCost(point.cost, nullableNumber(log.total_cost))`,
 * 而 `addNullableCost` 是「任一侧 null ⇒ null」。于是同桶 `[total_cost=3, total_cost=null]`
 * ⇒ `cost === null` —— 一条 NULL 把整桶**已知的真实成本**一起吞掉。那既不是诚实降级(数值是
 * 真实下界,不是"无数据"),也让 W2 的「部分未知 ⇒ 保留下界 + source_estimate」那一态
 * 在 sub2api 路径上永远不出现(financialTrend.costPartial 在 sub2api 下恒 false)。
 *
 * ## 规则(照 W2 已确立的三态规则,不另立)
 * 每个桶分别跟踪 `total_cost` / `actual_cost` / `account_cost` **三个字段各自的** known / unknown:
 *   全未知            ⇒ 该字段 null,桶 costBasis = no_price_no_estimate
 *   部分未知          ⇒ 已知部分之和(**真实下界**),桶 costBasis = source_estimate
 *   全部有值          ⇒ 求和,桶 costBasis = priced
 * 桶级 costBasis 取三个字段里**更差**的一侧(worstCostBasisKind)。
 *
 * 本文件同时充当 `mergeTrendPoint` 取更差一侧 / `addNullableCost` null 传播的**第二道防线**:
 * 它们原先只有 `fillCostTrendBuckets` 一条入口(见 sentinelZeroChains.spec.ts),这里改走
 * `aggregateUsageWindow` 这条不同入口。
 */
import { describe, expect, it } from 'vitest'
import type { AdminUsageLog } from '@/types'
import { aggregateUsageWindow } from '../usageWindow'

function usage(overrides: Partial<AdminUsageLog>): AdminUsageLog {
  return {
    id: 1,
    user_id: 1,
    api_key_id: 1,
    account_id: 1,
    request_id: 'req-1',
    model: 'gpt-5',
    group_id: 1,
    subscription_id: null,
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_tokens: 2,
    cache_read_tokens: 3,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    input_cost: 0.1,
    output_cost: 0.2,
    cache_creation_cost: 0.01,
    cache_read_cost: 0.01,
    total_cost: 0.32,
    actual_cost: 0.4,
    rate_multiplier: 1,
    long_context_billing_applied: false,
    billing_type: 0,
    stream: false,
    duration_ms: 100,
    first_token_ms: 50,
    image_count: 0,
    image_size: null,
    image_input_size: null,
    image_output_size: null,
    image_size_source: null,
    image_size_breakdown: null,
    image_input_tokens: 0,
    image_input_cost: 0,
    image_output_tokens: 0,
    image_output_cost: 0,
    user_agent: 'test',
    cache_ttl_overridden: false,
    created_at: '2026-08-05T12:03:20.000Z',
    ...overrides,
  }
}

/** 固定 30 分钟窗口(range '30m' ⇒ 桶 60s);两条日志落在同一分钟桶。 */
const START = new Date('2026-08-05T11:35:00.000Z')
const END = new Date('2026-08-05T12:05:00.000Z')
const SAME_BUCKET_A = '2026-08-05T12:03:20.000Z'
const SAME_BUCKET_B = '2026-08-05T12:03:40.000Z'

/** 跑聚合后取**有请求的那个桶**(其余是补齐的空桶,语义是既有行为,不在本文件断言范围)。 */
function onlyBucket(logs: AdminUsageLog[]) {
  const points = aggregateUsageWindow(logs, '30m', START, END)
  const hit = points.filter((point) => point.requests > 0)
  expect(hit).toHaveLength(1)
  return hit[0]!
}

describe('④ usageWindow 三态:一条 NULL 不再吞掉整桶真实成本', () => {
  it('total_cost 字段:同桶 [3, null] ⇒ cost = 3(真实下界)且 costBasis = source_estimate', () => {
    const point = onlyBucket([
      usage({ created_at: SAME_BUCKET_A, total_cost: 3, actual_cost: 5, account_stats_cost: 1, account_rate_multiplier: 1 }),
      usage({ id: 2, created_at: SAME_BUCKET_B, total_cost: null, actual_cost: 5, account_stats_cost: 1, account_rate_multiplier: 1 }),
    ])
    expect(point.cost).toBe(3)
    expect(point.cost).not.toBeNull()
    expect(point.costBasis).toBe('source_estimate')
    // 另两个字段全有值 ⇒ 照常求和(不被更差的 cost 拖成 null)
    expect(point.actual_cost).toBe(10)
    expect(point.account_cost).toBe(2)
  })

  it('actual_cost 字段:同桶 [3, null] ⇒ actual_cost = 3 且 costBasis = source_estimate', () => {
    const point = onlyBucket([
      usage({ created_at: SAME_BUCKET_A, actual_cost: 3, total_cost: 5, account_stats_cost: 1, account_rate_multiplier: 1 }),
      usage({ id: 2, created_at: SAME_BUCKET_B, actual_cost: null, total_cost: 5, account_stats_cost: 1, account_rate_multiplier: 1 }),
    ])
    expect(point.actual_cost).toBe(3)
    expect(point.actual_cost).not.toBeNull()
    expect(point.costBasis).toBe('source_estimate')
    expect(point.cost).toBe(10)
    expect(point.account_cost).toBe(2)
  })

  it('account_cost 字段:同桶一条可算一条不可算 ⇒ account_cost = 3(下界),而 cost 全未知 ⇒ null', () => {
    // accountCost(log) 在 account_stats_cost 缺时回退 total_cost,所以让两条的 total_cost 都为 null
    // 才能构造出「account_cost 部分未知」。这条同时证明三个字段**各自**记账(一个 flag 混用会把
    // account_cost 也一起吞成 null)。
    const point = onlyBucket([
      usage({ created_at: SAME_BUCKET_A, total_cost: null, actual_cost: 5, account_stats_cost: 3, account_rate_multiplier: 1 }),
      usage({ id: 2, created_at: SAME_BUCKET_B, total_cost: null, actual_cost: 5, account_stats_cost: null, account_rate_multiplier: 1 }),
    ])
    expect(point.account_cost).toBe(3)
    expect(point.account_cost).not.toBeNull()
    // cost 字段两条都缺 ⇒ 全未知 ⇒ null(图表断点)
    expect(point.cost).toBeNull()
    // 桶级取更差一侧:no_price_no_estimate 比 source_estimate 更差
    expect(point.costBasis).toBe('no_price_no_estimate')
  })

  it('三个字段全未知 ⇒ 三个都是 null 且 costBasis = no_price_no_estimate', () => {
    const point = onlyBucket([
      usage({ created_at: SAME_BUCKET_A, total_cost: null, actual_cost: null, account_stats_cost: null }),
      usage({ id: 2, created_at: SAME_BUCKET_B, total_cost: null, actual_cost: null, account_stats_cost: null }),
    ])
    expect(point.cost).toBeNull()
    expect(point.actual_cost).toBeNull()
    expect(point.account_cost).toBeNull()
    expect(point.costBasis).toBe('no_price_no_estimate')
    // 请求数/Token 是实测值,照常给出
    expect(point.requests).toBe(2)
  })

  it('三个字段全有值 ⇒ 求和且 costBasis = priced', () => {
    const point = onlyBucket([
      usage({ created_at: SAME_BUCKET_A, total_cost: 3, actual_cost: 5, account_stats_cost: 1, account_rate_multiplier: 1 }),
      usage({ id: 2, created_at: SAME_BUCKET_B, total_cost: 4, actual_cost: 6, account_stats_cost: 2, account_rate_multiplier: 1 }),
    ])
    expect(point.cost).toBe(7)
    expect(point.actual_cost).toBe(11)
    expect(point.account_cost).toBe(3)
    expect(point.costBasis).toBe('priced')
  })

  it('成对:真实 0 ⇒ 仍是 0(不是 null),costBasis = priced(不误伤"实测零成本")', () => {
    const point = onlyBucket([
      usage({ created_at: SAME_BUCKET_A, total_cost: 0, actual_cost: 0, account_stats_cost: 0, account_rate_multiplier: 1 }),
      usage({ id: 2, created_at: SAME_BUCKET_B, total_cost: 0, actual_cost: 0, account_stats_cost: 0, account_rate_multiplier: 1 }),
    ])
    expect(point.cost).toBe(0)
    expect(point.cost).not.toBeNull()
    expect(point.actual_cost).toBe(0)
    expect(point.account_cost).toBe(0)
    expect(point.costBasis).toBe('priced')
  })
})

describe('⑦ 第二道防线:mergeTrendPoint 取更差一侧 / addNullableCost null 传播(走 aggregateUsageWindow 入口)', () => {
  it('mergeTrendPoint 取更差一侧:部分未知 ⇒ 结果点仍是 source_estimate(下界不被当成确定值)', () => {
    const point = onlyBucket([
      usage({ created_at: SAME_BUCKET_A, total_cost: 2, actual_cost: 2, account_stats_cost: 2, account_rate_multiplier: 1 }),
      usage({ id: 2, created_at: SAME_BUCKET_B, total_cost: null, actual_cost: 2, account_stats_cost: 2, account_rate_multiplier: 1 }),
    ])
    expect(point.costBasis).toBe('source_estimate')
    expect(point.cost).toBe(2)
  })

  it('addNullableCost null 传播:同桶全未知 ⇒ 结果点 cost === null(0 + null 仍是 null,不补 0)', () => {
    const point = onlyBucket([
      usage({ created_at: SAME_BUCKET_A, total_cost: null, actual_cost: 1, account_stats_cost: 1, account_rate_multiplier: 1 }),
      usage({ id: 2, created_at: SAME_BUCKET_B, total_cost: null, actual_cost: 1, account_stats_cost: 1, account_rate_multiplier: 1 }),
    ])
    expect(point.cost).toBeNull()
    expect(point.cost).not.toBe(0)
    // 成对:有值的字段不受影响
    expect(point.actual_cost).toBe(2)
  })
})
