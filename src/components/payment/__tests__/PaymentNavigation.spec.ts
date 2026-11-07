import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import PaymentStatusPanel from '../PaymentStatusPanel.vue'
import PaymentQRDialog from '../PaymentQRDialog.vue'
import PaymentQRCodeView from '@/views/user/PaymentQRCodeView.vue'

const routeState = vi.hoisted(() => ({ query: {} as Record<string, string> }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({ useRoute: () => routeState, useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/stores/payment', () => ({ usePaymentStore: () => ({ pollOrderStatus: vi.fn() }) }))
vi.mock('@/stores', () => ({ useAppStore: () => ({ showError: vi.fn() }) }))
vi.mock('@/api/payment', () => ({ paymentAPI: { cancelOrder: vi.fn(), verifyOrder: vi.fn() } }))
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }))

const global = {
  stubs: {
    AppLayout: { template: '<div><slot /></div>' },
    BaseDialog: { template: '<div><slot /><slot name="footer" /></div>' },
    Icon: true,
  },
}
const props = { orderId: 42, qrCode: '', expiresAt: '2099-01-01T12:30:00Z', paymentType: 'alipay' }

describe('payment navigation rendering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    routeState.query = {}
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>'])(
    'renders no actionable link for unsafe payment URLs: %s', async (payUrl) => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      const status = mount(PaymentStatusPanel, { props: { ...props, payUrl }, global })
      const dialog = mount(PaymentQRDialog, { props: { ...props, show: true, payUrl }, global })
      routeState.query = { pay_url: payUrl, expires_at: props.expiresAt }
      const page = mount(PaymentQRCodeView, { global })
      await flushPromises()
      for (const wrapper of [status, dialog, page]) {
        expect(wrapper.text()).not.toContain('payment.qr.openPayWindow')
        expect(wrapper.find('a[href]').exists()).toBe(false)
        wrapper.unmount()
      }
      expect(open).not.toHaveBeenCalled()
    },
  )

  it('allows a valid hosted payment URL in all three surfaces', async () => {
    const payUrl = 'https://pay.example.com/order/42?signature=abc'
    const open = vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window)
    const status = mount(PaymentStatusPanel, { props: { ...props, payUrl }, global })
    const dialog = mount(PaymentQRDialog, { props: { ...props, show: true, payUrl }, global })
    routeState.query = { pay_url: payUrl, expires_at: props.expiresAt }
    const page = mount(PaymentQRCodeView, { global })
    await flushPromises()
    for (const wrapper of [status, dialog]) {
      const launch = wrapper.findAll('button').find(button => button.text() === 'payment.qr.openPayWindow')
      expect(launch).toBeDefined()
      await launch!.trigger('click')
      wrapper.unmount()
    }
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledWith(payUrl, 'paymentPopup', expect.any(String))
    expect(page.get('a').attributes('href')).toBe(payUrl)
    page.unmount()
  })
})
