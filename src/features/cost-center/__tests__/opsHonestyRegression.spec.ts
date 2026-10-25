/**
 * 本轮新增的「有牙齿」回归护栏（三块，均针对独立复核指出的零报警变异）：
 *
 * - **T-M6**：`loadFromCockpit` 的窗口级 TTFT 实参必须真的透传到 `opsOverview.ttft`。
 *   变异 M6（把 `useCostCenterData.ts:1258` 的 `windowTtft` 实参丢掉）此前 531 条全绿零报警。
 * - **T-M3**：切号事件的 null 语义 —— 「该源不采集切号」必须是 `null`（界面显示「无数据」），
 *   而**真实的 0 次切号必须仍是 0**。覆盖两处变异：
 *     M4 `useCostCenterData.ts:1288` 的 `?? null` 改回 `?? 0`（行为断言）；
 *     M3 删掉 `CostCenterView.vue` 里 `switchCount` computed 的 null 分支（源码结构断言）。
 * - **FIX B**：cliproxy 的 `upstream_error_count_excl_429_529` 语义含 402，
 *   图表再减 402 得到「其他上游错误」；旧实现把 402 扣两次（`max(0, errOther − err402)`）。
 *
 * 强度弱点见每条用例的注释；本文件不假装源码结构断言等价于行为断言。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import { cliproxyEventsToOps } from '../cliproxyAdapter'
import { cockpitTotalsToOpsOverview } from '../cockpitAdapter'
import { useCostCenterData } from '../useCostCenterData'

const VIEW = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')

/** 与 modelAuditSourceContract.spec.ts 同款最小 stats（已知能走通 loadFromCockpit）。 */
function minimalStats() {
  const totals = {
    requestCount: 5, successCount: 5, failureCount: 0, clientCanceledCount: 0,
    upstreamResponseFailedCount: 0, streamIncompleteCount: 0, totalLatencyMs: 100,
    textRequestCount: 5, imageRequestCount: 0, imageGenerationRequestCount: 0,
    imageEditRequestCount: 0, imageGenerationCapabilityFailureCount: 0,
    inputTokens: 10, outputTokens: 10, totalTokens: 20, cachedTokens: 0,
    reasoningTokens: 0, estimatedCostUsd: 0,
  }
  return {
    since: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    totals,
    accounts: [],
    models: [],
    apiKeys: [],
    daily: { since: Date.now() - 3_600_000, updatedAt: Date.now(), accounts: [], models: [], apiKeys: [], totals },
    weekly: null,
    monthly: null,
  } as never
}

// ─────────────────────────────────────────────────────────────────────────────
// T-M6
// ─────────────────────────────────────────────────────────────────────────────
describe('T-M6 · 窗口级 TTFT 必须透传到 opsOverview（丢掉实参 = 假「无样本」）', () => {
  it('传入 windowTtft → opsOverview.ttft.p50_ms / p95_ms 等于传入值', () => {
    const data = useCostCenterData()
    // 位置参数签名见 useCostCenterData.ts:1084-1125，windowTtft 是第 15 个。
    data.loadFromCockpit(
      minimalStats(), null, '1h',
      [], null, new Map(), undefined, [],
      null, null, null, null, null, null,
      { p50Ms: 120, p95Ms: 340 },
    )
    expect(data.opsOverview.value?.ttft.p50_ms).toBe(120)
    expect(data.opsOverview.value?.ttft.p95_ms).toBe(340)
  })

  it('windowTtft 缺省 → ttft.p95_ms 是 null（「无样本」），绝不是 0', () => {
    const data = useCostCenterData()
    data.loadFromCockpit(minimalStats(), null, '1h')
    expect(data.opsOverview.value?.ttft.p95_ms).toBeNull()
    // 反例保护：0 是「瞬时返回」的断言，不能被当成「无样本」。
    expect(data.opsOverview.value?.ttft.p95_ms).not.toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-M3 / M4
// ─────────────────────────────────────────────────────────────────────────────
describe('T-M3 · 切号事件 null 语义（不采集 ≠ 零次切号）', () => {
  function rlCell(startMs: number, requests: number) {
    return {
      startMs, model: 'gpt-6-astra', requests, success: requests, error: 0,
      stdNormalInput: 1_000 * requests, stdCached: 0, stdOutput: 100 * requests,
      longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    }
  }

  function opsPoint(startMs: number, requests: number, extra: Record<string, unknown>) {
    return {
      bucket_start: new Date(startMs).toISOString(),
      request_count: requests,
      success_count: requests,
      error_count: 0,
      token_consumed: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      switch_count: 0,
      user_billed_usd: 0,
      account_cost_usd: 0,
      contribution_usd: 0,
      duration_p95_ms: null,
      ttft_p50_ms: null,
      ttft_p95_ms: null,
      qps: requests / 3600,
      tps: 0,
      ...extra,
    }
  }

  /**
   * 行为断言：走真实 `loadFromCockpit`，单请求库 cells 生成 opsTrend，
   * 多天日志聚合按同一桶时间戳回填延迟/TTFT/切号。
   * - 桶 0：聚合点**没有** switch_count（该源不采集）→ 必须 null（M4 变异成 `?? 0` 会被抓住）。
   * - 桶 1：聚合点显式 `switch_count: 0`（真实零次）→ 必须仍是 0（反例必须保住）。
   * 前置 `ttft_p95_ms` 断言证明「对齐回填块」确实执行过 —— 否则 switch_count 断言可能恒真。
   */
  it('缺 switch_count ⇒ null；真实 0 ⇒ 0', () => {
    const data = useCostCenterData()
    const requestLog = {
      available: true, reason: null, rowCount: 15, windowStartMs: 0, windowEndMs: 0, bucketHours: 24,
      cells: [rlCell(0, 10), rlCell(86_400_000, 5)],
      groups: [],
    } as never
    const multiDayOps = [
      opsPoint(0, 10, { switch_count: undefined, duration_p95_ms: 777, ttft_p95_ms: 555 }),
      opsPoint(86_400_000, 5, { switch_count: 0, duration_p95_ms: 111, ttft_p95_ms: 222 }),
    ] as never

    data.loadFromCockpit(
      minimalStats(), null, '7d',
      [], null, new Map(), undefined, [],
      multiDayOps, null, null, requestLog, requestLog,
    )

    const points = data.opsTrend.value
    expect(points.length).toBe(2)
    // 证明对齐回填块真的跑了（M6 之外的独立证据）。
    expect(points[0]!.ttft_p95_ms).toBe(555)
    expect(points[1]!.ttft_p95_ms).toBe(222)
    // M4：`src.switch_count ?? null` 被改成 `?? 0` 时，这里会变成 0 → 断言失败。
    expect(points[0]!.switch_count).toBeNull()
    // 反例：真实零次切号必须保留 0，不能因为「可能是缺失」就整片置 null。
    expect(points[1]!.switch_count).toBe(0)
  })

  /**
   * 源码结构断言（**弱于行为断言**）：`switchCount` 是 CostCenterView 的 setup 内 computed，
   * 未导出，且该视图依赖 router / store / Tauri，本仓库既有测试（revenueLayerNullContract.spec.ts:17）
   * 已说明挂载成本过高、一律不 mount。故此处只钉住「无观测点 ⇒ null」这两个分支的存在性。
   * 覆盖边界：能抓 M3（删 null 分支），但抓不到「逻辑被等价重写」的变异。
   */
  it('M3：视图 switchCount computed 保留「无观测点 ⇒ null」分支', () => {
    const start = VIEW.indexOf('const switchCount = computed')
    const end = VIEW.indexOf('/** 首 token P95')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = VIEW.slice(start, end)
    // 跳过 null / 非有限值，不做加总
    expect(body).toContain('if (point.switch_count == null) continue')
    expect(body).toContain('if (!Number.isFinite(value)) continue')
    // 一个有限观测点都没有 ⇒ 返回 null（删掉这个三元分支 = M3）
    expect(body).toContain('return observed ? sum : null')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX B
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX B · cliproxy 的 excl_429_529 语义含 402（图表再减 402 得「其他」）', () => {
  function cpaEvent(overrides: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
    return {
      id: 1,
      requested_at: Date.now() - 1_000,
      provider: 'openai',
      executor_type: 'codex',
      model: 'gpt-5',
      alias: '',
      auth_index: '',
      auth_type: '',
      source: '',
      reasoning_effort: '',
      service_tier: '',
      latency_ms: 100,
      ttft_ms: 50,
      failed: false,
      status_code: 200,
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 0,
      cached_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 15,
      primary_used_percent: null,
      primary_reset_at: null,
      primary_used_tokens: null,
      primary_remaining_tokens: null,
      primary_limit_tokens: null,
      secondary_used_percent: null,
      secondary_reset_at: null,
      secondary_used_tokens: null,
      secondary_remaining_tokens: null,
      secondary_limit_tokens: null,
      ...overrides,
    }
  }

  it('402 计入 excl_429_529；excl_429_529 − 402 = 其他上游错误（不重复扣减）', () => {
    // 两个失败请求：一个 402（封闭空间）、一个 500（其他上游错误）。
    const events = [
      cpaEvent({ id: 1, status_code: 402, failed: true }),
      cpaEvent({ id: 2, status_code: 500, failed: true }),
    ]
    const { overview, errorTrend } = cliproxyEventsToOps(events, '1h')

    // 语义（权威实现 ops_repo_preagg.go:96 `NOT IN (429,529)`）：402 + 其他 = 2。
    // 旧实现（b.errOther）在这里会给 1，图表再减 402 就变成 max(0, 1−1)=0，把 500 那条吞掉。
    expect(overview.upstream_error_count_excl_429_529).toBe(2)
    // 上游错误率分子必须含 402：2/2 = 1（旧实现漏 402 → 0.5）。
    expect(overview.upstream_error_rate).toBeCloseTo(1, 9)

    const point = errorTrend[0]!
    expect(point.upstream_402_count).toBe(1)
    expect(point.upstream_error_count_excl_429_529).toBe(2)
    // AdaptiveOperationsCharts.vue:246-249 的「其他上游错误」= max(0, excl − 402) = 1（500 那条）。
    const chartOther = Math.max(
      0,
      point.upstream_error_count_excl_429_529! - point.upstream_402_count!,
    )
    expect(chartOther).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX A（本轮新增的护栏：此前 cockpitTotalsToOpsOverview 的 429 零覆盖）
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX A · cockpit totals 没有 429 维度 ⇒ upstream_429_count 必须是 null 而非假 0', () => {
  it('cockpitTotalsToOpsOverview 的 429 / 529 留 null', () => {
    const overview = cockpitTotalsToOpsOverview(minimalStats(), '1h')
    expect(overview).not.toBeNull()
    expect(overview!.upstream_429_count).toBeNull()
    expect(overview!.upstream_529_count).toBeNull()
    // 反例：0 是「零次 429」的实测断言，不能被当成「无数据」。
    expect(overview!.upstream_429_count).not.toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX C（源码结构断言，弱于行为断言：该单元格状态由模板表达式决定，无独立可导出函数）
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX C · 三端汇总的「Cockpit 总 Token / 请求数」角标必须跟值走', () => {
  it('字段缺失时 state = unavailable，不再因为对象存在就判 measured', () => {
    const lines = VIEW.split('\n')
    const cells: Array<[string, string]> = [
      ['Cockpit 总 Token', lines.find((l) => l.includes('label="Cockpit 总 Token"')) ?? ''],
      ['Cockpit 请求数', lines.find((l) => l.includes('label="Cockpit 请求数"')) ?? ''],
    ]
    for (const [name, line] of cells) {
      expect(line, `未找到单元格「${name}」`).not.toBe('')
      expect(line, `「${name}」的 state 必须由 finiteOrNull 判空`).toContain('finiteOrNull(unified.cockpitStats.value?.totals.')
      expect(line, `「${name}」缺失时必须 unavailable`).toContain("== null ? 'unavailable' : 'measured'")
      // 旧写法（只看外层对象是否存在）必须已消失。
      expect(line).not.toContain(':state="unified.cockpitStats.value ? \'measured\' : \'unavailable\'"')
    }
  })
})
