import './costDataI18n'
import { describe, expect, it } from 'vitest'
import {
  describeCurrentAccountState,
  hasAccountRankingEvidence,
  latencyRankingProbe,
  normalizeSchedulerScore,
  resolveSchedulerBaseScoreMax,
} from '../upstreamTable'

describe('upstream account ranking evidence', () => {
  it('ranks an explicit local reference value without treating it as user revenue', () => {
    const today = { requests: 1, cost: 0.4, user_cost: null }
    expect(hasAccountRankingEvidence('output', { today, state: 'normal' })).toBe(false)
    expect(hasAccountRankingEvidence('output', { today, outputUsd: 2, state: 'normal' })).toBe(true)
    expect(today.user_cost).toBeNull()
    expect(hasAccountRankingEvidence('output', { today: { ...today, user_cost: 5 }, outputUsd: null, state: 'normal' })).toBe(false)
    expect(hasAccountRankingEvidence('output', { today, outputUsd: 0, state: 'normal' })).toBe(false)
    expect(hasAccountRankingEvidence('output', { today, outputUsd: Number.NaN, state: 'normal' })).toBe(false)
  })

  it('does not rank an idle untested account from its scheduler score alone', () => {
    expect(hasAccountRankingEvidence('score', {
      today: { requests: 0, cost: 0, user_cost: 0 },
      state: 'normal',
    })).toBe(false)
  })

  it('admits factual traffic, a completed probe, or a current failure state', () => {
    expect(hasAccountRankingEvidence('score', {
      today: { requests: 3, cost: 0.2, user_cost: 0.4 },
      state: 'normal',
    })).toBe(true)
    expect(hasAccountRankingEvidence('reliability', {
      today: { requests: 0 },
      probe: { loading: false, success: true, latency_ms: 80 },
      state: 'normal',
    })).toBe(true)
    expect(hasAccountRankingEvidence('score', {
      today: { requests: 0 },
      state: 'limited',
    })).toBe(true)
  })
})

describe('upstream asset table scheduler score', () => {
  it('normalizes the default upstream 4 point score onto a percentage scale', () => {
    expect(normalizeSchedulerScore(3.8, 4)).toBe(95)
    expect(normalizeSchedulerScore(0.8, 4)).toBe(20)
  })

  it('uses the effective scheduler base weights when settings are available', () => {
    expect(resolveSchedulerBaseScoreMax({
      openai_advanced_scheduler_effective_weight_priority: '0.4',
      openai_advanced_scheduler_effective_weight_load: '1.0',
      openai_advanced_scheduler_effective_weight_queue: '1.0',
      openai_advanced_scheduler_effective_weight_error_rate: '0.2',
      openai_advanced_scheduler_effective_weight_ttft: '0.1',
      openai_advanced_scheduler_effective_weight_reset: '0.3',
      openai_advanced_scheduler_effective_weight_quota_headroom: '0.5',
      openai_advanced_scheduler_effective_weight_upstream_cost: '0.0',
    })).toBe(3.5)
  })
})

describe('upstream asset table current account state', () => {
  it('does not invent recovery events for a healthy account', () => {
    expect(describeCurrentAccountState({
      status: 'active',
      error_message: null,
      rate_limited_at: null,
      rate_limit_reset_at: null,
    })).toMatchObject({ error: 0, limited: 0, state: 'normal', note: '当前状态正常' })
  })

  it('shows current errors and rate limits without presenting them as event counts', () => {
    expect(describeCurrentAccountState({
      status: 'error',
      error_message: 'token expired',
      rate_limited_at: '2026-08-05T12:00:00Z',
      rate_limit_reset_at: '2026-08-05T13:00:00Z',
    }, undefined, new Date('2026-08-05T12:30:00Z'))).toMatchObject({ error: 1, limited: 1, note: 'token expired' })
  })

  it('counts only live cooldowns and includes temporary and model-level scheduler blocks', () => {
    const now = new Date('2026-08-05T12:00:00Z')

    expect(describeCurrentAccountState({
      status: 'active',
      schedulable: true,
      rate_limited_at: '2026-08-05T10:00:00Z',
      rate_limit_reset_at: '2026-08-05T11:00:00Z',
    }, undefined, now)).toMatchObject({ state: 'normal', limited: 0 })

    expect(describeCurrentAccountState({
      status: 'active',
      schedulable: true,
      temp_unschedulable_until: '2026-08-05T12:30:00Z',
      temp_unschedulable_reason: 'upstream 402 cooldown',
    }, undefined, now)).toMatchObject({ state: 'limited', limited: 1, note: 'upstream 402 cooldown' })

    expect(describeCurrentAccountState({
      status: 'active',
      schedulable: true,
      extra: {
        model_rate_limits: {
          'gpt-5': { rate_limited_at: '2026-08-05T11:59:00Z', rate_limit_reset_at: '2026-08-05T13:00:00Z' },
        },
      },
    }, undefined, now)).toMatchObject({ state: 'limited', limited: 1 })
  })

  it('surfaces a failed live probe immediately instead of leaving the account green', () => {
    expect(describeCurrentAccountState({
      status: 'active',
      schedulable: true,
    }, {
      loading: false,
      success: false,
      message: 'API returned 429: usage_limit_reached',
    }, new Date('2026-08-05T12:00:00Z'))).toMatchObject({
      state: 'limited',
      limited: 1,
      note: 'API returned 429: usage_limit_reached',
    })
  })
})

/**
 * 「按延迟排序」的证据来源按源不同(2026-09-22)。
 *
 * `probes` 装的只是**主动探测**结果,而 cockpit 是本地用量采集源:切源即清空、且没有任何写入路径
 * ⇒ `probes` 恒为空。旧写法排序键与「有无证据」都只读 `probes`,于是 cockpit 下
 * **每个账号都没有证据**:排序键全是 `+∞`、`hasAccountRankingEvidence('latency')` 恒假
 * ⇒ 排名列一个序号都不出,而延迟列明明显示着真实毫秒数。
 */
describe('latency ranking evidence · 按源取延迟', () => {
  const idle = { today: { requests: 0, cost: 0, user_cost: 0 }, state: 'normal' } as const

  it('★ cockpit:probes 恒为空,证据必须来自 cockpitAvgLatency', () => {
    expect(latencyRankingProbe('cockpit', undefined, 128)).toMatchObject({ success: true, latency_ms: 128 })
    // 有证据 ⇒ 该账号可参与延迟排行(旧写法下它被判无证据,排名列一个序号都不出)。
    expect(hasAccountRankingEvidence('latency', {
      ...idle,
      probe: latencyRankingProbe('cockpit', undefined, 128),
    })).toBe(true)
  })

  it('成对反例:cockpit 无延迟样本 ⇒ 没有证据,不得凭空造一个延迟', () => {
    expect(latencyRankingProbe('cockpit', undefined, null)).toBeUndefined()
    expect(hasAccountRankingEvidence('latency', {
      ...idle,
      probe: latencyRankingProbe('cockpit', undefined, null),
    })).toBe(false)
  })

  it('Sub2API 保留主动探测；CPA 只使用已记录历史延迟，不据此推导当前健康', () => {
    const probe = { loading: false, success: true, latency_ms: 42 }
    expect(latencyRankingProbe('sub2api', probe, 999)).toBe(probe)
    expect(latencyRankingProbe('cliproxy', probe, 999)).toMatchObject({ latency_ms: 999, message: 'CPA 已记录历史请求延迟' })
    expect(latencyRankingProbe('cliproxy', probe, null)).toBeUndefined()
    // 没探测过就是没证据 —— 即使调用方顺手传了 cockpit 延迟,也不得被拿去用。
    expect(latencyRankingProbe('sub2api', undefined, 999)).toBeUndefined()
  })

  it('非有限值不算证据(NaN / Infinity)', () => {
    expect(latencyRankingProbe('cockpit', undefined, Number.NaN)).toBeUndefined()
    expect(latencyRankingProbe('cockpit', undefined, Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})
