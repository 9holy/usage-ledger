import { flushPromises } from '@vue/test-utils'
import { mountWithCostI18n as mount } from './costI18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getFinanceBatch, getFinanceLedger, getFinanceRelatedEvents, saveFinanceEvent, voidFinanceBatch, voidFinanceEvent, type FinanceEvent, type FinanceSnapshot } from '@/api/financeLedger'
import CostEventsPanel from '../CostEventsPanel.vue'

vi.mock('@/api/financeLedger', () => ({ getFinanceBatch: vi.fn(), getFinanceLedger: vi.fn(), getFinanceRelatedEvents: vi.fn(), saveFinanceBatch: vi.fn(), saveFinanceEvent: vi.fn(), voidFinanceBatch: vi.fn(), voidFinanceEvent: vi.fn() }))
const event: FinanceEvent = { id: '00000000-0000-4000-8000-000000000001', source: 'cockpit', instanceId: 'local', accountId: 'a', kind: 'purchase', amount: 100, currency: 'CNY', occurredAtMs: 1792080045123, coverageStartMs: 1792080000456, coverageEndMs: 1792166400789, note: 'invoice', createdAtMs: 1, updatedAtMs: 1, voidedAtMs: null }
const empty = (): FinanceSnapshot => ({ events: [], totalEvents: 0, purchaseChannels: [], planLabels: [], byAccount: [], summary: { eventCount: 0, hasEnteredFacts: false, unresolvedTerminationCount: 0, currencies: [] } })
const facts = (): FinanceSnapshot => ({ ...empty(), events: [{ ...event }], totalEvents: 1, summary: { eventCount: 1, hasEnteredFacts: true, unresolvedTerminationCount: 1, currencies: [{ currency: 'CNY', cashOutlay: 100, refunds: 0, terminationLoss: 30, amortizedExpense: 40, accruedExpense: 40, recognizedLoss: 0, expenseCredits: 0, netExpense: null, remainingPrepaid: null, ongoingHourlyExpense: null, hasEnteredFacts: true, unresolvedCount: 1, missingCoverageCount: 0 }] } })

function panel() {
  return mount(CostEventsPanel, { props: { source: 'cockpit', instanceId: 'local', startMs: 1, endMs: 1792166400000, accounts: [{ id: 'a', name: 'Account A' }] }, global: { stubs: { ConfirmDialog: { props: ['show'], emits: ['confirm', 'cancel'], template: '<div v-if="show" role="dialog"><button class="confirm-void" @click="$emit(\'confirm\')">确认作废</button><button class="cancel-void" @click="$emit(\'cancel\')">取消</button></div>' } } } })
}

describe('CostEventsPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(getFinanceLedger).mockResolvedValue(empty()); vi.mocked(getFinanceRelatedEvents).mockResolvedValue([]); vi.mocked(saveFinanceEvent).mockResolvedValue(event); vi.mocked(voidFinanceEvent).mockResolvedValue({ ...event, voidedAtMs: 2 }) })

  it('keeps no entered facts distinct from actual zero and shows independent components', async () => {
    const wrapper = panel(); await flushPromises()
    expect(wrapper.text()).toContain('还没有已录入的有效财务记录')
    expect(wrapper.find('.finance-summary-row').exists()).toBe(false)
    vi.mocked(getFinanceLedger).mockResolvedValue(facts())
    await wrapper.get('[aria-label="刷新财务记录"]').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('实际付款'); expect(wrapper.text()).toContain('本期分摊费用'); expect(wrapper.text()).toContain('停用损失')
    expect(wrapper.text()).toContain('暂未计入总费用')
  })

  it('adds an explicit fact and edits without moving its account or id', async () => {
    const wrapper = panel(); await flushPromises()
    await wrapper.get('.finance-primary').trigger('click')
    const form = wrapper.get('form')
    await form.get('input[list]').setValue('a'); await form.get('input[type="number"]').setValue('20')
    await form.trigger('submit'); await flushPromises()
    expect(saveFinanceEvent).toHaveBeenCalledWith(expect.objectContaining({ source: 'cockpit', instanceId: 'local', accountId: 'a', amount: 20, coverageStartMs: null, coverageEndMs: null }))
    expect(wrapper.emitted('changed')).toHaveLength(1)
    vi.mocked(getFinanceLedger).mockResolvedValue(facts())
    await wrapper.get('[aria-label="刷新财务记录"]').trigger('click'); await flushPromises()
    await wrapper.get('[aria-label="编辑财务记录"]').trigger('click')
    expect(wrapper.get('input[list]').attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="number"]').setValue('125')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(saveFinanceEvent).toHaveBeenLastCalledWith(expect.objectContaining({ id: event.id, accountId: 'a', amount: 125, occurredAtMs: event.occurredAtMs, coverageStartMs: event.coverageStartMs, coverageEndMs: event.coverageEndMs }))
  })

  it('requires explicit void confirmation and keeps a voided row visible', async () => {
    vi.mocked(getFinanceLedger).mockResolvedValue(facts())
    const wrapper = panel(); await flushPromises()
    await wrapper.get('[aria-label="作废财务记录"]').trigger('click')
    expect(voidFinanceEvent).not.toHaveBeenCalled()
    await wrapper.get('.cancel-void').trigger('click')
    expect(voidFinanceEvent).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="作废财务记录"]').trigger('click')
    vi.mocked(getFinanceLedger).mockResolvedValue({ ...empty(), events: [{ ...event, voidedAtMs: 2 }] })
    await wrapper.get('.confirm-void').trigger('click'); await flushPromises()
    expect(voidFinanceEvent).toHaveBeenCalledWith({ source: 'cockpit', instanceId: 'local' }, event.id)
    expect(wrapper.text()).toContain('已作废')
    expect(wrapper.get('[aria-label="编辑财务记录"]').attributes('disabled')).toBeDefined()
  })

  it('preserves all unchanged epochs through a DST fold and only parses edited time fields', async () => {
    const NativeDate = Date
    const parsedLocalTimes: string[] = []
    const transition = NativeDate.parse('2026-11-01T06:00:00Z')
    class FoldDate extends NativeDate {
      static now() { return NativeDate.parse('2026-11-01T06:45:00Z') }
      constructor(value?: string | number) {
        if (typeof value === 'string' && value.startsWith('2026-11-01T01:')) {
          parsedLocalTimes.push(value)
          super(`${value}-04:00`)
        } else super(value ?? NativeDate.now())
      }
      getTimezoneOffset() { return this.getTime() < transition ? 240 : 300 }
    }
    vi.stubGlobal('Date', FoldDate)
    try {
      const folded = { ...event, occurredAtMs: NativeDate.parse('2026-11-01T06:30:00Z'), coverageStartMs: NativeDate.parse('2026-11-01T05:30:00Z'), coverageEndMs: NativeDate.parse('2026-11-01T06:30:00Z') }
      vi.mocked(getFinanceLedger).mockResolvedValue({ ...facts(), events: [folded] })
      const wrapper = panel(); await flushPromises()
      await wrapper.get('[aria-label="编辑财务记录"]').trigger('click')
      await wrapper.get('input[type="number"]').setValue('125')
      await wrapper.get('form').trigger('submit'); await flushPromises()
      expect(parsedLocalTimes).toEqual([])
      expect(saveFinanceEvent).toHaveBeenLastCalledWith(expect.objectContaining({ occurredAtMs: folded.occurredAtMs, coverageStartMs: folded.coverageStartMs, coverageEndMs: folded.coverageEndMs }))

      await wrapper.get('[aria-label="编辑财务记录"]').trigger('click')
      const inputs = wrapper.findAll('input[type="datetime-local"]')
      await inputs[0].setValue('2026-11-01T01:35')
      await inputs[1].setValue('2026-11-01T01:10')
      await inputs[2].setValue('2026-11-01T01:50')
      await wrapper.get('form').trigger('submit'); await flushPromises()
      expect(saveFinanceEvent).toHaveBeenLastCalledWith(expect.objectContaining({ occurredAtMs: NativeDate.parse('2026-11-01T05:35:00Z'), coverageStartMs: NativeDate.parse('2026-11-01T05:10:00Z'), coverageEndMs: NativeDate.parse('2026-11-01T05:50:00Z') }))
      expect(parsedLocalTimes).toEqual(expect.arrayContaining(['2026-11-01T01:35', '2026-11-01T01:10', '2026-11-01T01:50']))

      parsedLocalTimes.length = 0
      await wrapper.get('.finance-primary').trigger('click')
      await wrapper.get('input[list]').setValue('a')
      await wrapper.get('input[type="number"]').setValue('20')
      await wrapper.get('form').trigger('submit'); await flushPromises()
      expect(parsedLocalTimes).toEqual([])
      expect(saveFinanceEvent).toHaveBeenLastCalledWith(expect.objectContaining({ occurredAtMs: FoldDate.now() }))
      wrapper.unmount()
    } finally { vi.stubGlobal('Date', NativeDate) }
  })

  it('discards stale instance reads and clears an old instance editor', async () => {
    let resolveOld!: (value: FinanceSnapshot) => void
    vi.mocked(getFinanceLedger).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const wrapper = panel()
    await wrapper.get('.finance-primary').trigger('click')
    await wrapper.setProps({ source: 'cliproxy', instanceId: 'remote-2' }); await flushPromises()
    resolveOld(facts()); await flushPromises()
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('invoice')
    expect(getFinanceLedger).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'cliproxy', instanceId: 'remote-2' }))
  })

  it('queries all history and pages without changing the operating window, and edits a full batch', async () => {
    vi.mocked(getFinanceLedger).mockResolvedValue({ ...facts(), totalEvents: 201, purchaseChannels: ['seller'], planLabels: ['plan'], events: [{ ...event, batchId: 'batch' }] })
    vi.mocked(getFinanceBatch).mockResolvedValue({ scope: { source: 'cockpit', instanceId: 'local' }, batchId: 'batch', totalAmount: 100, currency: 'CNY', occurredAtMs: event.occurredAtMs, events: [event] })
    const wrapper = panel(); await flushPromises()
    await wrapper.get('[aria-label="显示哪些财务记录"]').setValue('all'); await flushPromises()
    await wrapper.get('[aria-label="下一页财务记录"]').trigger('click'); await flushPromises()
    expect(getFinanceLedger).toHaveBeenLastCalledWith(expect.objectContaining({ listMode: 'all', offset: 100, startMs: 1, endMs: 1792166400000 }))
    await wrapper.get('[aria-label="筛选采购渠道"]').setValue('seller'); await flushPromises()
    expect(getFinanceLedger).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, purchaseChannel: 'seller' }))
    await wrapper.get('[aria-label="编辑财务记录"]').trigger('click'); await flushPromises()
    expect(getFinanceBatch).toHaveBeenCalledWith({ source: 'cockpit', instanceId: 'local' }, 'batch')
    expect(wrapper.find('[aria-label="采购批次表单"]').exists()).toBe(true)
    await wrapper.get('[aria-label="作废财务记录"]').trigger('click')
    await wrapper.get('.confirm-void').trigger('click'); await flushPromises()
    expect(voidFinanceBatch).toHaveBeenCalledWith({ source: 'cockpit', instanceId: 'local' }, 'batch')
    expect(voidFinanceEvent).not.toHaveBeenCalled()
  })

  it('saves an explicitly selected refund relationship from the same account and currency', async () => {
    vi.mocked(getFinanceRelatedEvents).mockResolvedValue([event])
    const wrapper = panel(); await flushPromises(); await wrapper.get('.finance-primary').trigger('click')
    await wrapper.get('input[list]').setValue('a')
    const selects = wrapper.get('form').findAll('select')
    await selects[0].setValue('refund'); await flushPromises()
    expect(getFinanceRelatedEvents).toHaveBeenLastCalledWith({ source: 'cockpit', instanceId: 'local' }, 'a', 'CNY')
    await wrapper.get('[aria-label="对应的原记录"]').setValue(event.id)
    await wrapper.get('input[type="number"]').setValue('10'); await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(saveFinanceEvent).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refund', relatedEventId: event.id, coverageStartMs: null, coverageEndMs: null }))
  })
})
