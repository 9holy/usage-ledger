/**
 * ③ `summarizeModelAudit` 的 `mismatchStandardCost` 单独漏了 null 传播 —— 2026-09-21
 *
 * 同一个 reduce 里,紧邻的 `mismatchAccountCost` 与 `mismatchRevenue` 都做了 null 传播
 * (`null !== null` 才累加,缺失即置 null),只有 `mismatchStandardCost += finiteNumber(log.total_cost)`
 * 没做:`total_cost` 缺失时写 0 —— 界面「替换请求成本」的 note 渲染 `标准 $0.000000`,
 * 而 cockpit 源下适配器已把 `total_cost` 置 null(该格可达)。
 *
 * 断言成对:缺失 ⇒ null;真实 0 ⇒ 仍是 0。
 */
import { describe, expect, it } from 'vitest'
import type { AdminUsageLog } from '@/types'
import { summarizeModelAudit } from '../modelCostAnalysis'

function log(overrides: Partial<AdminUsageLog>): AdminUsageLog {
  return {
    id: 1,
    user_id: 1,
    api_key_id: 1,
    account_id: 1,
    request_id: 'req-1',
    model: 'gpt-5',
    upstream_model: 'gpt-5',
    upstream_response_model: 'gpt-5',
    upstream_model_mismatch: true,
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
  } as AdminUsageLog
}

describe('③ summarizeModelAudit.mismatchStandardCost:total_cost 缺失 ⇒ null(不是 0)', () => {
  it('替换请求的 total_cost 缺失 ⇒ mismatchStandardCost = null(与另两个字段同一套空值语义)', () => {
    const summary = summarizeModelAudit([log({ total_cost: null, account_stats_cost: null, actual_cost: null })])
    expect(summary.mismatchRequests).toBe(1)
    expect(summary.mismatchStandardCost).toBeNull()
    expect(summary.mismatchStandardCost).not.toBe(0)
    // 同对象里另两个字段本来就已做 null 传播 —— 三个必须一致
    expect(summary.mismatchAccountCost).toBeNull()
    expect(summary.mismatchRevenue).toBeNull()
  })

  it('成对:total_cost = 0 ⇒ mismatchStandardCost 是真实 0(不是 null,不误伤)', () => {
    const summary = summarizeModelAudit([log({ total_cost: 0, account_stats_cost: 0, actual_cost: 0 })])
    expect(summary.mismatchStandardCost).toBe(0)
    expect(summary.mismatchStandardCost).not.toBeNull()
    expect(summary.mismatchAccountCost).toBe(0)
    expect(summary.mismatchRevenue).toBe(0)
  })

  it('成对:total_cost 有值 ⇒ 求和', () => {
    const summary = summarizeModelAudit([
      log({ total_cost: 3, account_stats_cost: 1, actual_cost: 5 }),
      log({ id: 2, total_cost: 4, account_stats_cost: 2, actual_cost: 6 }),
    ])
    expect(summary.mismatchStandardCost).toBe(7)
    expect(summary.mismatchAccountCost).toBe(3)
    expect(summary.mismatchRevenue).toBe(11)
  })

  it('同批部分缺失 ⇒ 合计不可信 = null(不用已知部分冒充确定值)', () => {
    const summary = summarizeModelAudit([
      log({ total_cost: 3, account_stats_cost: 1, actual_cost: 5 }),
      log({ id: 2, total_cost: null, account_stats_cost: 1, actual_cost: 5 }),
    ])
    expect(summary.mismatchStandardCost).toBeNull()
    // 账号成本/营收这两条路径不受影响(它们各自都有值)
    expect(summary.mismatchAccountCost).toBe(2)
    expect(summary.mismatchRevenue).toBe(10)
  })

  it('成对:没有替换请求 ⇒ mismatchStandardCost = 0(0 条替换请求的合计确实是 0)', () => {
    const summary = summarizeModelAudit([
      log({ upstream_model_mismatch: false, total_cost: null }),
      log({ id: 2, upstream_model_mismatch: null, total_cost: null }),
    ])
    expect(summary.mismatchRequests).toBe(0)
    expect(summary.mismatchStandardCost).toBe(0)
    expect(summary.mismatchStandardCost).not.toBeNull()
  })
})
