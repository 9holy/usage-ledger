import { describe, expect, it, vi } from 'vitest'
import { cliproxyTokenBreakdown, type CliproxyUsageEvent } from '../cpaData'
import { cliproxyEventsToModelStats, cliproxyEventsToOps, cliproxyEventsToTrend } from '@/features/cost-center/cliproxyAdapter'
import { cliproxyEventsToModelRoutes } from '@/features/cost-center/cliproxyManagementAdapter'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => { throw new Error('Native access forbidden in pure token fixtures') }) }))

function event(patch: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    requested_at: 1, provider: 'openai', executor_type: 'codex', model: 'fixture', alias: '',
    auth_index: 'fixture', auth_type: 'apikey', source: '', reasoning_effort: '', service_tier: '',
    latency_ms: 0, ttft_ms: 0, failed: false, status_code: 200,
    input_tokens: 100, output_tokens: 20, reasoning_tokens: 0, cached_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 120,
    primary_used_percent: null, primary_reset_at: null, primary_used_tokens: null,
    primary_remaining_tokens: null, primary_limit_tokens: null, secondary_used_percent: null,
    secondary_reset_at: null, secondary_used_tokens: null, secondary_remaining_tokens: null,
    secondary_limit_tokens: null, ...patch,
  }
}

describe('CPA canonical token semantics (pure fixtures)', () => {
  it.each([
    { provider: 'openai', executor_type: 'codex', input_tokens: 100 },
    { provider: 'anthropic', executor_type: 'ClaudeExecutor', input_tokens: 20 },
  ])('keeps model, trend, operations and route token fields consistent for $provider', patch => {
    const now = new Date('2026-10-25T12:00:00Z')
    const events = [event({ ...patch, requested_at: now.getTime() - 1, cached_tokens: 80, cache_creation_tokens: 10 })]
    const [model] = cliproxyEventsToModelStats(events, {}, '1h', 0.2, now)
    const [trend] = cliproxyEventsToTrend(events, {}, '1h', 0.2, now)
    const [ops] = cliproxyEventsToOps(events, '1h', now).trend
    const [route] = cliproxyEventsToModelRoutes(events, {}, [], '1h', 0.2, now)
    expect(model).toMatchObject({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 70, cache_creation_tokens: 10, total_tokens: 120, cache_hit_ratio: 0.7 })
    expect(trend).toMatchObject({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 70, cache_creation_tokens: 10, total_tokens: 120 })
    expect(ops).toMatchObject({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 70, cache_creation_tokens: 10, token_consumed: 120 })
    expect(route).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 70, totalTokens: 120 })
  })

  it('propagates unknown token semantics, without erasing measured cache reads or known price quotes', () => {
    const now = new Date('2026-10-25T12:00:00Z')
    const events = [event({ requested_at: now.getTime() - 1, provider: 'opaque', executor_type: 'opaque', cached_tokens: 50, priceQuote: { usd: 2, reason: null, evidence: null } })]
    const [model] = cliproxyEventsToModelStats(events, {}, '1h', 0.2, now)
    const [trend] = cliproxyEventsToTrend(events, {}, '1h', 0.2, now)
    const [ops] = cliproxyEventsToOps(events, '1h', now).trend
    const [route] = cliproxyEventsToModelRoutes(events, {}, [], '1h', 0.2, now)
    expect(model).toMatchObject({ input_tokens: null, total_tokens: null, cache_read_tokens: 50, cache_hit_ratio: null, cost: 2, account_cost: 0.4 })
    expect(trend).toMatchObject({ input_tokens: null, total_tokens: null, cache_read_tokens: 50, account_cost: 0.4 })
    expect(ops).toMatchObject({ input_tokens: null, token_consumed: null, cache_read_tokens: 50 })
    expect(route).toMatchObject({ inputTokens: null, totalTokens: null, cacheReadTokens: 50, costUsd: 0.4 })
  })
  it('falls back to legacy cache reads without counting creation as a hit', () => {
    expect(cliproxyTokenBreakdown(event({ cached_tokens: 80, cache_creation_tokens: 10 })))
      .toMatchObject({ inputTokens: 100, cacheReadTokens: 70, cacheWriteTokens: 10 })
    expect(cliproxyTokenBreakdown(event({ provider: 'anthropic', executor_type: 'ClaudeExecutor', input_tokens: 20, cached_tokens: 80, cache_creation_tokens: 10 })))
      .toMatchObject({ inputTokens: 100, cacheReadTokens: 70, cacheWriteTokens: 10 })
  })

  it('keeps explicit reads, true zero, and unknown inclusion semantics distinct', () => {
    expect(cliproxyTokenBreakdown(event({ cached_tokens: 80, cache_read_tokens: 80, cache_creation_tokens: 10 })).cacheReadTokens).toBe(80)
    expect(cliproxyTokenBreakdown(event())).toMatchObject({ inputTokens: 100, cacheReadTokens: 0 })
    expect(cliproxyTokenBreakdown(event({ provider: 'opaque-route', executor_type: 'opaque', cached_tokens: 50 })).inputTokens).toBeUndefined()
    expect(cliproxyTokenBreakdown(event({ provider: 'opaque-route', executor_type: 'opaque', cached_tokens: 0 })).inputTokens).toBe(100)
  })
})
