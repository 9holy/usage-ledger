import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { getLocalCostLive, type LocalCostLiveReport } from '@/api/localCost'
import { useLocalCostLive } from '../useLocalCostLive'

vi.mock('@/api/localCost', () => ({ getLocalCostLive: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('keeps one polling loop, ignores old scopes, retains a failed sample and pauses when hidden', async () => {
  vi.useFakeTimers()
  const scope = ref('account-a'), enabled = ref(true)
  let visibility = 'visible', pending!: (report: LocalCostLiveReport) => void
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState)
  vi.mocked(getLocalCostLive).mockImplementationOnce(() => new Promise(resolve => { pending = resolve }))
    .mockResolvedValue({ accountKey: 'account-b', live: {} } as LocalCostLiveReport)
  let state!: ReturnType<typeof useLocalCostLive>
  const wrapper = mount({ setup() { state = useLocalCostLive(scope, enabled); return () => null } })
  await vi.advanceTimersByTimeAsync(6000)
  expect(getLocalCostLive).toHaveBeenCalledTimes(1)
  scope.value = 'account-b'; await flushPromises()
  pending({ accountKey: 'account-a', live: {} } as LocalCostLiveReport); await flushPromises()
  expect(state.report.value?.accountKey).toBe('account-b')
  vi.mocked(getLocalCostLive).mockRejectedValue(new Error('temporary read error'))
  await vi.advanceTimersByTimeAsync(2000)
  expect(state.report.value?.accountKey).toBe('account-b'); expect(state.error.value).toContain('temporary')
  visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); await flushPromises()
  const count = vi.mocked(getLocalCostLive).mock.calls.length
  await vi.advanceTimersByTimeAsync(6000); expect(getLocalCostLive).toHaveBeenCalledTimes(count)
  visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await flushPromises()
  expect(getLocalCostLive).toHaveBeenCalledTimes(count + 1)
  wrapper.unmount(); await vi.advanceTimersByTimeAsync(6000)
  expect(getLocalCostLive).toHaveBeenCalledTimes(count + 1)
})

it('drops an old source sample when the same account switches call sources',async()=>{
  vi.useFakeTimers();vi.mocked(getLocalCostLive).mockReset()
  const account=ref('codex:a'),enabled=ref(true),source=ref('direct')
  let pending!:(report:LocalCostLiveReport)=>void
  vi.mocked(getLocalCostLive).mockImplementationOnce(()=>new Promise(resolve=>{pending=resolve})).mockResolvedValue({accountKey:'codex:a',sourceKey:'cockpit',live:{}} as LocalCostLiveReport)
  let state!:ReturnType<typeof useLocalCostLive>
  const wrapper=mount({setup(){state=useLocalCostLive(account,enabled,source);return()=>null}})
  source.value='cockpit';await flushPromises()
  pending({accountKey:'codex:a',sourceKey:'direct',live:{}} as LocalCostLiveReport);await flushPromises()
  expect(getLocalCostLive).toHaveBeenLastCalledWith('codex:a','cockpit')
  expect(state.report.value?.sourceKey).toBe('cockpit')
  source.value='all';await flushPromises();expect(getLocalCostLive).toHaveBeenLastCalledWith('codex:a')
  wrapper.unmount()
})
