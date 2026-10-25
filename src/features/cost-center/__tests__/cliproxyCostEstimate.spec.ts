/**
 * cliproxyCostEstimate 单测 — token×定价反算 / 未知模型降级 / 空队列
 */
import { describe, it, expect } from 'vitest'
import { estimateCliproxyCost } from '../cliproxyCostEstimate'
import type { UsageQueueRecord } from '@/api/cliproxy/management'
import type { CockpitModelPricing } from '@/api/cockpit'

const pricings: CockpitModelPricing[] = [
  { modelId: 'gpt-5.6-terra', inputUsdPerMillion: 2, outputUsdPerMillion: 12, cachedInputUsdPerMillion: 0.2 },
  { modelId: 'gpt-5.6-luna', inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2, cachedInputUsdPerMillion: 0.02 },
]

function makeRecord(model: string, input: number, output: number, cached = 0): UsageQueueRecord {
  return {
    timestamp: Date.now(),
    latency_ms: 100,
    source: 'test',
    auth_index: '0',
    tokens: { input, output, reasoning: 0, cached, total: input + output + cached },
    failed: false,
    provider: 'openai',
    model,
    alias: model,
    endpoint: '/v1/chat',
    auth_type: 'api_key',
    api_key: 'test',
    request_id: 'r-' + Math.random(),
  } as UsageQueueRecord
}

describe('estimateCliproxyCost', () => {
  it('按 token×定价正确反算成本', () => {
    // gpt-5.6-terra: 1M input × $2 + 0.5M output × $12 + 0.1M cached × $0.2
    // = 2 + 6 + 0.02 = 8.02
    const queue = [makeRecord('gpt-5.6-terra', 1_000_000, 500_000, 100_000)]
    const result = estimateCliproxyCost(queue, pricings)
    expect(result.totalUsd).toBeCloseTo(8.02, 2)
    expect(result.matchedRequests).toBe(1)
    expect(result.unmatchedRequests).toBe(0)
    expect(result.byModel).toHaveLength(1)
    expect(result.byModel[0].model).toBe('gpt-5.6-terra')
    expect(result.estimated).toBe(true)
  })

  it('未知模型降级:不计入成本,计入 unmatched', () => {
    const queue = [makeRecord('unknown-model', 1_000_000, 500_000)]
    const result = estimateCliproxyCost(queue, pricings)
    expect(result.totalUsd).toBe(0)
    expect(result.matchedRequests).toBe(0)
    expect(result.unmatchedRequests).toBe(1)
    expect(result.byModel[0].costUsd).toBe(0)
  })

  it('多模型混合:按成本降序分组', () => {
    // 不含 cached,避免浮点噪声:terra 2+6=8, luna1 0.2+1.2=1.4, luna2 0.1+0.6=0.7 → 合 10.1
    const queue = [
      makeRecord('gpt-5.6-luna', 1_000_000, 1_000_000),
      makeRecord('gpt-5.6-terra', 1_000_000, 500_000),
      makeRecord('gpt-5.6-luna', 500_000, 500_000),
    ]
    const result = estimateCliproxyCost(queue, pricings)
    expect(result.totalUsd).toBeCloseTo(10.1, 2)
    expect(result.byModel[0].model).toBe('gpt-5.6-terra') // 成本高在前
    expect(result.byModel[1].model).toBe('gpt-5.6-luna')
    expect(result.byModel[1].requestCount).toBe(2)
  })

  it('空队列返零成本', () => {
    const result = estimateCliproxyCost([], pricings)
    expect(result.totalUsd).toBe(0)
    expect(result.windowSize).toBe(0)
    expect(result.byModel).toHaveLength(0)
  })

  it('定价缺省字段按 0 处理(不计该 token 类别)', () => {
    // 只有 inputUsdPerMillion,无 output/cached
    const partialPricings: CockpitModelPricing[] = [{ modelId: 'partial', inputUsdPerMillion: 1 }]
    const queue = [makeRecord('partial', 1_000_000, 1_000_000, 500_000)]
    const result = estimateCliproxyCost(queue, partialPricings)
    // 只算 input: 1M × $1 = 1;output/cached 因定价缺省为 0
    expect(result.totalUsd).toBeCloseTo(1, 2)
    expect(result.matchedRequests).toBe(1)
  })
})
