import './costDataI18n'
/**
 * planInfer 单测 — plan_name 原文 → 官方订阅月费(架构设计 【F】7.3 / PRD P0-18)
 *
 * 核心验收:
 *  - "Gemini Code Assist in Google One AI Pro" → $19.99(不是 ChatGPT Plus 的 $20,更不是 $100)
 *  - 未命中 → null(**绝不编造价格**)
 */
import { describe, it, expect } from 'vitest'
import {
  PLAN_PRICE_BOOK,
  describePlanLabel,
  normalizePlanLabel,
  planLabelOf,
  planOfLabel,
  subscriptionPriceUsdOf,
} from '../planInfer'

describe('normalizePlanLabel', () => {
  it('把实测 gemini 字符串归一化成可匹配 token', () => {
    expect(normalizePlanLabel('Gemini Code Assist in Google One AI Pro'))
      .toBe('geminicodeassist in googleone ai pro')
  })

  it('Pro+ / PRO_PLUS 归一成同一个 token', () => {
    expect(normalizePlanLabel('Pro+')).toBe('proplus')
    expect(normalizePlanLabel('PRO_PLUS')).toBe('proplus')
  })

  it('x 倍率后缀与词干分开', () => {
    expect(normalizePlanLabel('Ultra (20x)')).toBe('ultra20x')
    expect(normalizePlanLabel('Max 5x')).toBe('max5x')
  })
})

describe('subscriptionPriceUsdOf', () => {
  it('⭐ 本机 gemini 账号 plan_name → Google AI Pro $19.99', () => {
    // 这是 PRD §4.2.2 的第一个验收用例。此前落 unknown → ChatGPT Plus $20 × 0.7 = $14(编造)。
    expect(subscriptionPriceUsdOf('Gemini Code Assist in Google One AI Pro')).toBe(19.99)
    expect(planOfLabel('Gemini Code Assist in Google One AI Pro')).toBe('pro')
  })

  it('Google AI 各档位', () => {
    expect(subscriptionPriceUsdOf('Google AI Pro')).toBe(19.99)
    expect(subscriptionPriceUsdOf('Google AI Plus')).toBe(4.99)
    expect(subscriptionPriceUsdOf('Google AI Ultra')).toBe(99.99)
    expect(subscriptionPriceUsdOf('Google AI Ultra 20x')).toBe(199.99)
    expect(subscriptionPriceUsdOf('Google AI Free')).toBe(0)
    expect(subscriptionPriceUsdOf('Gemini Advanced')).toBe(19.99)
  })

  it('Gemini Code Assist 三档', () => {
    expect(subscriptionPriceUsdOf('Gemini Code Assist Standard')).toBe(19)
    expect(subscriptionPriceUsdOf('Gemini Code Assist Enterprise')).toBe(45)
  })

  it('ChatGPT / Codex', () => {
    expect(subscriptionPriceUsdOf('ChatGPT Plus')).toBe(20)
    expect(subscriptionPriceUsdOf('ChatGPT Pro')).toBe(100)
    expect(subscriptionPriceUsdOf('ChatGPT Pro 20x')).toBe(200)
    expect(subscriptionPriceUsdOf('ChatGPT Free')).toBe(0)
    expect(subscriptionPriceUsdOf('ChatGPT Business')).toBe(25)
  })

  it('Claude', () => {
    expect(subscriptionPriceUsdOf('Claude Pro')).toBe(20)
    expect(subscriptionPriceUsdOf('Claude Max 5x')).toBe(100)
    expect(subscriptionPriceUsdOf('Claude Max 20x')).toBe(200)
    expect(subscriptionPriceUsdOf('Claude Team')).toBe(25)
  })

  it('Cursor / Copilot / Kiro / Trae / Qoder / Zed / Grok', () => {
    expect(subscriptionPriceUsdOf('Cursor Pro')).toBe(20)
    expect(subscriptionPriceUsdOf('Cursor Pro+')).toBe(60)
    expect(subscriptionPriceUsdOf('Cursor Ultra')).toBe(200)
    expect(subscriptionPriceUsdOf('GitHub Copilot Pro')).toBe(10)
    expect(subscriptionPriceUsdOf('GitHub Copilot Pro+')).toBe(39)
    expect(subscriptionPriceUsdOf('Kiro Pro Max')).toBe(100)
    expect(subscriptionPriceUsdOf('Kiro Power')).toBe(200)
    expect(subscriptionPriceUsdOf('Trae Pro')).toBe(10)
    expect(subscriptionPriceUsdOf('Qoder Pro')).toBe(20)
    expect(subscriptionPriceUsdOf('Zed Pro')).toBe(10)
    expect(subscriptionPriceUsdOf('SuperGrok Heavy')).toBe(300)
    expect(subscriptionPriceUsdOf('X Premium+')).toBe(40)
  })

  it('未命中 → null(绝不编造价格)', () => {
    expect(subscriptionPriceUsdOf('随便一个没见过的套餐')).toBeNull()
    expect(subscriptionPriceUsdOf('')).toBeNull()
    expect(subscriptionPriceUsdOf(null)).toBeNull()
    expect(subscriptionPriceUsdOf(undefined)).toBeNull()
  })

  it('官方未公开价 / 定制报价 → null(不是 0)', () => {
    expect(subscriptionPriceUsdOf('ChatGPT Enterprise')).toBeNull()
    expect(subscriptionPriceUsdOf('Cursor Enterprise')).toBeNull()
    expect(subscriptionPriceUsdOf('Claude Enterprise')).toBeNull()
  })

  it('跨族价格不一致的档位不猜(Ultra / Max / Pro+ 裸字符串)', () => {
    expect(subscriptionPriceUsdOf('Ultra')).toBeNull()
    expect(subscriptionPriceUsdOf('Max')).toBeNull()
    expect(subscriptionPriceUsdOf('Pro+')).toBeNull()
  })

  it('CNY 档位:给了汇率才折算,不给就 null', () => {
    expect(subscriptionPriceUsdOf('CodeBuddy CN 标准版')).toBeNull()
    expect(subscriptionPriceUsdOf('CodeBuddy CN 标准版', 6.8)).toBeCloseTo(99 / 6.8, 10)
    expect(subscriptionPriceUsdOf('Qoder CN 个人专业版 Pro', 6.8)).toBeCloseTo(59 / 6.8, 10)
  })

  it('"Personal" 是 Claude 的非档位文案,落 unknown 不查表', () => {
    expect(subscriptionPriceUsdOf('Personal')).toBeNull()
    expect(planOfLabel('Personal')).toBe('unknown')
  })

  it('API Key 账号按量无月费 → null', () => {
    expect(subscriptionPriceUsdOf('API_KEY')).toBeNull()
    expect(subscriptionPriceUsdOf('api_key')).toBeNull()
  })
})

describe('价目表自证性', () => {
  it('每条规则都带来源 URL 与档位名', () => {
    for (const rule of PLAN_PRICE_BOOK) {
      expect(rule.source, `${rule.tier} 缺 source`).toBeTruthy()
      expect(rule.tier, '档位名不能为空').toBeTruthy()
      expect(rule.keys.length, `${rule.tier} 缺匹配键`).toBeGreaterThan(0)
    }
  })

  it('13 个价目族全部覆盖到', () => {
    const families = new Set<string>(PLAN_PRICE_BOOK.map(r => r.family))
    const expected = ['codex', 'gemini', 'antigravity', 'claude', 'cursor', 'github-copilot', 'kiro', 'trae', 'windsurf', 'codebuddy', 'qoder', 'zed', 'grok']
    for (const family of expected) {
      expect(families.has(family), `缺价目族 ${family}`).toBe(true)
    }
  })

  it('ZCode 来源分歧大,**不写入**价目表(PRD §4.2.13 明确排除)', () => {
    const hit = PLAN_PRICE_BOOK.some(r => r.tier.toLowerCase().includes('zcode'))
    expect(hit).toBe(false)
  })
})

describe('planLabelOf (从账号取 plan 原文)', () => {
  it('读 extra.cockpit_plan_label(cockpit 平台账号)', () => {
    expect(planLabelOf({ extra: { cockpit_plan_label: 'Gemini Code Assist in Google One AI Pro' } }))
      .toBe('Gemini Code Assist in Google One AI Pro')
  })

  it('读 extra.plan_name', () => {
    expect(planLabelOf({ extra: { plan_name: 'Kiro Pro+' } })).toBe('Kiro Pro+')
  })

  it('什么都没有 → null(调用方回退既有 inferPlan,行为不变)', () => {
    expect(planLabelOf(null)).toBeNull()
    expect(planLabelOf({})).toBeNull()
    expect(planLabelOf({ extra: undefined, credentials: undefined })).toBeNull()
  })
})

describe('describePlanLabel', () => {
  it('返回归一化文本与命中 token(便于排查)', () => {
    const matched = describePlanLabel('Gemini Code Assist in Google One AI Pro')
    expect(matched).not.toBeNull()
    expect(matched!.normalized).toBe('geminicodeassist in googleone ai pro')
    expect(matched!.tokens).toEqual(expect.arrayContaining(['googleone', 'ai', 'pro']))
    expect(matched!.rule.usd).toBe(19.99)
    expect(matched!.rule.source).toContain('perspectiveai.xyz')
  })
})
