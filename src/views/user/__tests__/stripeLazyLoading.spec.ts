import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const frontendRoot = resolve(__dirname, '../../../..')
const stripeConsumers = [
  'src/views/user/StripePaymentView.vue',
  'src/views/user/StripePopupView.vue',
  'src/components/payment/StripePaymentInline.vue',
]

function readFrontendFile(path: string): string {
  return readFileSync(resolve(frontendRoot, path), 'utf8')
}

describe('Stripe lazy-loading contract', () => {
  it.each(stripeConsumers)('%s uses the side-effect-free Stripe loader', (path) => {
    const source = readFrontendFile(path)

    expect(source).toContain("await import('@stripe/stripe-js/pure')")
    expect(source).not.toMatch(/await import\(['"]@stripe\/stripe-js['"]\)/)
  })

  it('keeps Stripe out of the shared vendor chunk', () => {
    const viteConfig = readFrontendFile('vite.config.ts')
    const stripeRule = viteConfig.indexOf("id.includes('/@stripe/stripe-js/')")
    const miscFallback = viteConfig.indexOf("return 'vendor-misc'")

    expect(stripeRule).toBeGreaterThan(-1)
    expect(viteConfig.slice(stripeRule, miscFallback)).toContain("return 'vendor-stripe'")
    expect(stripeRule).toBeLessThan(miscFallback)
  })

  it.each([
    ['xlsx', 'src/views/admin/UsageView.vue', 'vendor-export'],
    ['@airwallex/components-sdk', 'src/views/user/AirwallexPaymentView.vue', 'vendor-airwallex'],
  ])('keeps %s behind its existing on-demand import', (dependency, consumer, chunk) => {
    expect(readFrontendFile(consumer)).toContain(`await import('${dependency}')`)
    const viteConfig = readFrontendFile('vite.config.ts')
    const split = viteConfig.indexOf(`return '${chunk}'`)
    expect(split).toBeGreaterThan(-1)
    expect(split).toBeLessThan(viteConfig.indexOf("return 'vendor-ui'"))
    expect(split).toBeLessThan(viteConfig.indexOf("return 'vendor-misc'"))
  })
})
