import './costDataI18n'
import { describe, expect, it } from 'vitest'
import type { SourceAdminUsageLog as AdminUsageLog } from '../sourceTypes'
import { aggregateUsageWindow, fillCostTrendBuckets, localDateParameter, usageBucketHours, usageWindowBounds, usageWindowHours, usageWindowRate } from '../usageWindow'
import { aggregateModelStatsFromUsageLogs, summarizeModelAudit } from '../modelCostAnalysis'
import { buildModelRouteRows } from '../modelRouteAnalysis'

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

describe('official core usage-log compatibility aggregation', () => {
  it.each(['cache_read_tokens', 'cache_creation_tokens'] as const)('keeps an unknown %s null in usage buckets and merged source points', (field) => {
    const start = new Date('2026-08-05T12:03:00Z'), end = new Date('2026-08-05T12:04:00Z')
    const [point] = aggregateUsageWindow([usage({ id: 1 }), usage({ id: 2, [field]: null })], '30m', start, end)
    expect(point[field]).toBeNull()
    expect(point.total_tokens).toBeNull()
    const source = { date: start.toISOString(), requests: 1, input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 15, cost: 0, actual_cost: 0 }
    const [merged] = fillCostTrendBuckets([source, { ...source, [field]: null }], '30m', start, end)
    expect(merged[field]).toBeNull()
    const [zero] = fillCostTrendBuckets([source], '30m', start, end)
    expect(zero[field]).toBe(0)
  })

  it('propagates unknown input, output and total tokens while empty buckets remain real zeroes', () => {
    const start = new Date('2026-08-05T12:03:00Z'), end = new Date('2026-08-05T12:04:00Z')
    const points = aggregateUsageWindow([usage({ id: 1 }), usage({ id: 2, input_tokens: null })], '1m', start, end)
    expect(points.find(point => point.requests > 0)).toMatchObject({ input_tokens: null, output_tokens: 10, total_tokens: null })
    expect(points.find(point => point.requests === 0)).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })

    const merged = fillCostTrendBuckets([
      { date: start.toISOString(), requests: 1, input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 15, cost: 0, actual_cost: 0 },
      { date: start.toISOString(), requests: 1, input_tokens: null, output_tokens: null, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: null, cost: 0, actual_cost: 0 },
    ], '1m', start, end)
    expect(merged[0]).toMatchObject({ requests: 2, input_tokens: null, output_tokens: null, total_tokens: null, cost: 0, actual_cost: 0 })
  })

  it('counts each persistent log ID once in model, audit, route and usage aggregates', () => {
    const first = usage({ id: 1, upstream_model_mismatch: true })
    const second = usage({ id: 2, upstream_model_mismatch: false })
    const logs = [first, first, second, { ...second }]
    const start = new Date('2026-08-05T12:03:00Z'), end = new Date('2026-08-05T12:04:00Z')

    expect(aggregateModelStatsFromUsageLogs(logs, 'requested')[0]).toMatchObject({ requests: 2, total_tokens: 40, cost: 0.64, account_cost: 0.64, actual_cost: 0.8 })
    expect(summarizeModelAudit(logs)).toMatchObject({ totalRequests: 2, matchedRequests: 1, mismatchRequests: 1, mismatchRevenue: 0.4 })
    expect(buildModelRouteRows(logs, []).reduce((sum, row) => sum + row.requests, 0)).toBe(2)
    expect(buildModelRouteRows(logs, []).reduce((sum, row) => sum + row.revenue!, 0)).toBe(0.8)
    expect(aggregateUsageWindow(logs, '1m', start, end).find(point => point.requests > 0)).toMatchObject({ requests: 2, total_tokens: 40, cost: 0.64, account_cost: 0.64, actual_cost: 0.8 })
  })

  it('does not merge distinct compatibility requests that have no persistent log ID', () => {
    const logs = [usage({ id: 0, request_id: 'first' }), usage({ id: 0, request_id: 'second' })]
    const start = new Date('2026-08-05T12:03:00Z'), end = new Date('2026-08-05T12:04:00Z')
    expect(aggregateModelStatsFromUsageLogs(logs, 'requested')[0].requests).toBe(2)
    expect(summarizeModelAudit(logs).totalRequests).toBe(2)
    expect(buildModelRouteRows(logs, [])[0].requests).toBe(2)
    expect(aggregateUsageWindow(logs, '1m', start, end).find(point => point.requests > 0)?.requests).toBe(2)
  })

  it.each([
    { snapshot: 2, total: 4, multiplier: 0.5, expected: 1 },
    { snapshot: 0, total: 4, multiplier: 0.5, expected: 0 },
    { snapshot: null, total: 4, multiplier: 0.5, expected: 2 },
    { snapshot: null, total: 4, multiplier: 0, expected: 0 },
    { snapshot: null, total: 4, multiplier: undefined, expected: 4 },
    { snapshot: NaN, total: 4, multiplier: 0.5, expected: null },
    { snapshot: null, total: null, multiplier: 0.5, expected: null },
    { snapshot: null, total: 4, multiplier: NaN, expected: null },
  ])('keeps trend, model and route account costs consistent: $snapshot / $total / $multiplier', ({ snapshot, total, multiplier, expected }) => {
    const entry = usage({ account_stats_cost: snapshot, total_cost: total, account_rate_multiplier: multiplier })
    const start = new Date('2026-08-05T12:03:00Z'), end = new Date('2026-08-05T12:04:00Z')
    const trend = aggregateUsageWindow([entry], '1m', start, end)
    expect(trend.find((point) => point.requests > 0)?.account_cost).toBe(expected)
    expect(aggregateModelStatsFromUsageLogs([entry], 'requested')[0].account_cost).toBe(expected)
    expect(buildModelRouteRows([entry], [])[0].accountCost).toBe(expected)
  })

  it('uses local calendar-day bounds for today', () => {
    const end = new Date(2026, 7, 6, 13, 45, 30)
    const bounds = usageWindowBounds('today', end)

    expect(bounds.start).toEqual(new Date(2026, 7, 6, 0, 0, 0, 0))
    expect(bounds.end).toEqual(new Date(2026, 7, 7, 0, 0, 0, 0))
  })

  it('uses exact rolling bounds for one minute and one month', () => {
    const end = new Date('2026-08-06T12:00:00.000Z')

    expect(usageWindowBounds('1m', end).start.toISOString()).toBe('2026-08-06T11:59:00.000Z')
    expect(usageWindowBounds('30d', end).start.toISOString()).toBe('2026-07-07T12:00:00.000Z')
  })

  it('keeps only records inside the requested rolling window', () => {
    const end = new Date('2026-08-05T12:05:00.000Z')
    const { start } = usageWindowBounds('5m', end)
    const result = aggregateUsageWindow([
      usage({ created_at: '2026-08-05T12:03:20.000Z' }),
      usage({ id: 2, created_at: '2026-08-05T11:59:59.000Z' }),
    ], '5m', start, end)

    expect(result).toHaveLength(20)
    expect(result.filter((point) => point.requests > 0)).toHaveLength(1)
    expect(result[13]).toMatchObject({ requests: 1, total_tokens: 20, cost: 0.32, actual_cost: 0.4 })
  })

  it('applies the account multiplier to both a pre-rate stats snapshot and the total-cost fallback', () => {
    const result = aggregateUsageWindow([
      usage({ account_stats_cost: 0.25, account_rate_multiplier: 1.2 }),
      usage({ id: 2, account_stats_cost: null, total_cost: 0.5, account_rate_multiplier: 2 }),
    ], '30m', new Date('2026-08-05T11:35:00.000Z'), new Date('2026-08-05T12:05:00.000Z'))

    expect(result.reduce((sum, point) => sum + Number(point.account_cost || 0), 0)).toBeCloseTo(1.3)
  })

  it('formats local calendar dates for the upstream date-only API', () => {
    const value = new Date(2026, 7, 5, 23, 59, 0)
    expect(localDateParameter(value)).toBe('2026-08-05')
  })

  it('treats timezone-less dashboard buckets as UTC instead of shifting them by the browser timezone', () => {
    const previousTimezone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const result = fillCostTrendBuckets([{
        date: '2026-08-05 12:00',
        requests: 1,
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 15,
        cost: 0.25,
        actual_cost: 0.3,
      }], '5m', new Date('2026-08-05T11:58:00.000Z'), new Date('2026-08-05T12:03:00.000Z'))

      expect(result).toHaveLength(20)
      expect(result[8].requests).toBe(1)
      expect(result[8].actual_cost).toBe(0.3)
    } finally {
      if (previousTimezone == null) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })
})

describe('record-window rates', () => {
  it('uses actual minute, hour and day bucket sizes, clipped to the query window', () => {
    const day = { start: new Date('2026-10-16T00:00:00Z'), end: new Date('2026-10-17T00:00:00Z') }
    expect(usageBucketHours('2026-10-16 00:00:00', 24, day)).toBe(24)
    expect(usageBucketHours('2026-10-16 00:00:00', 1, day)).toBe(1)
    expect(usageBucketHours('2026-10-16 00:00:00', 1 / 60, day)).toBeCloseTo(1 / 60)
    expect(usageBucketHours('2026-10-16 00:00:00', 1, { start: new Date('2026-10-16T00:30:00Z'), end: day.end })).toBe(0.5)
    expect(usageBucketHours('2026-10-16 00:00:00', 1, null)).toBeNull()
    expect(usageBucketHours('2026-10-16 00:00:00', 0, day)).toBeNull()
    expect(usageBucketHours('invalid', 1, day)).toBeNull()
    expect(usageBucketHours('2026-10-15 00:00:00', 1, day)).toBeNull()
  })

  it.each([
    ['1m', 1 / 60], ['5m', 5 / 60], ['30m', 0.5], ['1h', 1],
    ['6h', 6], ['24h', 24], ['7d', 168], ['30d', 720],
  ] as const)('uses the complete %s query interval regardless of request sparsity or bucket size', (range, hours) => {
    const bounds = usageWindowBounds(range, new Date('2026-10-16T12:34:56Z'))
    expect(usageWindowHours(bounds)).toBeCloseTo(hours)
    expect(usageWindowRate(2, bounds)).toBeCloseTo(2 / hours)
    expect(usageWindowRate(0, bounds)).toBe(0)
  })

  it('clips a one-hour bucket to the precise one-minute requested window', () => {
    const query = usageWindowBounds('1m', new Date('2026-10-16T12:30:45Z'))
    const bucket = { start: new Date('2026-10-16T12:00:00Z'), end: new Date('2026-10-16T13:00:00Z') }
    expect(usageWindowRate(2, bucket, query)).toBeCloseTo(120)
  })

  it('limits today to the query time and uses a proven truncated sample boundary when supplied', () => {
    const now = new Date(2026, 9, 16, 12, 0)
    const today = usageWindowBounds('today', now)
    expect(usageWindowHours(today, { start: today.start, end: now })).toBe(12)
    const sample = { start: new Date(now.getTime() - 30 * 60000), end: now }
    expect(usageWindowRate(2, usageWindowBounds('1h', now), sample)).toBe(4)
  })

  it('does not turn missing amount or unknown/empty coverage into a zero rate', () => {
    const bounds = usageWindowBounds('1h', new Date('2026-10-16T12:00:00Z'))
    expect(usageWindowRate(null, bounds)).toBeNull()
    expect(usageWindowRate(0, bounds, null)).toBeNull()
    expect(usageWindowRate(2, bounds, { start: bounds.end, end: bounds.end })).toBeNull()
  })
})
