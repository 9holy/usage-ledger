import './costDataI18n'
/**
 * planBadge 单测 — 套餐名 → 徽章 class 归一化
 *
 * 背景(QA 复核发现的真实缺陷):
 *   原实现是 `plan-${s.plan.toLowerCase()}`(渠道配额表 Plan 列,CostCenterView.vue:1042)。
 *   它有两个 bug:
 *     1) `API_KEY` → `plan-api_key`,而既有 CSS 规则是 `.plan-API_KEY`(大写)
 *        → 该规则永远命中不到,变成死规则;
 *     2) `Kiro Pro` / `Google AI Pro` 这类含空格的自由文本 → `plan-kiro pro`
 *        → 拼出两个垃圾类名,污染 DOM。
 *   同时账号列表的 plan 徽章(:754)用的是另一套写法,两处不一致。
 *
 * 本文件锁死修复后的契约:归一化只走显式白名单,未知一律 `plan-unknown`。
 */
import { describe, it, expect } from 'vitest'
import { planBadgeClass } from '../planBadge'

/**
 * CostCenterView.vue 里真实存在的徽章 class(见 .cost-badge.plan-* 规则)。
 * 任何返回值都必须落在这个白名单里,否则就是拼出了界面上不存在的类名。
 */
const EXISTING_BADGE_CLASSES = [
  'plan-plus',
  'plan-team',
  'plan-API_KEY',
  'plan-k12',
  'plan-unknown',
] as const

describe('planBadgeClass — 已知档位', () => {
  it('plus → plan-plus', () => {
    expect(planBadgeClass('plus')).toBe('plan-plus')
  })

  it('team → plan-team', () => {
    expect(planBadgeClass('team')).toBe('plan-team')
  })

  it('k12 / K12 → plan-k12(大小写不敏感)', () => {
    expect(planBadgeClass('k12')).toBe('plan-k12')
    expect(planBadgeClass('K12')).toBe('plan-k12')
  })

  it('⭐ API_KEY 必须命中既有的大写类名 plan-API_KEY(修复死规则)', () => {
    // 这是缺陷的核心:cockpit codex 实测 plan_type 值就是 `API_KEY`。
    expect(planBadgeClass('API_KEY')).toBe('plan-API_KEY')
  })
})

describe('planBadgeClass — 归一化(大小写 / 分隔符 / 空白)', () => {
  it('API_KEY 的常见变体全部归一到同一个类', () => {
    for (const variant of ['API_KEY', 'api_key', 'api-key', 'api key', 'Api Key', '  API_KEY  ']) {
      expect(planBadgeClass(variant), `变体 ${JSON.stringify(variant)} 未归一`).toBe('plan-API_KEY')
    }
  })

  it('大小写不敏感:PLUS / Plus / pLuS 都是 plan-plus', () => {
    for (const variant of ['PLUS', 'Plus', 'pLuS', '  plus  ']) {
      expect(planBadgeClass(variant)).toBe('plan-plus')
    }
  })

  it('连字符 / 下划线 / 空格不产生垃圾多 token 类名', () => {
    // 修复前 `Kiro Pro` → `plan-kiro pro`(两个类名)。现在必须是单一 token。
    expect(planBadgeClass('Kiro Pro')).not.toContain(' ')
    expect(planBadgeClass('Google AI Pro')).not.toContain(' ')
    expect(planBadgeClass('Kiro Pro')).toBe('plan-unknown')
  })
})

describe('planBadgeClass — 未知一律 plan-unknown(诚实性)', () => {
  it('null / undefined / 空串 → plan-unknown', () => {
    expect(planBadgeClass(null)).toBe('plan-unknown')
    expect(planBadgeClass(undefined)).toBe('plan-unknown')
    expect(planBadgeClass('')).toBe('plan-unknown')
    expect(planBadgeClass('   ')).toBe('plan-unknown')
  })

  it('未识别的自由文本 → plan-unknown', () => {
    expect(planBadgeClass('Gemini Code Assist in Google One AI Pro')).toBe('plan-unknown')
    expect(planBadgeClass('self_serve_business_prolite')).toBe('plan-unknown')
    expect(planBadgeClass('pro')).toBe('plan-unknown')
    expect(planBadgeClass('free')).toBe('plan-unknown')
    expect(planBadgeClass('随便一个没见过的套餐')).toBe('plan-unknown')
  })
})

describe('planBadgeClass — 红线:未知值绝不套正向强调色', () => {
  it('⭐ 任何未知值都不得返回 plan-plus / plan-k12', () => {
    // 未知套餐若误判成 plus/k12,就会在界面上冒充一个它并不拥有的档位。
    // 注意:`APIKEY` 不在此列——它归一化后是 `apikey`,是**合法命中** plan-API_KEY。
    const unknownValues = [
      null,
      undefined,
      '',
      '   ',
      'pro',
      'free',
      'Enterprise',
      'Kiro Pro',
      'Google AI Pro',
      'self_serve_business_prolite',
      '随便一个没见过的套餐',
    ]
    for (const value of unknownValues) {
      const cls = planBadgeClass(value as string | null | undefined)
      expect(cls, `${JSON.stringify(value)} 不应返回强调色类名`).not.toBe('plan-plus')
      expect(cls, `${JSON.stringify(value)} 不应返回强调色类名`).not.toBe('plan-k12')
    }
  })

  it('返回值永远落在界面真实存在的 class 白名单内', () => {
    const samples: Array<string | null | undefined> = [
      'plus', 'team', 'k12', 'K12', 'API_KEY', 'api-key',
      'pro', 'free', '', null, undefined, 'Kiro Pro', 'Google AI Pro',
    ]
    for (const sample of samples) {
      expect(
        EXISTING_BADGE_CLASSES as readonly string[],
        `${JSON.stringify(sample)} → ${planBadgeClass(sample)} 不在白名单`,
      ).toContain(planBadgeClass(sample))
    }
  })

  it('返回值永远不包含空白字符(不会拼出多个类名)', () => {
    const samples: Array<string | null | undefined> = [
      'plus', 'API_KEY', 'K12', 'Kiro Pro', 'Google AI Pro', 'self_serve_business_prolite', null, '',
    ]
    for (const sample of samples) {
      expect(planBadgeClass(sample)).not.toMatch(/\s/)
    }
  })
})
