import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { getModelsByPlatform } from '@/composables/useModelWhitelist'

const copyToClipboard = vi.fn().mockResolvedValue(true)
const { syncUpstreamModels, showSuccess } = vi.hoisted(() => ({
  syncUpstreamModels: vi.fn(),
  showSuccess: vi.fn()
}))

vi.mock('@/api/admin/accounts', () => ({
  accountsAPI: { syncUpstreamModels }
}))

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => (key === 'common.copy' ? '复制' : key)
    })
  }
})

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    showError: vi.fn(),
    showSuccess,
    showInfo: vi.fn()
  })
}))

vi.mock('@/composables/useClipboard', () => ({
  useClipboard: () => ({
    copyToClipboard
  })
}))

import ModelWhitelistSelector from '../ModelWhitelistSelector.vue'

function mountSelector() {
  return mount(ModelWhitelistSelector, {
    props: {
      modelValue: [],
      platform: 'openai'
    },
    global: {
      stubs: {
        ModelIcon: true
      }
    }
  })
}

function findModelRow(wrapper: ReturnType<typeof mountSelector>, modelId: string) {
  const row = wrapper
    .findAll('[data-testid="model-option"]')
    .find(candidate => candidate.text().includes(modelId))

  if (!row) {
    throw new Error(`Model row not found: ${modelId}`)
  }

  return row
}

describe('ModelWhitelistSelector', () => {
  beforeEach(() => {
    copyToClipboard.mockClear()
    syncUpstreamModels.mockReset()
    showSuccess.mockClear()
  })

  it('keeps selection marks current when the selected model list changes', async () => {
    const wrapper = mountSelector()
    await wrapper.get('div.cursor-pointer').trigger('click')
    expect(findModelRow(wrapper, 'gpt-5.6-sol').get('[data-testid="select-model"]').find('svg').exists()).toBe(false)

    await wrapper.setProps({ modelValue: ['gpt-5.6-sol'] })
    expect(findModelRow(wrapper, 'gpt-5.6-sol').get('[data-testid="select-model"]').find('svg').exists()).toBe(true)
    await wrapper.setProps({ modelValue: [] })
    expect(findModelRow(wrapper, 'gpt-5.6-sol').get('[data-testid="select-model"]').find('svg').exists()).toBe(false)
    wrapper.unmount()
  })

  it('fills related models in platform order while preserving existing entries', async () => {
    const wrapper = mountSelector()
    const existing = ['custom', 'gpt-5.6-sol', 'custom']
    await wrapper.setProps({ modelValue: existing, platforms: ['openai', 'gemini'] })
    const expected = [...existing]
    for (const platform of ['openai', 'gemini']) {
      for (const model of getModelsByPlatform(platform)) {
        if (!expected.includes(model)) expected.push(model)
      }
    }
    await wrapper.findAll('button').find(button => button.text() === 'admin.accounts.fillRelatedModels')!.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[expected]])
    wrapper.unmount()
  })

  it('preserves duplicates while merging upstream models in source order', async () => {
    syncUpstreamModels.mockResolvedValue({ models: [' new-a ', 'existing', '', 'new-a', 'new-b'] })
    const wrapper = mountSelector()
    await wrapper.setProps({ accountId: 12, modelValue: ['existing', 'existing'] })
    await wrapper.findAll('button').find(button => button.text() === 'admin.accounts.syncUpstreamModels')!.trigger('click')
    await flushPromises()

    expect(syncUpstreamModels).toHaveBeenCalledWith(12)
    expect(wrapper.emitted('update:modelValue')).toEqual([[['existing', 'existing', 'new-a', 'new-b']]])
    expect(showSuccess).toHaveBeenCalledWith('admin.accounts.syncUpstreamModelsSuccess')
    wrapper.unmount()
  })

  it('copies a model ID without selecting the model', async () => {
    const wrapper = mountSelector()
    await wrapper.get('div.cursor-pointer').trigger('click')

    const row = findModelRow(wrapper, 'gpt-5.6-sol')

    const copyButton = row.get('[data-testid="copy-model-id"]')
    expect(copyButton.attributes('aria-label')).toBe('复制 gpt-5.6-sol')

    await copyButton.trigger('click')
    await flushPromises()

    expect(copyToClipboard).toHaveBeenCalledWith('gpt-5.6-sol')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('keeps the existing model selection behavior', async () => {
    const wrapper = mountSelector()
    await wrapper.get('div.cursor-pointer').trigger('click')

    const row = findModelRow(wrapper, 'gpt-5.6-sol')
    await row.get('[data-testid="select-model"]').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[['gpt-5.6-sol']]])
    expect(copyToClipboard).not.toHaveBeenCalled()
  })
})
