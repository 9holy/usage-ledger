import './usageI18nFixture'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import LocalCostChannels from '../LocalCostChannels.vue'
import { getFinanceLedger, type FinanceSnapshot } from '@/api/financeLedger'

vi.mock('@/api/financeLedger', () => ({ getFinanceLedger: vi.fn() }))

it('loads a chosen purchase channel through the existing local financial scope and preserves unknown costs', async () => {
  const snapshot: FinanceSnapshot = { events: [], totalEvents: 0, purchaseChannels: ['Direct purchase', 'Renewal shop'], planLabels: [], byAccount: [], summary: { currencies: [], eventCount: 0, hasEnteredFacts: false, unresolvedTerminationCount: 0 } }
  vi.mocked(getFinanceLedger).mockResolvedValue(snapshot)
  const wrapper = mount(LocalCostChannels, { props: { snapshot, startMs: 1000, endMs: 9000, accounts: [] } })
  expect(wrapper.text()).toContain('尚未录入采购费用')
  expect(getFinanceLedger).not.toHaveBeenCalled()
  await wrapper.get('select').setValue('Direct purchase'); await flushPromises()
  expect(getFinanceLedger).toHaveBeenLastCalledWith({ source: 'local', instanceId: 'usage-monitor', startMs: 1000, endMs: 9000, purchaseChannel: 'Direct purchase' })
  vi.mocked(getFinanceLedger).mockRejectedValue(new Error('channel read failed'))
  await wrapper.get('select').setValue('Renewal shop'); await flushPromises()
  expect(wrapper.get('[role=alert]').text()).toContain('channel read failed')
  expect(wrapper.find('.channel-results').exists()).toBe(false)
  wrapper.unmount()
})
