import { flushPromises } from '@vue/test-utils'
import { mountWithCostI18n as mount } from './costI18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveFinanceBatch, type FinanceBatch } from '@/api/financeLedger'
import FinanceBatchEditor from '../FinanceBatchEditor.vue'

vi.mock('@/api/financeLedger', () => ({ saveFinanceBatch: vi.fn() }))
const scope = { source: 'cockpit' as const, instanceId: 'local' }
const accounts = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }]
const stubs = { ConfirmDialog: { props: ['show'], emits: ['confirm', 'cancel'], template: '<div v-if="show" role="dialog"><button class="confirm-removal" @click="$emit(\'confirm\')">确认保存</button></div>' } }

describe('FinanceBatchEditor', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(saveFinanceBatch).mockResolvedValue({} as FinanceBatch) })

  it('allocates the paid total once, preserves selections across search and permits mixed plans', async () => {
    const wrapper = mount(FinanceBatchEditor, { props: { scope, accounts, channels: [] }, global: { stubs } })
    await wrapper.get('[aria-label="批次实付总额"]').setValue('100')
    await wrapper.get('[aria-label="批次采购渠道"]').setValue('seller')
    await wrapper.get('[aria-label="批次账号多选"]').setValue(['a', 'b', 'c']); await flushPromises()
    const split = wrapper.findAll('button').find(button => button.text().includes('均分'))!
    await split.trigger('click')
    expect(wrapper.get('[aria-label="分配金额 a"]').element).toHaveProperty('value', '33.33')
    expect(wrapper.get('[aria-label="分配金额 c"]').element).toHaveProperty('value', '33.34')
    await wrapper.get('[aria-label="搜索批次账号"]').setValue('Alpha')
    await wrapper.get('[aria-label="批次账号多选"]').setValue(['a']); await flushPromises()
    expect(wrapper.findAll('tbody tr')).toHaveLength(3)
    await wrapper.findAll('tbody tr')[1].findAll('input')[1].setValue('Pro')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(saveFinanceBatch).toHaveBeenCalledOnce()
    const batch = vi.mocked(saveFinanceBatch).mock.calls[0][0]
    expect(batch.scope).toEqual(scope); expect(batch.totalAmount).toBe(100); expect(batch.purchaseChannel).toBe('seller')
    expect(batch.allocations.map(row => row.amount)).toEqual([33.33, 33.33, 33.34])
    expect(batch.allocations[1].planLabel).toBe('Pro')
    expect(new Set(batch.allocations.map(row => row.id)).size).toBe(3)
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('requires confirmation for removed allocations and preserves unchanged timestamps and IDs', async () => {
    const occurredAtMs = 1793512345678
    const initial: FinanceBatch = { scope, batchId: '00000000-0000-4000-8000-000000000099', totalAmount: 100, currency: 'USD', occurredAtMs, events: accounts.slice(0, 2).map((account, index) => ({ ...scope, id: `00000000-0000-4000-8000-00000000000${index + 1}`, accountId: account.id, kind: 'purchase', amount: 50, currency: 'USD', occurredAtMs, coverageStartMs: occurredAtMs - 100, coverageEndMs: occurredAtMs + 10000, createdAtMs: 1, updatedAtMs: 1, voidedAtMs: null })) }
    const wrapper = mount(FinanceBatchEditor, { props: { scope, accounts, channels: [], initial }, global: { stubs } })
    await wrapper.get('[aria-label="移除分配 b"]').trigger('click'); await flushPromises()
    await wrapper.get('[aria-label="分配金额 a"]').setValue('100')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(saveFinanceBatch).not.toHaveBeenCalled()
    await wrapper.get('.confirm-removal').trigger('click'); await flushPromises()
    expect(saveFinanceBatch).toHaveBeenCalledWith(expect.objectContaining({ batchId: initial.batchId, occurredAtMs, allocations: [expect.objectContaining({ id: initial.events[0].id, amount: 100, occurredAtMs, coverageStartMs: initial.events[0].coverageStartMs, coverageEndMs: initial.events[0].coverageEndMs })] }))
  })
})
