import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import OpsErrorDistributionChart from '../OpsErrorDistributionChart.vue'
import OpsErrorTrendChart from '../OpsErrorTrendChart.vue'

vi.mock('chart.js', () => ({
  Chart: { register: vi.fn() },
  ArcElement: {},
  CategoryScale: {},
  Filler: {},
  Legend: {},
  LineElement: {},
  LinearScale: {},
  PointElement: {},
  Title: {},
  Tooltip: {},
}))

vi.mock('vue-chartjs', async () => {
  const { defineComponent } = await import('vue')

  return {
    Doughnut: defineComponent({
      name: 'Doughnut',
      props: {
        data: { type: Object, required: true },
        options: { type: Object, default: () => ({}) },
      },
      template: '<div class="doughnut-stub" />',
    }),
    Line: defineComponent({
      name: 'LineChartStub',
      props: {
        data: { type: Object, required: true },
        options: { type: Object, default: () => ({}) },
      },
      template: '<div class="line-stub" />',
    }),
  }
})

vi.mock('../../utils/opsFormatters', () => ({
  formatHistoryLabel: (date: string | undefined) => date ?? '',
  sumNumbers: (values: Array<number | null | undefined>) =>
    values.reduce<number>((total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()

  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key,
    }),
  }
})

const HelpTooltipStub = defineComponent({
  name: 'HelpTooltip',
  props: {
    content: { type: String, default: '' },
  },
  template: '<span class="help-tooltip-stub" />',
})

const EmptyStateStub = defineComponent({
  name: 'EmptyState',
  props: {
    title: { type: String, default: '' },
    description: { type: String, default: '' },
  },
  template: '<div class="empty-state-stub" />',
})

const globalStubs = {
  stubs: {
    HelpTooltip: HelpTooltipStub,
    EmptyState: EmptyStateStub,
  },
}

describe('Ops SLA-scoped error charts', () => {
  it('错误分布图按 SLA 错误数统计，不把业务限制错误算进请求错误分布', () => {
    const wrapper = mount(OpsErrorDistributionChart, {
      props: {
        loading: false,
        data: {
          total: 10,
          items: [
            { status_code: 400, total: 7, sla: 2, business_limited: 5 },
            { status_code: 503, total: 3, sla: 0, business_limited: 3 },
          ],
        },
      },
      global: globalStubs,
    })

    const doughnut = wrapper.findComponent({ name: 'Doughnut' })
    expect(doughnut.exists()).toBe(true)
    expect(doughnut.props('data')).toMatchObject({
      labels: ['admin.ops.client'],
      datasets: [{ data: [2] }],
    })
  })

  it('错误分布图在只有业务限制错误时显示为空态', () => {
    const wrapper = mount(OpsErrorDistributionChart, {
      props: {
        loading: false,
        data: {
          total: 4,
          items: [{ status_code: 500, total: 4, sla: 0, business_limited: 4 }],
        },
      },
      global: globalStubs,
    })

    expect(wrapper.findComponent({ name: 'Doughnut' }).exists()).toBe(false)
    expect(wrapper.find('.empty-state-stub').exists()).toBe(true)
  })

  /**
   * `item.sla` / `item.status_code` 不可得时**跳过该 item**,不得当 0 并入分类。
   *
   * 旧实现 `Number(item.status_code || 0)` 会把缺 status_code 的 item 归到 `code = 0` ⇒
   * 落进「其他」桶,凭空长出一类;`Number(item.sla || 0)` 在 sla 为非数值时产生 NaN,
   * 把 `totalSlaErrors` 变成 NaN ⇒ `hasData` 为假 ⇒ **整张图**退化成空态(有真实计数的类也一起消失)。
   */
  it('status_code 不可得的 item 不得被当成 0 归入「其他」', () => {
    const wrapper = mount(OpsErrorDistributionChart, {
      props: {
        loading: false,
        data: {
          total: 8,
          items: [
            { status_code: 400, total: 3, sla: 3, business_limited: 0 },
            { status_code: null as unknown as number, total: 5, sla: 5, business_limited: 0 },
          ],
        },
      },
      global: globalStubs,
    })

    const doughnut = wrapper.findComponent({ name: 'Doughnut' })
    expect(doughnut.exists()).toBe(true)
    // 只有真实 status_code=400 的那条参与;缺 status_code 的 5 条不能被塞进「其他」。
    expect(doughnut.props('data')).toMatchObject({
      labels: ['admin.ops.client'],
      datasets: [{ data: [3] }],
    })
  })

  it('sla 非数值不得毒化总数(否则整张图退化成空态,真实计数一起消失)', () => {
    const wrapper = mount(OpsErrorDistributionChart, {
      props: {
        loading: false,
        data: {
          total: 7,
          items: [
            { status_code: 400, total: 2, sla: 2, business_limited: 0 },
            { status_code: 500, total: 5, sla: Number.NaN, business_limited: 0 },
          ],
        },
      },
      global: globalStubs,
    })

    const doughnut = wrapper.findComponent({ name: 'Doughnut' })
    expect(doughnut.exists()).toBe(true)
    expect(doughnut.props('data')).toMatchObject({
      labels: ['admin.ops.client'],
      datasets: [{ data: [2] }],
    })
    expect(wrapper.find('.empty-state-stub').exists()).toBe(false)
  })

  it('成对反例:真实的 sla = 0 仍算"已统计",不被当成缺失跳过', () => {
    const wrapper = mount(OpsErrorDistributionChart, {
      props: {
        loading: false,
        data: {
          total: 6,
          items: [
            { status_code: 503, total: 6, sla: 6, business_limited: 0 },
            { status_code: 503, total: 4, sla: 0, business_limited: 4 },
          ],
        },
      },
      global: globalStubs,
    })

    // 0 是"这一类确实 0 条",不是"没有数据":它照常参与累加(加 0 不改结果),
    // 上一条真实计数的 6 必须完整保留。
    expect(wrapper.findComponent({ name: 'Doughnut' }).props('data')).toMatchObject({
      labels: ['admin.ops.upstream'],
      datasets: [{ data: [6] }],
    })
  })

  it('错误趋势图的请求错误详情按钮只按 SLA 错误启用', () => {
    const wrapper = mount(OpsErrorTrendChart, {
      props: {
        loading: false,
        timeRange: '1h',
        points: [
          {
            bucket_start: '2026-05-18T00:00:00Z',
            error_count_total: 5,
            business_limited_count: 5,
            error_count_sla: 0,
            upstream_error_count_excl_429_529: 0,
            upstream_429_count: 0,
            upstream_529_count: 0,
          },
        ],
      },
      global: globalStubs,
    })

    const requestErrorsButton = wrapper.findAll('button')[0]
    expect(requestErrorsButton.attributes('disabled')).toBeDefined()
  })
})
