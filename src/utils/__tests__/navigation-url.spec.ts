import { describe, expect, it } from 'vitest'
import { sanitizeNavigationUrl } from '../url'

describe('sanitizeNavigationUrl', () => {
  it.each([
    'javascript:alert(document.domain)',
    '  JaVaScRiPt:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://app.example.com/payload',
    'file:///etc/passwd',
    'alipays://platformapi/startapp',
    'weixin://wxpay/bizpayurl',
    '//evil.example/path',
    '/\\evil.example/path',
    '/\n/evil.example/path',
    'https://user:password@example.com/pay',
    'https://',
    undefined,
    null,
    123,
    ['https://pay.example.com/'],
  ])('rejects unsafe or malformed navigation %s', (value) => {
    expect(sanitizeNavigationUrl(value, { allowRelative: true })).toBe('')
  })

  it('preserves HTTP(S) payment and OAuth URLs and their signed parameters', () => {
    const url = 'https://pay.example.com/checkout?state=a%2Fb&signature=c%2Bd#resume'
    expect(sanitizeNavigationUrl(url)).toBe(url)
    expect(sanitizeNavigationUrl('http://localhost:8080/oauth/start')).toBe('http://localhost:8080/oauth/start')
  })

  it('only accepts site-root paths when the caller explicitly allows them', () => {
    expect(sanitizeNavigationUrl('/payment/stripe?order_id=1')).toBe('')
    expect(sanitizeNavigationUrl('/payment/stripe?order_id=1', { allowRelative: true }))
      .toBe('/payment/stripe?order_id=1')
    expect(sanitizeNavigationUrl('payment/stripe', { allowRelative: true })).toBe('')
    expect(sanitizeNavigationUrl('#/payment/stripe?order_id=1', { allowRelative: true }))
      .toBe('#/payment/stripe?order_id=1')
    expect(sanitizeNavigationUrl('#/payment/stripe?order_id=1')).toBe('')
  })
})
