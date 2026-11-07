import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import en from '@/i18n/locales/en'
import centerEn from '@/i18n/locales/en/costCenter'
import costDataEn from '@/i18n/locales/en/costData'
import { invoke } from '@tauri-apps/api/core'
import { getActiveConnection, setActiveConnection } from '@/api/url'
import { useConnectionStore } from '@/stores/connection'
import { loadUsdCnyExchangeRate } from '@/features/cost-center/exchangeRate'
import type { useCostCenterData as DataFactory } from '@/features/cost-center/useCostCenterData'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'

const shared = vi.hoisted(() => ({ data: null as unknown as ReturnType<typeof DataFactory>, get: vi.fn(), unified: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/cliproxy/client', () => ({ cliproxyClient: { get: shared.get } }))
vi.mock('@/features/cost-center/exchangeRate', async original => ({ ...await original<typeof import('@/features/cost-center/exchangeRate')>(), loadUsdCnyExchangeRate: vi.fn() }))
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/admin/cost-center', query: { desktop: '1', panel: 'api' } }), useRouter: () => ({ replace: vi.fn().mockResolvedValue(undefined), push: vi.fn() }) }))
vi.mock('@/features/cost-center/useCostCenterData', async original => ({ ...await original<typeof import('@/features/cost-center/useCostCenterData')>(), useCostCenterData: () => shared.data }))
vi.mock('@/features/cost-center/useUnifiedCost', async original => {
  const actual = await original<typeof import('@/features/cost-center/useUnifiedCost')>()
  return { ...actual, useUnifiedCost: (...args: Parameters<typeof actual.useUnifiedCost>) => ({ ...actual.useUnifiedCost(...args), loadUnified: shared.unified }) }
})
import CostCenterView from '../admin/CostCenterView.vue'

const endMs = Date.parse('2026-11-07T12:00:00Z')
const rate = { rate: 7, rateDate: null, fetchedAt: null, source: 'override' as const }
const response = (path: string, version = 'v8.fixture-a') => ({
  data: path === '/auth-files' ? { files: [] }
    : path === '/config' ? { debug: false, routing: { strategy: 'weighted-round-robin' } }
      : path === '/debug' ? { debug: false }
        : path === '/routing/strategy' ? { strategy: 'weighted-round-robin' } : {},
  headers: { 'x-cpa-version': version, 'x-cpa-commit': 'fixture-commit', 'x-cpa-build-date': '2026-11-07' },
})
let wrapper: VueWrapper | null = null

function usageEvent(): CliproxyUsageEvent {
  return { id: 1, requested_at: endMs - 1_000, provider: 'openai', executor_type: 'fixture', model: 'fixture', alias: 'fixture',
    auth_index: 'raw-index', auth_type: 'apikey', source: 'fixture', reasoning_effort: 'high', service_tier: 'auto',
    latency_ms: 50, ttft_ms: 10, failed: false, status_code: 200, input_tokens: 1_000_000, output_tokens: 0,
    reasoning_tokens: 0, cached_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 1_000_000,
    primary_used_percent: null, primary_reset_at: null, primary_used_tokens: null, primary_remaining_tokens: null, primary_limit_tokens: null,
    secondary_used_percent: null, secondary_reset_at: null, secondary_used_tokens: null, secondary_remaining_tokens: null, secondary_limit_tokens: null }
}

beforeEach(async () => {
  i18n.global.setLocaleMessage('en', { ...en, costData: costDataEn, costCenter: centerEn })
  i18n.global.locale.value = 'en'
  vi.useFakeTimers(); vi.setSystemTime(endMs); vi.clearAllMocks()
  localStorage.clear(); setActivePinia(createPinia())
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  const store = useConnectionStore()
  store.connections = [{ id: 'same-cpa', name: 'CPA', type: 'cliproxy', baseUrl: 'http://127.0.0.1:8317', apiKey: '', secretKey: 'fixture-key-a', lastUsed: 0 }]
  store.activeId = 'same-cpa'
  setActiveConnection(store.active)
  shared.get.mockImplementation(async (path: string) => response(path))
  vi.mocked(loadUsdCnyExchangeRate).mockResolvedValue(rate)
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'read_cost_profiles' || command === 'read_cliproxy_model_prices') return '{}' as never
    if (command === 'read_cliproxy_usage_events') return JSON.stringify({ available: true, sourceInstanceId: 'local', managementLinkAllowed: true, events: [], readStartMs: endMs - 30 * 86400000, readEndMs: endMs }) as never
    if (command === 'finance_ledger_query') return { events: [], totalEvents: 0, byAccount: [], purchaseChannels: [], planLabels: [], summary: { hasEnteredFacts: false, eventCount: 0, unresolvedTerminationCount: 0, currencies: [] } } as never
    if (command === 'model_catalog_quote_batch') return [] as never
    return null as never
  })
  const actual = await vi.importActual<typeof import('@/features/cost-center/useCostCenterData')>('@/features/cost-center/useCostCenterData')
  shared.data = actual.useCostCenterData()
})
afterEach(() => { wrapper?.unmount(); wrapper = null; setActiveConnection(null); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; vi.restoreAllMocks(); vi.useRealTimers() })

function open() {
  wrapper = mount(CostCenterView, { global: { plugins: [i18n], stubs: {
    RouterLink: { template: '<a><slot /></a>' },
    MetricCell: { props: ['label', 'value', 'note'], template: '<div class="metric" :data-label="label"><strong>{{ value }}</strong><small>{{ note }}</small></div>' },
    CostLineChart: true, AdaptiveOperationsCharts: true, ModelContributionChart: true, CostProfileInspector: true,
    CostApiAccessPanel: true, DataGovernancePanel: true, CostEventsPanel: true, UpstreamProbeCell: true,
  } } })
  return wrapper
}

describe('CPA cost-page management and local read contracts', () => {
  it('does not present complete local expenses when cost profiles could not be read, while preserving measured usage and known subtotals', async () => {
    const native = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'read_cost_profiles') throw new Error('fixture profile read denied')
      if (command === 'read_cliproxy_model_prices') return JSON.stringify({ fixture: { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6 } }) as never
      if (command === 'read_cliproxy_usage_events') return JSON.stringify({ available: true, sourceInstanceId: 'local', managementLinkAllowed: true, events: [usageEvent()], readStartMs: endMs - 30 * 86400000, readEndMs: endMs }) as never
      return native(command, args)
    })
    const view = open(); await flushPromises()
    const state = view.vm as any
    expect(shared.data.rangeAccountStats.value['cliproxy:raw-index'].requests).toBe(1)
    expect(shared.data.rangeAccountStats.value['cliproxy:raw-index'].cost).toBeCloseTo(0.4)
    expect(state.financialCosts.get('cliproxy:raw-index').knownWindowExpenseCny).toBe(0)
    expect(state.financialCosts.get('cliproxy:raw-index').windowExpenseCny).toBeNull()
    expect(state.financialCosts.get('cliproxy:raw-index').hourlyCny).toBeNull()
    expect(state.operatingSummary.expenseCny.total).toBeNull()
    expect(state.operatingSummary.expenseCny.knownSubtotal).toBeCloseTo(2.8)
    expect(state.operatingState).toBe('partial')
    expect(shared.data.accountEconomics.value).toBeNull()
    expect(view.text()).toContain('fixture profile read denied')
  })

  it('displays the running version reported by the same management response and retains explicit false/zero', async () => {
    const view = open(); await flushPromises()
    expect((view.vm as any).cliproxyOverview).toEqual({ version: 'v8.fixture-a', authFileCount: 0, routingStrategy: 'weighted-round-robin', debug: false })
    expect(new Set(shared.get.mock.calls.map(([path]) => path))).toEqual(new Set(['/config', '/auth-files', '/api-key-usage', '/debug', '/routing/strategy']))
    expect(invoke).toHaveBeenCalledWith('read_cliproxy_usage_events', { withMetadata: true })
    expect(invoke).toHaveBeenCalledWith('read_cliproxy_model_prices')
    expect(shared.get.mock.calls.some(([path]) => path === '/latest-version' || path === '/usage-queue' || path === '/logs')).toBe(false)
  })

  it.each(['URL', 'management key'])('discards an entire old batch when the same connection ID changes %s while the exchange-rate read is pending', async changed => {
    let finishRate!: (value: typeof rate) => void
    let finishNextConfig!: (value: ReturnType<typeof response>) => void
    vi.mocked(loadUsdCnyExchangeRate).mockImplementationOnce(() => new Promise(resolve => { finishRate = resolve }))
    const load = vi.spyOn(shared.data, 'loadFromCliproxy')
    open(); await flushPromises()
    expect(finishRate).toBeTypeOf('function')
    expect(load).not.toHaveBeenCalled()
    const store = useConnectionStore()
    store.connections = [{ ...store.active!, ...(changed === 'URL' ? { baseUrl: 'http://localhost:8317' } : { secretKey: 'fixture-key-b' }) }]
    setActiveConnection(store.active)
    expect(getActiveConnection()?.id).toBe('same-cpa')
    shared.get.mockImplementation(async (path: string) => path === '/config'
      ? new Promise<ReturnType<typeof response>>(resolve => { finishNextConfig = resolve }) : response(path, 'v8.fixture-b'))
    finishRate(rate)
    await flushPromises()
    // The first management response must never be labeled as the replacement connection.
    expect(load).not.toHaveBeenCalled()
    expect((wrapper!.vm as any).cliproxyOverview?.version ?? null).not.toBe('v8.fixture-a')
    if (finishNextConfig) finishNextConfig(response('/config', 'v8.fixture-b'))
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(1)
    expect((wrapper!.vm as any).cliproxyOverview.version).toBe('v8.fixture-b')
  })
})
