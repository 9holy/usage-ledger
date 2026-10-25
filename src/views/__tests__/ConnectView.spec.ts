import { describe, expect, it, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'
import desktopZh from '@/i18n/locales/zh/desktop'
import desktopEn from '@/i18n/locales/en/desktop'

// Local availability alone controls the positive status accent, never absence or pending detection.

const cockpitStateResult = vi.hoisted(() => ({ value: null as unknown }))
const push = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())

vi.mock('@/api/cockpit', () => ({
  getCockpitConnectionState: vi.fn(async () => cockpitStateResult.value),
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/connect' }), useRouter: () => ({ push, replace }) }))

import ConnectView from '../ConnectView.vue'
import { useConnectionStore } from '@/stores/connection'
import { useAppStore } from '@/stores/app'

function mountView() {
  const pinia = createPinia()
  vi.spyOn(useAppStore(pinia), 'fetchPublicSettings').mockResolvedValue(null)
  return mount(ConnectView, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        Icon: { template: '<i />' },
      },
    },
  })
}

/** Status is semantic: only confirmed local data receives the available accent. */
function cockpitBadge(wrapper: ReturnType<typeof mountView>) {
  return wrapper
    .findAll('span')
    .find((s) => s.classes().includes('cockpit-status'))
}

describe('ConnectView · cockpit 状态徽章不谎报健康', () => {
  beforeEach(() => {
    cockpitStateResult.value = null
    push.mockClear()
    replace.mockClear()
    localStorage.clear()
    i18n.global.setLocaleMessage('zh', { desktop: desktopZh })
    i18n.global.locale.value = 'zh'
  })

  it('未安装（available=false）：文案「未安装」，且使用告警状态', async () => {
    cockpitStateResult.value = { available: false, reason: '未找到 cockpit 数据目录' }
    const wrapper = mountView()
    await flushPromises()

    const badge = cockpitBadge(wrapper)
    expect(badge, '应能定位到 cockpit 状态徽章').toBeTruthy()
    expect(badge!.text()).toContain('未安装')

    const classes = badge!.classes()
    expect(classes).not.toContain('status-available')
    expect(classes).toContain('status-warning')
  })

  it('数据可用（available=true）：使用可用状态', async () => {
    cockpitStateResult.value = { available: true }
    const wrapper = mountView()
    await flushPromises()

    const badge = cockpitBadge(wrapper)
    expect(badge, '应能定位到 cockpit 状态徽章').toBeTruthy()
    expect(badge!.text()).toContain('数据可用')
    expect(badge!.classes()).toContain('status-available')
  })

  it('探测中（null）：保持中性状态', async () => {
    cockpitStateResult.value = null
    const wrapper = mountView()
    // 刻意不 flushPromises：停在"探测中"这一帧
    const badge = cockpitBadge(wrapper)
    expect(badge, '应能定位到 cockpit 状态徽章').toBeTruthy()
    expect(badge!.text()).toContain('探测中')
    expect(badge!.classes()).toContain('status-neutral')
  })

  it('keeps removal separate from connect and requires confirmation', async () => {
    const wrapper = mountView()
    const store = useConnectionStore()
    const id = store.addConnection({ name: 'Saved server', type: 'sub2api', baseUrl: 'https://example.test', apiKey: 'admin-key' })
    await flushPromises()
    expect(wrapper.find('button button').exists()).toBe(false)
    await wrapper.get('[aria-label="删除连接 Saved server"]').trigger('click')
    expect(store.connections.some(connection => connection.id === id)).toBe(true)
    const confirm = wrapper.get('[aria-label="确认删除连接 Saved server"]')
    await confirm.findAll('button')[1].trigger('click')
    expect(store.connections.some(connection => connection.id === id)).toBe(true)
    await wrapper.get('[aria-label="删除连接 Saved server"]').trigger('click')
    await wrapper.get('[aria-label="确认删除连接 Saved server"]').findAll('button')[0].trigger('click')
    expect(store.connections.some(connection => connection.id === id)).toBe(false)
  })

  it('prioritizes saved sources and expands the form without changing saved credentials', async () => {
    localStorage.setItem('2api-console.connections', JSON.stringify([{ id: 'saved', name: 'Saved server', type: 'sub2api', baseUrl: 'https://example.test', apiKey: 'key', lastUsed: 1 }]))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('.connection-form-pane').attributes('style')).toContain('display: none')
    expect(wrapper.findAll('.saved-connection')).toHaveLength(1)
    await wrapper.get('.new-connection').trigger('click')
    expect(wrapper.get('.connection-form-pane').attributes('style')).not.toContain('display: none')
    await wrapper.get('#conn-name').setValue('Draft')
    await wrapper.get('[aria-label="收起连接表单"]').trigger('click')
    expect(useConnectionStore().connections[0].name).toBe('Saved server')
    await wrapper.get('.new-connection').trigger('click')
    expect(wrapper.get<HTMLInputElement>('#conn-name').element.value).toBe('Draft')
  })

  it('updates connection labels, placeholders and accessible controls in English without translating saved names', async () => {
    const wrapper = mountView()
    const store = useConnectionStore()
    store.addConnection({ name: '用户服务器', type: 'sub2api', baseUrl: 'https://example.test', apiKey: 'fixture-key' })
    i18n.global.setLocaleMessage('en', { desktop: desktopEn })
    i18n.global.locale.value = 'en'
    await flushPromises()
    expect(wrapper.get('.connect-intro h1').text()).toBe('Connect Your Usage Data')
    expect(wrapper.get('.connection-form-pane').attributes('aria-label')).toBe('New connection or reconnect')
    expect(wrapper.get('#conn-name').attributes('placeholder')).toBe('My Sub2API')
    expect(wrapper.get('[aria-label="Delete connection 用户服务器"]').attributes('title')).toBe('Delete connection 用户服务器')
    expect(wrapper.get('.saved-connection').text()).toContain('用户服务器')
    await wrapper.get('[aria-label="Authentication"]').findAll('button')[1].trigger('click')
    expect(wrapper.get('#conn-password').attributes('placeholder')).toBe('Password')
    expect(wrapper.get('[aria-label="Show password"]').exists()).toBe(true)
    expect(store.connections[0].name).toBe('用户服务器')
    i18n.global.locale.value = 'zh'
    await flushPromises()
    expect(wrapper.get('.connect-intro h1').text()).toBe('连接你的用量数据')
    expect(wrapper.get('[aria-label="显示密码"]').exists()).toBe(true)
  })

  it('preserves credential modes and remembered-password control', async () => {
    const wrapper = mountView()
    expect(wrapper.find('#conn-key').exists()).toBe(true)
    const modes = wrapper.get('[aria-label="认证方式"]').findAll('button')
    await modes[1].trigger('click')
    expect(wrapper.find('#conn-key').exists()).toBe(false)
    expect(wrapper.find('#conn-email').exists()).toBe(true)
    expect(wrapper.get<HTMLInputElement>('#conn-password').element.type).toBe('password')
    expect(wrapper.get<HTMLInputElement>('.remember-password input').element.checked).toBe(true)
    await wrapper.get('[aria-label="显示密码"]').trigger('click')
    expect(wrapper.get<HTMLInputElement>('#conn-password').element.type).toBe('text')
  })

  it('keeps the same saved connection after a failed retry and through 2FA completion', async () => {
    const wrapper = mountView()
    const store = useConnectionStore()
    const id = store.addConnection({ name: 'Account server', type: 'sub2api', baseUrl: 'https://account.test', apiKey: '', authMode: 'login', email: 'admin@example.com' })
    vi.spyOn(store, 'connectWithStoredJwt').mockResolvedValue(false)
    const add = vi.spyOn(store, 'addConnection')
    const login = vi.spyOn(store, 'connectWithLogin').mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false, requires2fa: true })
    const complete = vi.spyOn(store, 'complete2FA').mockResolvedValue({ ok: true })
    await flushPromises()
    await wrapper.get('.connection-main').trigger('click')
    await flushPromises()
    expect(wrapper.get('.form-heading h2').text()).toBe('重新连接')
    await wrapper.get('#conn-password').setValue('wrong-password')
    await wrapper.get('.remember-password input').setValue(true)
    await wrapper.get('.connection-form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('.form-heading h2').text()).toBe('重新连接')
    await wrapper.get('#conn-password').setValue('correct-password')
    await wrapper.get('.connection-form').trigger('submit')
    await flushPromises()
    expect(login).toHaveBeenNthCalledWith(1, id, 'admin@example.com', 'wrong-password', true)
    expect(login).toHaveBeenNthCalledWith(2, id, 'admin@example.com', 'correct-password', true)
    expect(add).not.toHaveBeenCalled()
    expect(store.connections).toHaveLength(1)
    expect(wrapper.find('#conn-totp').exists()).toBe(true)
    await wrapper.get('#conn-totp').setValue('123456')
    await wrapper.get('.two-factor-form').trigger('submit')
    await flushPromises()
    expect(complete).toHaveBeenCalledWith('123456')
    expect(wrapper.get('.form-heading h2').text()).toBe('新建连接')
    expect(replace).toHaveBeenCalledOnce()
  })

  it.each([{ error: '验证码错误', requiresLogin: false }, { error: '验证上下文失效', requiresLogin: true }])('shows $error and only exits 2FA when login is required', async ({ error, requiresLogin }) => {
    const wrapper = mountView()
    const store = useConnectionStore()
    vi.spyOn(store, 'connectWithLogin').mockResolvedValue({ ok: false, requires2fa: true })
    vi.spyOn(store, 'complete2FA').mockResolvedValue({ ok: false, error, requiresLogin })
    await wrapper.get('[aria-label="认证方式"]').findAll('button')[1].trigger('click')
    await wrapper.get('#conn-name').setValue('Account')
    await wrapper.get('#conn-url').setValue('https://account.test')
    await wrapper.get('#conn-email').setValue('admin@example.com')
    await wrapper.get('#conn-password').setValue('password')
    await wrapper.get('.connection-form').trigger('submit')
    await flushPromises()
    await wrapper.get('#conn-totp').setValue('123456')
    await wrapper.get('.two-factor-form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain(error)
    expect(wrapper.find('.two-factor-form').exists()).toBe(!requiresLogin)
    if (!requiresLogin) expect(wrapper.get<HTMLInputElement>('#conn-totp').element.value).toBe('123456')
  })

  it('reuses a newly saved account connection when the first login fails', async () => {
    const wrapper = mountView()
    const store = useConnectionStore()
    const login = vi.spyOn(store, 'connectWithLogin').mockResolvedValue({ ok: false })
    await wrapper.get('[aria-label="认证方式"]').findAll('button')[1].trigger('click')
    await wrapper.get('#conn-name').setValue('New account')
    await wrapper.get('#conn-url').setValue('https://account.test')
    await wrapper.get('#conn-email').setValue('admin@example.com')
    await wrapper.get('#conn-password').setValue('password')
    await wrapper.get('.connection-form').trigger('submit')
    await flushPromises()
    const id = store.connections[0].id
    await wrapper.get('.connection-form').trigger('submit')
    await flushPromises()
    expect(store.connections).toHaveLength(1)
    expect(login).toHaveBeenNthCalledWith(2, id, 'admin@example.com', 'password', true)
  })

  it('does not overwrite a saved login when closing reauthentication and choosing a new connection', async () => {
    const wrapper = mountView()
    const store = useConnectionStore()
    const id = store.addConnection({ name: 'Original', type: 'sub2api', baseUrl: 'https://original.test', apiKey: 'old-token', authMode: 'login', email: 'original@example.test' })
    const original = { ...store.connections[0] }
    vi.spyOn(store, 'connectWithStoredJwt').mockResolvedValue(false)
    vi.spyOn(store, 'connectWithLogin').mockResolvedValue({ ok: false })
    await flushPromises()
    await wrapper.get('.connection-main').trigger('click'); await flushPromises()
    await wrapper.get('[aria-label="收起连接表单"]').trigger('click')
    await wrapper.get('.new-connection').trigger('click')
    expect(wrapper.get<HTMLInputElement>('#conn-password').element.value).toBe('')
    await wrapper.get('#conn-name').setValue('New server')
    await wrapper.get('#conn-url').setValue('https://new.test')
    await wrapper.get('#conn-email').setValue('new@example.test')
    await wrapper.get('#conn-password').setValue('new-password')
    await wrapper.get('.connection-form').trigger('submit'); await flushPromises()
    expect(store.connections).toHaveLength(2)
    expect(store.connections.find(connection => connection.id === id)).toEqual(original)
  })

  it.each(['type', 'authMode'])('starts a new connection when changing %s instead of overwriting the recovery target', async (change) => {
    const wrapper = mountView()
    const store = useConnectionStore()
    const id = store.addConnection({ name: 'Account server', type: 'sub2api', baseUrl: 'https://account.test', apiKey: 'old-token', authMode: 'login', email: 'admin@example.com' })
    const original = { ...store.connections[0] }
    vi.spyOn(store, 'connectWithStoredJwt').mockResolvedValue(false)
    vi.spyOn(store, 'connect').mockResolvedValue(false)
    const update = vi.spyOn(store, 'updateConnection')
    await flushPromises()
    await wrapper.get('.connection-main').trigger('click')
    await flushPromises()
    await wrapper.get(`[aria-label="${change === 'type' ? '连接类型' : '认证方式'}"]`).findAll('button')[change === 'type' ? 1 : 0].trigger('click')
    expect(wrapper.get('.form-heading h2').text()).toBe('新建连接')
    await wrapper.get('#conn-name').setValue('New server')
    await wrapper.get('#conn-url').setValue('https://new.test')
    await wrapper.get(change === 'type' ? '#conn-secret' : '#conn-key').setValue('new-key')
    await wrapper.get('.connection-form').trigger('submit')
    await flushPromises()
    expect(update).not.toHaveBeenCalled()
    expect(store.connections.find(connection => connection.id === id)).toEqual(original)
    expect(store.connections).toHaveLength(2)
    expect(store.connections.find(connection => connection.id !== id)).toMatchObject({ name: 'New server', baseUrl: 'https://new.test', type: change === 'type' ? 'cliproxy' : 'sub2api', authMode: change === 'type' ? undefined : 'apikey' })
  })

})
