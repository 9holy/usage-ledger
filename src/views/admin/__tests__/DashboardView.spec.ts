import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'

import type { DashboardStats } from '@/types'
import zhMessages from '@/i18n/locales/zh'
import enMessages from '@/i18n/locales/en'
import DashboardView from '../DashboardView.vue'

/**
 * 真正的「切区间」需要 DateRangePicker 抛出 change 事件。
 * 默认的 `DateRangePicker: true` 只是空 stub，不会 emit，所以这里单独造一个。
 */
const DateRangePickerStub = defineComponent({
  name: 'DateRangePicker',
  emits: ['change'],
  setup(_props, { emit }) {
    return () =>
      h(
        'button',
        {
          'data-testid': 'range-change',
          onClick: () =>
            emit('change', { startDate: '2026-09-01', endDate: '2026-09-07', preset: '7d' })
        },
        'change-range'
      )
  }
})

const { getSnapshotV2, getUserUsageTrend, getUserSpendingRanking } = vi.hoisted(() => ({
  getSnapshotV2: vi.fn(),
  getUserUsageTrend: vi.fn(),
  getUserSpendingRanking: vi.fn()
}))

vi.mock('@/api/admin', () => ({
  adminAPI: {
    dashboard: {
      getSnapshotV2,
      getUserUsageTrend,
      getUserSpendingRanking
    }
  }
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    showError: vi.fn()
  })
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn()
  })
}))

/**
 * 组件用 useI18n() 取 t，测试里必须挂**真实**语言包，否则 t() 只会回显 key。
 *
 * 环境前提：vitest.config.ts 把 vue-i18n 指到了不含消息编译器的运行时构建，
 * 字符串消息只能靠 JIT 编译解析 —— 该开关由 vitest.config.ts 的
 * `define.__INTLIFY_JIT_COMPILATION__` 打开（与 vite.config.ts:106 保持一致）。
 *
 * 本文件此前用 `vi.mock('vue-i18n', ...)` 把 useI18n 换成 `t: key => key`，
 * 那是「t() 恒等于 key」的直接原因：连 admin.dashboard.* / common.* 都解析不出来。
 * 现已删除该 mock，改用真实 i18n 实例。
 */
const createTestI18n = (locale: 'zh' | 'en' = 'zh') =>
  createI18n({
    legacy: false,
    locale,
    // 故意不让 en 回退到 zh：en 缺 key 时应暴露成 key，而不是悄悄回退成中文
    fallbackLocale: locale,
    messages: { zh: zhMessages, en: enMessages }
  })

const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const createDashboardStats = (): DashboardStats => ({
  total_users: 0,
  today_new_users: 0,
  active_users: 0,
  hourly_active_users: 0,
  stats_updated_at: '',
  stats_stale: false,
  total_api_keys: 0,
  active_api_keys: 0,
  total_accounts: 0,
  normal_accounts: 0,
  error_accounts: 0,
  ratelimit_accounts: 0,
  overload_accounts: 0,
  total_requests: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cache_creation_tokens: 0,
  total_cache_read_tokens: 0,
  total_tokens: 0,
  total_cost: 0,
  total_actual_cost: 0,
  today_requests: 0,
  today_input_tokens: 0,
  today_output_tokens: 0,
  today_cache_creation_tokens: 0,
  today_cache_read_tokens: 0,
  today_tokens: 0,
  today_cost: 0,
  today_actual_cost: 0,
  average_duration_ms: 0,
  uptime: 0,
  rpm: 0,
  tpm: 0
})

describe('admin DashboardView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())

    getSnapshotV2.mockReset()
    getUserUsageTrend.mockReset()
    getUserSpendingRanking.mockReset()

    getSnapshotV2.mockResolvedValue({
      stats: createDashboardStats(),
      trend: [],
      models: []
    })
    getUserUsageTrend.mockResolvedValue({
      trend: [],
      start_date: '',
      end_date: '',
      granularity: 'hour'
    })
    getUserSpendingRanking.mockResolvedValue({
      ranking: [],
      total_actual_cost: 0,
      total_requests: 0,
      total_tokens: 0,
      start_date: '',
      end_date: ''
    })
  })

  it('uses last 24 hours as default dashboard range', async () => {
    mount(DashboardView, {
      global: {
        plugins: [createTestI18n()],
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          LoadingSpinner: true,
          Icon: true,
          DateRangePicker: true,
          Select: true,
          ModelDistributionChart: true,
          TokenUsageTrend: true,
          Line: true
        }
      }
    })

    await flushPromises()

    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    expect(getSnapshotV2).toHaveBeenCalledTimes(1)
    expect(getSnapshotV2).toHaveBeenCalledWith(expect.objectContaining({
      start_date: formatLocalDate(yesterday),
      end_date: formatLocalDate(now),
      granularity: 'hour'
    }))
  })

  const mountDashboard = async () => {
    const wrapper = mount(DashboardView, {
      global: {
        plugins: [createTestI18n()],
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          LoadingSpinner: true,
          Icon: true,
          DateRangePicker: true,
          Select: true,
          ModelDistributionChart: true,
          TokenUsageTrend: true,
          Line: true
        }
      }
    })
    await flushPromises()
    return wrapper
  }

  /**
   * 后端会回传 stats_stale（关闭预聚合 / 从未聚合 / 水位落后都会置 true）。
   * 这两个字段此前在全仓零消费者 —— 后端说"过期"，界面却照常显示成正常态。
   * 本组钉住它真的接到界面上了。
   */
  it('surfaces the staleness badge when the backend reports stats_stale', async () => {
    getSnapshotV2.mockResolvedValue({
      stats: {
        ...createDashboardStats(),
        stats_stale: true,
        stats_updated_at: '2026-09-16T10:00:00Z'
      },
      trend: [],
      models: []
    })

    const wrapper = await mountDashboard()
    expect(wrapper.text()).toContain('统计可能过期')
  })

  it('does not surface the staleness badge when stats are fresh', async () => {
    const wrapper = await mountDashboard()
    expect(wrapper.text()).not.toContain('统计可能过期')
  })

  /**
   * 统计卡的口径说明。
   *
   * 背景：snapshot-v2 的 stats 与所选日期区间无关（total_* 是全量累计、today_* 是服务端当日），
   * 切区间时 include_stats=false，stats 根本不会重新拉取 —— 数字不变是设计如此。
   * 但界面上此前对此零说明，用户切了区间看到数字不动就会误判成"数据不对"。
   *
   * 本组钉两件事：
   *   1. 说明是**常驻**的（首次加载就在，不是切区间后才冒出来）；
   *   2. 切区间后说明**仍然可见**，且此时 stats 确实没有被重新拉取。
   * 说明必须是默认可见的正文，所以断言走 wrapper.text()（tooltip 里的 title 文案不会进 text()）。
   */
  const mountDashboardWithRangeStub = async () => {
    const wrapper = mount(DashboardView, {
      global: {
        plugins: [createTestI18n()],
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          LoadingSpinner: true,
          Icon: true,
          DateRangePicker: DateRangePickerStub,
          Select: true,
          ModelDistributionChart: true,
          TokenUsageTrend: true,
          Line: true
        }
      }
    })
    await flushPromises()
    return wrapper
  }

  const SCOPE_NOTE_TEXT = '统计卡不随所选日期区间变化'

  it('shows the stats scope note on first load and keeps it visible after a date-range change', async () => {
    const wrapper = await mountDashboardWithRangeStub()

    // 首次加载：口径说明必须已经在场
    expect(wrapper.find('[data-testid="stats-scope-note"]').exists()).toBe(true)
    expect(wrapper.text()).toContain(SCOPE_NOTE_TEXT)
    expect(getSnapshotV2).toHaveBeenCalledTimes(1)
    expect(getSnapshotV2.mock.calls[0][0]).toMatchObject({ include_stats: true })

    // 切区间
    await wrapper.find('[data-testid="range-change"]').trigger('click')
    await flushPromises()

    // 切区间后确实重新拉了快照，但明确不要 stats（数字本就不该变）
    expect(getSnapshotV2).toHaveBeenCalledTimes(2)
    expect(getSnapshotV2.mock.calls[1][0]).toMatchObject({ include_stats: false })

    // 关键：说明仍然可见，不能只在首次加载出现
    expect(wrapper.find('[data-testid="stats-scope-note"]').exists()).toBe(true)
    expect(wrapper.text()).toContain(SCOPE_NOTE_TEXT)
  })

  it('shows the stats scope note even when the staleness badge is absent', async () => {
    // 默认 stats_stale=false，即没有"统计可能过期"角标 —— 口径说明仍须常驻
    const wrapper = await mountDashboard()

    expect(wrapper.text()).not.toContain('统计可能过期')
    expect(wrapper.find('[data-testid="stats-scope-note"]').exists()).toBe(true)
    expect(wrapper.text()).toContain(SCOPE_NOTE_TEXT)
  })

  it('shows the stats scope note and the staleness badge together without either hiding the other', async () => {
    getSnapshotV2.mockResolvedValue({
      stats: {
        ...createDashboardStats(),
        stats_stale: true,
        stats_updated_at: '2026-09-16T10:00:00Z'
      },
      trend: [],
      models: []
    })

    const wrapper = await mountDashboard()

    // 两个标注同时在场：一个说"口径与区间无关"，一个说"数据可能陈旧"，互不遮挡、互不矛盾
    expect(wrapper.find('[data-testid="stats-scope-note"]').exists()).toBe(true)
    expect(wrapper.text()).toContain(SCOPE_NOTE_TEXT)
    expect(wrapper.text()).toContain('统计可能过期')
  })

  /**
   * 国际化缺陷回归：英文语言包下，统计卡的两处标注必须走 i18n 渲染成英文。
   *
   * 这里刻意同时做**反向断言**（英文界面里不得出现任何汉字）：
   * 只断言"含英文"是抓不住硬编码中文的 —— 三处文案如果写死在模板里，
   * 英文 locale 下依然会原样渲染中文，而"含英文"的断言可能被其它文案满足。
   */
  it('renders the stats annotations in English under the en locale', async () => {
    getSnapshotV2.mockResolvedValue({
      stats: {
        ...createDashboardStats(),
        stats_stale: true,
        stats_updated_at: '2026-09-16T10:00:00Z'
      },
      trend: [],
      models: []
    })

    const wrapper = mount(DashboardView, {
      global: {
        plugins: [createTestI18n('en')],
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          LoadingSpinner: true,
          Icon: true,
          DateRangePicker: true,
          Select: true,
          ModelDistributionChart: true,
          TokenUsageTrend: true,
          Line: true
        }
      }
    })
    await flushPromises()

    // 正向断言收敛到具体元素，避免整页 text() 断言失败时产生超大 diff
    expect(wrapper.find('[data-testid="stats-scope-note"]').text()).toContain(
      'These stat cards do not follow the selected date range'
    )
    expect(wrapper.find('[data-testid="stats-stale-badge"]').text()).toContain('Stats may be stale')
    // 反向断言：英文界面里不该再冒出任何汉字（失败时只回报命中片段，不会拖垮 reporter）
    expect(wrapper.text()).not.toMatch(/[\u4e00-\u9fa5]/)
  })
})
