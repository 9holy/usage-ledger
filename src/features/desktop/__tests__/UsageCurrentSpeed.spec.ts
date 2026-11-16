import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import UsageCurrentSpeed from '../UsageCurrentSpeed.vue'
import type { LiveSnapshot } from '@/api/usageMonitor'

afterEach(() => vi.useRealTimers())
it('separates current measured speed from average output and expires stale samples', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000)
  const live = { currentRates: [
    { tool: 'codex', model: 'gpt-6.1-sol', sessionKey: 'codex:a', outputTokensPerSecond: 120, sampledAtMs: 100000, intervalMs: 1000 },
    { tool: 'claude', model: 'claude-opus', sessionKey: 'claude:b', outputTokensPerSecond: 60, sampledAtMs: 100000, intervalMs: 2000 },
  ], windows: [{ seconds: 60, outputTokensPerSecond: 5 }] } as LiveSnapshot
  const wrapper = mount(UsageCurrentSpeed, { props: { live, running: 2 } })
  expect(wrapper.get('.current-reading strong').text()).toBe('180Token/s')
  await wrapper.setProps({ tool: 'claude' })
  expect(wrapper.get('.current-reading strong').text()).toBe('60Token/s')
  expect(wrapper.text()).not.toContain('gpt-6.1-sol')
  await vi.advanceTimersByTimeAsync(11000)
  expect(wrapper.get('.current-reading strong').text()).toBe('运行中，等待用量回传')
  expect(wrapper.find('.current-model').exists()).toBe(false)
  wrapper.unmount()
})

it('does not present average rates as current speed when continuous reports are absent', () => {
  const wrapper = mount(UsageCurrentSpeed, { props: { live: { windows: [{ seconds: 60, outputTokensPerSecond: 500 }] } as LiveSnapshot } })
  expect(wrapper.get('.current-reading strong').text()).toBe('等待速度数据')
  expect(wrapper.text()).not.toContain('500')
  wrapper.unmount()
})
