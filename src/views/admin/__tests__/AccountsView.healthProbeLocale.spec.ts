import { beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import i18n from '@/i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import AccountsView from '../AccountsView.vue'

const { list, testAccount } = vi.hoisted(() => ({ list: vi.fn(), testAccount: vi.fn() }))
vi.mock('@/api/admin', () => ({ adminAPI: {
  accounts: {
    list, testAccount,
    listWithEtag: vi.fn().mockResolvedValue({ notModified: true, etag: null, data: null }),
    getBatchTodayStats: vi.fn().mockResolvedValue({ stats: {} }),
    getUpstreamBillingProbeSettings: vi.fn().mockResolvedValue({ enabled: false, interval_minutes: 30 }),
  },
  proxies: { getAll: vi.fn().mockResolvedValue([]) },
  groups: { getAll: vi.fn().mockResolvedValue([]) },
} }))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn(), showInfo: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ token: 'fixture-token' }) }))

const account = { id: 27, name: '账号原文 Alpha', platform: 'openai', type: 'apikey', status: 'active', schedulable: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
const stubNames = ['DataTable', 'Pagination', 'ConfirmDialog', 'AccountTableFilters', 'AccountBulkActionsBar', 'AccountActionMenu', 'ImportDataModal', 'ReAuthAccountModal', 'AccountTestModal', 'AccountStatsModal', 'ScheduledTestsPanel', 'SyncFromCrsModal', 'TempUnschedStatusModal', 'ErrorPassthroughRulesModal', 'TLSFingerprintProfilesModal', 'CreateAccountModal', 'EditAccountModal', 'BulkEditAccountModal', 'PlatformTypeBadge', 'AccountCapacityCell', 'AccountStatusIndicator', 'AccountTodayStatsCell', 'AccountGroupsCell', 'AccountUsageCell', 'HelpTooltip', 'Icon']
function renderPage() {
  return mount(AccountsView, { global: {
    plugins: [i18n],
    stubs: {
      ...Object.fromEntries(stubNames.map(name => [name, true])),
      AppLayout: { template: '<div><slot /></div>' },
      TablePageLayout: { template: '<div><slot name="filters" /><slot name="table" /><slot name="pagination" /></div>' },
      AccountTableActions: { template: '<div><slot name="beforeCreate" /><slot name="after" /></div>' },
    },
  } })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  testAccount.mockReset()
  list.mockResolvedValue({ items: [account], total: 1, page: 1, page_size: 20, pages: 1 })
  i18n.global.setLocaleMessage('en', en)
  i18n.global.setLocaleMessage('zh', zh)
  i18n.global.locale.value = 'zh'
})

it('localizes queued/running/healthy presentations without changing probe calls, timing guards or raw account names', async () => {
  let finish!: (result: { success: boolean }) => void
  testAccount.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const wrapper = renderPage(); await flushPromises()
  const setup = (wrapper.vm as any).$!.setupState
  setup.showAutoRefreshDropdown = true
  setup.setAutoHealthProbeEnabled(true)
  await flushPromises()
  expect(wrapper.text()).toContain('逐账号健康巡检')
  expect(wrapper.text()).toContain('巡检将在列表自动刷新时轮询当前页账号')
  expect(testAccount).not.toHaveBeenCalled()
  i18n.global.locale.value = 'en'; await flushPromises()
  expect(wrapper.text()).toContain('Per-account health checks')
  expect(wrapper.text()).toContain('Checks will rotate through this page during automatic list refreshes')
  const probing = setup.maybeProbeNextVisibleAccount()
  await flushPromises()
  expect(wrapper.text()).toContain('Checking 账号原文 Alpha...')
  expect(testAccount).toHaveBeenCalledOnce()
  expect(testAccount).toHaveBeenCalledWith(27)
  finish({ success: true }); await probing; await flushPromises()
  expect(wrapper.text()).toContain('账号原文 Alpha: Healthy')
  i18n.global.locale.value = 'zh'; await flushPromises()
  expect(wrapper.text()).toContain('账号原文 Alpha：正常')
  await setup.maybeProbeNextVisibleAccount()
  expect(testAccount).toHaveBeenCalledOnce()
  setup.setAutoHealthProbeEnabled(false); await flushPromises()
  expect(wrapper.text()).not.toContain('账号原文 Alpha：正常')
  wrapper.unmount()
})

it('retains a failed service diagnostic verbatim while localizing the empty-page state', async () => {
  testAccount.mockResolvedValueOnce({ success: false, message: '来源诊断原文' })
  const wrapper = renderPage(); await flushPromises()
  const setup = (wrapper.vm as any).$!.setupState
  setup.showAutoRefreshDropdown = true
  setup.setAutoHealthProbeEnabled(true)
  i18n.global.locale.value = 'en'
  await setup.maybeProbeNextVisibleAccount(); await flushPromises()
  expect(wrapper.text()).toContain('账号原文 Alpha: 来源诊断原文')
  expect(testAccount).toHaveBeenCalledOnce()
  wrapper.unmount()

  list.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 20, pages: 0 })
  const empty = renderPage(); await flushPromises()
  const emptySetup = (empty.vm as any).$!.setupState
  emptySetup.showAutoRefreshDropdown = true
  emptySetup.setAutoHealthProbeEnabled(true)
  await emptySetup.maybeProbeNextVisibleAccount(); await flushPromises()
  expect(empty.text()).toContain('No eligible accounts on this page')
  expect(testAccount).toHaveBeenCalledOnce()
  empty.unmount()
})
