import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import LocalCostSpeedPanel from '../LocalCostSpeedPanel.vue'
import type { LocalCostLiveReport } from '@/api/localCost'

vi.mock('@/features/cost-center/components/CostLineChart.vue', () => ({ default: { name: 'CostLineChart', props: ['series'], template: '<div />' } }))

it('displays measured rates and leaves unavailable zero samples as gaps', () => {
  const report = { accountKey: 'api:all', live: { sampledAtMs: 1000, windows: [{ seconds: 60, observedOutputTokens: 120, outputTokensPerSecond: 2, complete: true, sourceComplete: true, coveredMs: 60000 }], byModel: [], timeline: [{ startMs: 0, outputTokens: 0, observedOutputTokens: 0, sourceComplete: false }, { startMs: 60000, outputTokens: null, observedOutputTokens: 120, sourceComplete: false }, { startMs: 120000, outputTokens: 0, observedOutputTokens: 0, sourceComplete: true }] } } as unknown as LocalCostLiveReport
  const wrapper = mount(LocalCostSpeedPanel, { props: { report, error: '', name: 'API' } })
  expect(wrapper.get('.speed-reading').text()).toContain('2.00')
  expect(wrapper.getComponent({ name: 'CostLineChart' }).props('series')[0].data).toEqual([null, 120, 0])
  wrapper.unmount()
})
