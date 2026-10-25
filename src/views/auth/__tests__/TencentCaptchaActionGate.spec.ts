import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoginView from '@/views/auth/LoginView.vue'
import ConsoleAuthLayout from '@/views/auth/ConsoleAuthLayout.vue'
import i18n from '@/i18n'
import desktopEn from '@/i18n/locales/en/desktop'
import desktopZh from '@/i18n/locales/zh/desktop'
import commonEn from '@/i18n/locales/en/common'
import commonZh from '@/i18n/locales/zh/common'

const loginMock = vi.fn()
const loginWithPasskeyMock = vi.fn()
const getPublicSettingsMock = vi.fn()
const startOAuthLoginMock = vi.fn()
const verifyActionMock = vi.fn()
const captchaResetMock = vi.fn()
const fetchPublicSettingsMock = vi.fn()
const publicSettingsCache = { loaded: false, value: null as Record<string, unknown> | null }
const locationState = { href: 'http://localhost/login' }

vi.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: { value: { query: {} } },
    push: vi.fn()
  })
}))

vi.mock('@/stores', () => ({
  useAuthStore: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    loginWithPasskey: (...args: unknown[]) => loginWithPasskeyMock(...args)
  }),
  useAppStore: () => ({
    siteName: 'Team Console',
    siteLogo: '/logo.svg',
    get publicSettingsLoaded() { return publicSettingsCache.loaded },
    get cachedPublicSettings() { return publicSettingsCache.value ?? { site_subtitle: 'Operations' } },
    fetchPublicSettings: fetchPublicSettingsMock,
    showError: vi.fn(),
    showSuccess: vi.fn(),
    showWarning: vi.fn()
  })
}))

vi.mock('@/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@/api/auth')>('@/api/auth')
  return {
    ...actual,
    getPublicSettings: (...args: unknown[]) => getPublicSettingsMock(...args),
    startOAuthLogin: (...args: unknown[]) => startOAuthLoginMock(...args),
    isTotp2FARequired: () => false,
    isWeChatWebOAuthEnabled: () => false
  }
})

const CaptchaChallengeStub = defineComponent({
  setup(_, { expose }) {
    expose({
      verifyAction: verifyActionMock,
      reset: captchaResetMock
    })
    return () => h('div')
  }
})

const OAuthButtonStub = defineComponent({
  emits: ['start'],
  setup(_, { emit }) {
    return () => h('button', {
      type: 'button',
      'data-testid': 'oauth-start',
      onClick: () => emit('start', {
        provider: 'github',
        params: { redirect: '/dashboard' }
      })
    })
  }
})

function mountLogin() {
  return mount(LoginView, {
    global: {
      plugins: [i18n],
      stubs: {
        ConsoleAuthLayout: { template: '<div><slot /><slot name="footer" /></div>' },
        RouterLink: true,
        TurnstileWidget: CaptchaChallengeStub,
        Icon: true,
        LoginAgreementPrompt: true,
        TotpLoginModal: true,
        EmailOAuthButtons: OAuthButtonStub,
        LinuxDoOAuthSection: true,
        DingTalkOAuthSection: true,
        OidcOAuthSection: true,
        WechatOAuthSection: true
      }
    }
  })
}

describe('Tencent captcha action gate', () => {
  beforeEach(() => {
    i18n.global.setLocaleMessage('en', { desktop: desktopEn, ...commonEn })
    i18n.global.setLocaleMessage('zh', { desktop: desktopZh, ...commonZh })
    i18n.global.locale.value = 'zh'
    loginMock.mockReset()
    loginWithPasskeyMock.mockReset()
    getPublicSettingsMock.mockReset()
    startOAuthLoginMock.mockReset()
    verifyActionMock.mockReset()
    captchaResetMock.mockReset()
    fetchPublicSettingsMock.mockReset()
    publicSettingsCache.loaded = false
    publicSettingsCache.value = null
    getPublicSettingsMock.mockResolvedValue({
      turnstile_enabled: false,
      turnstile_site_key: '',
      tencent_captcha_enabled: true,
      tencent_captcha_app_id: 'tencent-app-id',
      backend_mode_enabled: false,
      password_reset_enabled: false,
      passkey_enabled: true,
      github_oauth_enabled: true,
      google_oauth_enabled: false
    })
    loginMock.mockResolvedValue({})
    loginWithPasskeyMock.mockResolvedValue({})
    startOAuthLoginMock.mockResolvedValue({ authorize_url: 'https://github.example/authorize' })
    verifyActionMock.mockResolvedValue({ token: 'ticket-1', randstr: '@rand-1' })
    Object.defineProperty(window, 'PublicKeyCredential', {
      configurable: true,
      value: class PublicKeyCredential {}
    })
    locationState.href = 'http://localhost/login'
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: locationState
    })
  })

  it('keeps the local login shell branding, settings load and footer slots', async () => {
    const wrapper = mount(ConsoleAuthLayout, {
      slots: { default: '<form aria-label="login form"></form>', footer: '<a href="/register">Register</a>' },
      global: { plugins: [i18n], stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()
    expect(wrapper.classes()).toContain('console-surface')
    expect(wrapper.get('h1').text()).toBe('Team Console')
    expect(wrapper.get('img').attributes('src')).toBe('/logo.svg')
    expect(wrapper.get('footer').text()).toContain('Register')
    expect(fetchPublicSettingsMock).toHaveBeenCalledOnce()
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(wrapper.get('[aria-label="Back to connections"]').attributes('title')).toBe('Back to connections')
    expect(wrapper.get('h1').text()).toBe('Team Console')
    expect(fetchPublicSettingsMock).toHaveBeenCalledOnce()
    i18n.global.locale.value = 'zh'; await flushPromises()
    expect(wrapper.get('[aria-label="返回连接页"]').attributes('title')).toBe('返回连接页')
    wrapper.unmount()
  })

  it('switches login warnings and password controls without changing credentials or starting authentication', async () => {
    getPublicSettingsMock.mockRejectedValueOnce(new Error('来源诊断原文'))
    const wrapper = mountLogin(); await flushPromises()
    await wrapper.get('#email').setValue('user@example.test')
    await wrapper.get('#password').setValue('fixture-password')
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(wrapper.get('.login-settings-error').text()).toContain('you can still try account sign-in')
    expect(wrapper.get('.login-settings-error').text()).toContain('来源诊断原文')
    expect(wrapper.get('[aria-label="Retry loading login settings"]').attributes('title')).toBe('Retry loading login settings')
    await wrapper.get('[aria-label="Show password"]').trigger('click')
    expect(wrapper.get('#password').attributes('type')).toBe('text')
    expect(wrapper.get('[aria-label="Hide password"]').attributes('title')).toBe('Hide password')
    i18n.global.locale.value = 'zh'; await flushPromises()
    expect(wrapper.get('[aria-label="隐藏密码"]').attributes('title')).toBe('隐藏密码')
    expect(wrapper.get<HTMLInputElement>('#email').element.value).toBe('user@example.test')
    expect(wrapper.get<HTMLInputElement>('#password').element.value).toBe('fixture-password')
    expect(getPublicSettingsMock).toHaveBeenCalledOnce()
    expect(loginMock).not.toHaveBeenCalled()
    expect(verifyActionMock).not.toHaveBeenCalled()
    expect(startOAuthLoginMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('recovers failed settings without discarding credentials or blocking ordinary login', async () => {
    getPublicSettingsMock.mockRejectedValueOnce(new Error('settings unavailable'))
    const wrapper = mountLogin()
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('settings unavailable')
    await wrapper.get('#email').setValue('user@example.com')
    await wrapper.get('#password').setValue('secret-123')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(loginMock).toHaveBeenCalledOnce()
    expect(verifyActionMock).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="重试读取登录设置"]').trigger('click')
    await flushPromises()
    expect(getPublicSettingsMock).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.get<HTMLInputElement>('#email').element.value).toBe('user@example.com')
    expect(wrapper.get<HTMLInputElement>('#password').element.value).toBe('secret-123')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(verifyActionMock).toHaveBeenCalledOnce()
  })

  it('uses successfully loaded public settings cache for available login methods', async () => {
    publicSettingsCache.loaded = true
    publicSettingsCache.value = { passkey_enabled: true }
    const wrapper = mountLogin()
    await flushPromises()
    expect(getPublicSettingsMock).not.toHaveBeenCalled()
    expect(wrapper.find('button.btn-secondary').exists()).toBe(true)
  })

  it('clicking login opens Tencent captcha before calling login', async () => {
    const wrapper = mountLogin()
    await flushPromises()
    await wrapper.get('#email').setValue('user@example.com')
    await wrapper.get('#password').setValue('secret-123')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(verifyActionMock).toHaveBeenCalledOnce()
    expect(loginMock).toHaveBeenCalledWith(expect.objectContaining({
      tencent_captcha_ticket: 'ticket-1',
      tencent_captcha_randstr: '@rand-1'
    }))
  })

  it('does not call login when Tencent captcha is closed', async () => {
    verifyActionMock.mockResolvedValue(null)
    const wrapper = mountLogin()
    await flushPromises()
    await wrapper.get('#email').setValue('user@example.com')
    await wrapper.get('#password').setValue('secret-123')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(verifyActionMock).toHaveBeenCalledOnce()
    expect(loginMock).not.toHaveBeenCalled()
  })

  it('does not open Tencent captcha when login form validation fails', async () => {
    const wrapper = mountLogin()
    await flushPromises()

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(verifyActionMock).not.toHaveBeenCalled()
    expect(loginMock).not.toHaveBeenCalled()
  })

  it('starts OAuth through the Tencent gate before navigating', async () => {
    const wrapper = mountLogin()
    await flushPromises()

    await wrapper.get('[data-testid="oauth-start"]').trigger('click')
    await flushPromises()

    expect(verifyActionMock).toHaveBeenCalledOnce()
    expect(startOAuthLoginMock).toHaveBeenCalledWith(
      { provider: 'github', params: { redirect: '/dashboard' } },
      {
        tencent_captcha_ticket: 'ticket-1',
        tencent_captcha_randstr: '@rand-1'
      }
    )
    expect(locationState.href).toBe('https://github.example/authorize')
    expect(captchaResetMock).toHaveBeenCalledOnce()
  })

  it('does not start OAuth when Tencent captcha is closed', async () => {
    verifyActionMock.mockResolvedValue(null)
    const wrapper = mountLogin()
    await flushPromises()

    await wrapper.get('[data-testid="oauth-start"]').trigger('click')
    await flushPromises()

    expect(startOAuthLoginMock).not.toHaveBeenCalled()
    expect(locationState.href).toBe('http://localhost/login')
  })

  it('passes a fresh Tencent proof to Passkey login', async () => {
    const wrapper = mountLogin()
    await flushPromises()

    await wrapper.get('button.btn-secondary.w-full').trigger('click')
    await flushPromises()

    expect(verifyActionMock).toHaveBeenCalledOnce()
    expect(loginWithPasskeyMock).toHaveBeenCalledWith({
      tencent_captcha_ticket: 'ticket-1',
      tencent_captcha_randstr: '@rand-1'
    })
    expect(captchaResetMock).toHaveBeenCalledOnce()
  })

  it('does not invoke Passkey when Tencent captcha is closed', async () => {
    verifyActionMock.mockResolvedValue(null)
    const wrapper = mountLogin()
    await flushPromises()

    await wrapper.get('button.btn-secondary.w-full').trigger('click')
    await flushPromises()

    expect(loginWithPasskeyMock).not.toHaveBeenCalled()
  })
})
