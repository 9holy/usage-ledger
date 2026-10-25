/**
 * 本轮 4 处「槽位被假值填满」的护栏（2026-09-20）：
 *
 * - **C** CPA 无 SLA 概念，却把「成功率」填进 `sla` / `request_count_sla`（0 请求时落 0）。
 *   行为断言：走真实 `cliproxyEventsToOps`，`sla` / `request_count_sla` 必须 `null`，
 *   而 success/request 是**实测计数**，必须仍是数字（成对反例，防过度修正）。
 * - **D** SLA 未知时状态圆点 / 进度条落**绿色**（绿色是"健康"的正向断言）。行为断言：挂载组件。
 * - **E / G** 在 `CostCenterView.vue` 内部（模板字面量 + setup 内的事件处理函数），
 *   该视图依赖 router / store / Tauri，本仓既有约定是不 mount（见
 *   `revenueLayerNullContract.spec.ts:17`、`opsHonestyRegression.spec.ts:146-151`）。
 *   故这两条是**源码结构断言（弱于行为断言）**：能抓"守卫被还原成缺陷写法"，
 *   抓不到"逻辑被等价重写"。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import type { OpsDashboardOverview } from '@/api/admin/ops'
import { cliproxyEventsToOps } from '../cliproxyAdapter'
import OpsDashboardHeader from '@/views/admin/ops/components/OpsDashboardHeader.vue'

const VIEW = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
// C · CPA 无 SLA 槽位
// ─────────────────────────────────────────────────────────────────────────────

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

describe('C · CPA 没有 SLA 目标 ⇒ SLA 槽位必须是 null，不是成功率', () => {
  it('有请求时 sla / request_count_sla 为 null；成功/请求计数仍是实测数字', () => {
    const events = [cpaEvent({ id: 1 }), cpaEvent({ id: 2 })]
    const { overview } = cliproxyEventsToOps(events, '1h')

    expect(overview.sla).toBeNull()
    expect(overview.request_count_sla).toBeNull()
    // 旧写法把 success/request = 1 填进去，面板会显示「SLA 100.000%」= 凭空断言达标。
    expect(overview.sla).not.toBe(1)

    // 成对反例：同对象里 success_count / request_count_total 是本机 events 实测计数，
    // 不能因为"顺手清假值"被一起 null 掉。
    expect(overview.success_count).toBe(2)
    expect(overview.request_count_total).toBe(2)
    expect(typeof overview.error_rate).toBe('number')
  })

  it('零请求时也不得落 0（旧写法 `requestTotal > 0 ? … : 0`）', () => {
    const { overview } = cliproxyEventsToOps([], '1h')
    expect(overview.sla).toBeNull()
    expect(overview.request_count_sla).toBeNull()
    expect(overview.sla).not.toBe(0)
    // 成对反例：零请求下的 request_count_total 是真实 0，必须仍是 0。
    expect(overview.request_count_total).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D · SLA 未知不得落绿
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@/api', () => ({
  adminAPI: { groups: { getAll: vi.fn(async () => []) } },
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

function overviewWith(sla: number | null): OpsDashboardOverview {
  return {
    start_time: '2026-09-20T00:00:00Z',
    end_time: '2026-09-20T01:00:00Z',
    platform: 'all',
    group_id: null,
    success_count: 100,
    error_count_total: 0,
    business_limited_count: 0,
    error_count_sla: 0,
    request_count_total: 100,
    request_count_sla: 100,
    token_consumed: 1_000,
    sla,
    error_rate: 0,
    upstream_error_rate: 0,
    upstream_error_count_excl_429_529: 0,
    upstream_429_count: 0,
    upstream_529_count: 0,
    qps: { current: 1, peak: 2, avg: 1 },
    tps: { current: 1, peak: 2, avg: 1 },
    duration: { p50_ms: 100, p90_ms: 200, p95_ms: 300, p99_ms: 400, avg_ms: 120, max_ms: 500 },
    ttft: { p50_ms: 10, p90_ms: 20, p95_ms: 30, p99_ms: 40, avg_ms: 12, max_ms: 50 },
  }
}

/** `overview.sla` 是**比例**(0–1)，组件再 ×100 得到百分比（slaPercent）。 */
function mountHeader(sla: number | null) {
  setActivePinia(createPinia())
  const wrapper = mount(OpsDashboardHeader, {
    props: {
      overview: overviewWith(sla),
      platform: '',
      groupId: null,
      timeRange: '1h',
      queryMode: 'auto',
      loading: false,
      lastUpdated: null,
      thresholds: { sla_percent_min: 99 },
    },
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

/** 挂载的组件带着 interval/时钟，必须显式卸载，否则 vitest 进程挂住不退出。 */
const mountedWrappers: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const wrapper of mountedWrappers) wrapper.unmount()
  mountedWrappers.length = 0
})

/** SLA 卡片的状态圆点(唯一同时带 h-1.5 与 rounded-full 的 span)。 */
function slaDot(wrapper: ReturnType<typeof mountHeader>) {
  const dot = wrapper.findAll('span').find(
    (node) => node.classes().includes('h-1.5') && node.classes().includes('rounded-full'),
  )
  expect(dot, '未找到 SLA 状态圆点').toBeTruthy()
  return dot!
}

/** SLA 卡片的进度条(唯一同时带 h-full 与 transition-all 的 div)。 */
function slaBar(wrapper: ReturnType<typeof mountHeader>) {
  const bar = wrapper.findAll('div').find(
    (node) => node.classes().includes('h-full') && node.classes().includes('transition-all'),
  )
  expect(bar, '未找到 SLA 进度条').toBeTruthy()
  return bar!
}

describe('D · SLA 不可得 ⇒ 中性灰，不给绿', () => {
  beforeEach(() => {
    // 关掉实时监控，避免组件挂载时去打 opsAPI（本用例只关心 SLA 卡片）。
    localStorage.setItem('ops_realtime_monitoring_enabled_cached', 'false')
  })

  it('sla = null 时圆点与进度条都不是绿色', () => {
    const wrapper = mountHeader(null)

    for (const node of [slaDot(wrapper), slaBar(wrapper)]) {
      expect(node.classes()).not.toContain('bg-green-500')
      expect(node.classes()).not.toContain('bg-red-500')
      expect(node.classes()).not.toContain('bg-yellow-500')
      expect(node.classes().join(' ')).toContain('bg-gray-400')
    }
    // 数值仍显示「-」（既有行为，不能因为改颜色被弄丢）
    expect(wrapper.text()).toContain('-')
  })

  it('成对反例：SLA 达标(0.995 ⇒ 99.5% ≥ 阈值 99)时仍是绿色，不能把已知的健康也说成未知', () => {
    const wrapper = mountHeader(0.995)
    expect(slaDot(wrapper).classes()).toContain('bg-green-500')
    expect(slaBar(wrapper).classes()).toContain('bg-green-500')
    expect(wrapper.text()).toContain('99.500%')
  })

  it('成对反例：SLA 低于阈值时仍是红色', () => {
    const wrapper = mountHeader(0.9)
    expect(slaDot(wrapper).classes()).toContain('bg-red-500')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E · 硬编码字面量不得声明 measured
// ─────────────────────────────────────────────────────────────────────────────

describe('E · value 是字面量的 MetricCell 不得声明 state="measured"', () => {
  it('「认证方式」格：state 是 estimated（自方知识），不是 measured', () => {
    const line = VIEW.split('\n').find((l) => l.includes('label="认证方式"')) ?? ''
    expect(line, '未找到「认证方式」单元格').not.toBe('')
    expect(line).toContain('value="X-API-Key / Bearer"')
    expect(line).toContain('state="estimated"')
    // 缺陷写法：没测任何东西却声明"实测"
    expect(line).not.toContain('state="measured"')
  })

  it('全视图扫一遍：value 为字面量（无 `:` 前缀）的 MetricCell 一律不得是 measured', () => {
    const metricCells = VIEW.split('\n').filter((line) => /<MetricCell\b/.test(line))
    const literalValueCells = metricCells.filter((line) => /(?<![:\w])value="/.test(line))

    // ★ 扫描面必须非空,否则下面的 offenders 恒为 [] —— 守卫会永远绿着而什么都没看。
    // (2026-09-22 实测:视图里有 62 行 `<MetricCell`,但 `value="` 是**字面量**的只有 1 行,
    //  余量只有 1 ⇒ 那一行一旦重构成 `:value`,这条守卫就静默退化成空操作。)
    expect(metricCells.length, '视图里一个 `<MetricCell` 都没找到 —— 组件被改名了?').toBeGreaterThan(0)
    expect(
      literalValueCells.length,
      '没有一行是「字面量 value」的 MetricCell —— 扫描面塌了,这条守卫等于没跑',
    ).toBeGreaterThan(0)

    const offenders = literalValueCells.filter((line) => line.includes('state="measured"'))
    expect(offenders, `字面量 value 配 measured：\n${offenders.join('\n')}`).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G · 探测耗时缺失不得报 "0 ms"
// ─────────────────────────────────────────────────────────────────────────────

describe('G · 探测耗时缺失 ⇒ 省略耗时片段', () => {
  it('latency_ms 走 latencySampleMs 判空，不再 `|| 0`', () => {
    const block = VIEW.slice(VIEW.indexOf('const result = await data.probeAccount(account)'))
    const head = block.slice(0, block.indexOf('} else appStore.showError'))
    expect(head, '未找到连接测试完成提示').not.toBe('')
    expect(head).toContain('latencySampleMs(result.latency_ms)')
    expect(head).not.toContain('result.latency_ms || 0')
    // 缺失分支只报"连接测试完成"，不带耗时；有值时仍带 ms 数（不能把耗时整段删掉）
    expect(head).toContain('`${account.name} 连接测试完成`')
    expect(head).toContain('总耗时 ${formatInteger(latency)} ms')
  })
})
