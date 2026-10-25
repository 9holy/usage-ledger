import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import type { OpsThroughputTrendPoint } from '@/api/admin/ops'
import OpsSwitchRateTrendChart from '../OpsSwitchRateTrendChart.vue'

/**
 * 切号率趋势图的「假零」护栏。
 *
 * 背景：`OpsThroughputTrendPoint.switch_count` 是**可选可空**字段
 * （`src/api/admin/ops.ts:90`）。后端未采集该维度时整列缺席，`null` 的语义是
 * 「该源不掌握切号」，**不是**「实测零次切号」。
 *
 * 原实现 `const switches = p.switch_count ?? 0` 会把它算成 0，画出一条贴底实线 ——
 * 用户读成「平均切号 0 次」，与真实数据无法区分。这是本项目红线禁止的假零。
 *
 * 断言成对写：缺失 ⇒ `null`（断点 / 整图空态），真实 0 ⇒ 仍是 0。
 * 只验前者会让「把 0 也当不可得」这种过度修正静默通过。
 */

vi.mock('chart.js', () => ({
  Chart: { register: vi.fn() },
  CategoryScale: {},
  Filler: {},
  Legend: {},
  LineElement: {},
  LinearScale: {},
  PointElement: {},
  Title: {},
  Tooltip: {}
}))

vi.mock('vue-chartjs', async () => {
  const { defineComponent } = await import('vue')

  return {
    Line: defineComponent({
      name: 'LineChartStub',
      props: {
        data: { type: Object, required: true },
        options: { type: Object, default: () => ({}) }
      },
      template: '<div class="line-stub" />'
    })
  }
})

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()

  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key
    })
  }
})

const HelpTooltipStub = defineComponent({
  name: 'HelpTooltip',
  props: { content: { type: String, default: '' } },
  template: '<span class="help-tooltip-stub" />'
})

const EmptyStateStub = defineComponent({
  name: 'EmptyState',
  props: {
    title: { type: String, default: '' },
    description: { type: String, default: '' }
  },
  template: '<div class="empty-state-stub" />'
})

const globalStubs = {
  stubs: {
    HelpTooltip: HelpTooltipStub,
    EmptyState: EmptyStateStub
  }
}

/** 造一个切号趋势点。`switch_count` 刻意**不设默认值** —— 缺省即「该桶没有样本」。 */
function point(overrides: Partial<OpsThroughputTrendPoint> & { bucket_start: string }): OpsThroughputTrendPoint {
  return {
    request_count: 100,
    success_count: 100,
    error_count: 0,
    token_consumed: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    user_billed_usd: 0,
    account_cost_usd: 0,
    contribution_usd: 0,
    qps: 0,
    tps: 0,
    ...overrides
  }
}

function mountChart(points: OpsThroughputTrendPoint[], loading = false) {
  return mount(OpsSwitchRateTrendChart, {
    props: { points, loading, timeRange: '5h' },
    global: globalStubs
  })
}

function switchRateSeries(wrapper: ReturnType<typeof mountChart>): Array<number | null> {
  const line = wrapper.findComponent({ name: 'LineChartStub' })
  expect(line.exists()).toBe(true)
  const data = line.props('data') as { datasets: Array<{ data: Array<number | null> }> }
  return data.datasets[0].data
}

describe('切号率趋势图 · 假零护栏', () => {
  it('整窗口都没有切号样本时走空态，不画贴底 0 线', () => {
    const wrapper = mountChart([
      point({ bucket_start: '2026-09-19T10:00:00.000Z', request_count: 100 }),
      point({ bucket_start: '2026-09-19T10:05:00.000Z', request_count: 200 })
    ])

    // 原实现（`?? 0`）会渲染出 ready 状态 + 全 0 序列，这条断言即失败。
    expect(wrapper.findComponent({ name: 'LineChartStub' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EmptyState' }).exists()).toBe(true)
  })

  it('switch_count 显式为 null（后端给了字段但值为空）同样算「没有样本」', () => {
    const wrapper = mountChart([
      point({ bucket_start: '2026-09-19T10:00:00.000Z', switch_count: null }),
      point({ bucket_start: '2026-09-19T10:05:00.000Z', switch_count: null })
    ])

    expect(wrapper.findComponent({ name: 'LineChartStub' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EmptyState' }).exists()).toBe(true)
  })

  it('部分桶缺样本时，缺的那个是断点（null），有样本的照常算比率', () => {
    const wrapper = mountChart([
      point({ bucket_start: '2026-09-19T10:00:00.000Z', request_count: 100 }),
      point({ bucket_start: '2026-09-19T10:05:00.000Z', request_count: 200, switch_count: 10 })
    ])

    const series = switchRateSeries(wrapper)
    expect(series[0]).toBeNull() // 不是 0
    expect(series[1]).toBeCloseTo(0.05, 10)
    expect(series).not.toEqual([0, 0.05])
  })

  it('真实 0 次切号必须仍渲染为 0，不得被当成「不可得」而断点', () => {
    const wrapper = mountChart([
      point({ bucket_start: '2026-09-19T10:00:00.000Z', request_count: 100, switch_count: 0 }),
      point({ bucket_start: '2026-09-19T10:05:00.000Z', request_count: 200, switch_count: 0 })
    ])

    expect(wrapper.findComponent({ name: 'LineChartStub' }).exists()).toBe(true)
    expect(switchRateSeries(wrapper)).toEqual([0, 0])
  })

  it('桶内零请求时比率为断点，不产生 0/0 的假 0', () => {
    const wrapper = mountChart([
      point({ bucket_start: '2026-09-19T10:00:00.000Z', request_count: 0, switch_count: 5 }),
      point({ bucket_start: '2026-09-19T10:05:00.000Z', request_count: 200, switch_count: 10 })
    ])

    const series = switchRateSeries(wrapper)
    expect(series[0]).toBeNull()
    expect(series[1]).toBeCloseTo(0.05, 10)
  })

  it('空点集且不在加载中时走空态', () => {
    const wrapper = mountChart([])

    expect(wrapper.findComponent({ name: 'LineChartStub' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EmptyState' }).exists()).toBe(true)
  })
})
