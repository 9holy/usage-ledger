import { costDataText } from './costDataText'
/**
 * plan_name 原文 → 官方订阅月费(架构设计 【F】7.3 / PRD P0-18 + §4.2)。
 *
 * 现状问题:非 codex 渠道**一律** fallback 到 `unknown → UNKNOWN_PLAN_FALLBACK_USD($20) × 0.7 = $14`。
 * 而 $20 是 **ChatGPT Plus** 的官方价,拿它兜底 gemini / kiro / cursor / trae / qoder 是**编造的价格**。
 * 更糟的是 gemini 账号里**明明有** `plan_name`(`"Gemini Code Assist in Google One AI Pro"`),
 * 却被丢弃 —— 因为 `normalizePlan` 会把 "...AI Pro" 误判成 ChatGPT 的 `pro` → $100(更离谱)。
 *
 * 本模块用**归一化 token 全命中**规则匹配,不走 `normalizePlan`,避免上述误判。
 *
 * 铁律:**未命中返回 null,绝不编造价格**。
 * 官方未公开价 / 来源分歧 / 按量计费的档位一律 `usd: null`,由调用方标"未识别"。
 *
 * 价目来源:docs/prd/2026-09-11-多渠道成本接入-增量PRD.md §4.2(13 个价目族)。
 * 查询日期:PLAN_PRICE_CHECKED_AT。
 */

import type { CostPlan } from './model'

export type PlanFamily =
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'claude'
  | 'cursor'
  | 'github-copilot'
  | 'kiro'
  | 'trae'
  | 'windsurf'
  | 'codebuddy'
  | 'qoder'
  | 'zed'
  | 'grok'

/** 价目查询日期(PRD §4.2 表头)。价格会变,标出来才自证。 */
export const PLAN_PRICE_CHECKED_AT = '2026-09-11'

export interface PlanPriceRule {
  /** 价目族 */
  family: PlanFamily
  /** 档位名(与 PRD §4.2 表一致,供 UI 展示) */
  tier: string
  /** 官方月费(USD)。null = 未公开 / 来源分歧 / 按量计费 → 不编造 */
  usd: number | null
  /** CNY 计价档位(国内渠道)。usd 为 null 且调用方给了汇率时才折算 */
  cny?: number
  /** 归一到 CostPlan 枚举 */
  plan: CostPlan
  /** 归一化 token,**全部命中**才算匹配(顺序无关) */
  keys: string[]
  /** 命中任一即排除(用于"同名不同族"的消歧) */
  exclude?: string[]
  /** 来源 URL */
  source: string
}

export interface PlanLabelMatch {
  rule: PlanPriceRule
  /** 归一化后的标签 */
  normalized: string
  /** 匹配到的 token 列表(调试/测试用) */
  tokens: string[]
}

/* -------------------------------------------------------------------------- */
/* 归一化                                                                      */
/* -------------------------------------------------------------------------- */

/** 来源 URL 常量(PRD §4.2)。 */
const SRC = Object.freeze({
  chatgpt: 'chatgpt.com/pricing',
  openai: 'openai.com/id-ID/pricing',
  radar: 'aipriceradar.com/tool/chatgpt-pricing',
  geminiSub: 'gemini.google/subscriptions',
  geminiPx: 'perspectiveai.xyz/pricing/gemini',
  codeassist: 'codeassist.google',
  claudePricing: 'anthropic.com/pricing',
  claudeHelp: 'support.anthropic.com/zh-CN/articles/11049741',
  claudeTeam: 'anthropic.com/team',
  cursorPricing: 'cursor.com/pricing',
  cursorFello: 'felloai.com/cursor-pricing',
  ghDocs: 'docs.github.com/copilot/get-started/plans',
  kiro: 'kiro.dev/pricing',
  trae: 'docs.trae.ai/ide/new-plans-and-billing',
  devin: 'devin.ai/pricing',
  windsurf: 'windsurf.com',
  codebuddyIntl: 'intl.cloud.tencent.com/document/product/1256/77270',
  codebuddyCn: 'copilot.tencent.com/docs/ide/Account/pricing',
  qoderIntl: 'docs.qoder.com/events/pricing-adjustment-notice',
  qoderCn: 'cn.aliyun.com/notice/118264',
  lingma: 'alibabacloud.com/help/lingma/account-and-subscription',
  zed: 'zed.dev/pricing',
  grokPlans: 'grok.com/plans',
  xai: 'x.ai/pricing',
  unknown: '—',
})

/**
 * 多词同义合并:先把常见复合词压成单 token,再做 token 全命中匹配。
 * **顺序敏感** —— 长复合词在前,x 倍率后缀早于其它。
 */
const LABEL_ALIASES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['gemini code assist', 'geminicodeassist'],
  ['gemini advanced', 'geminiadvanced'],
  ['github copilot', 'githubcopilot'],
  ['code buddy', 'codebuddy'],
  ['code assist', 'codeassist'],
  ['super grok', 'supergrok'],
  ['google one', 'googleone'],
  ['x premium', 'xpremium'],
  ['pro plus', 'proplus'],
  ['pro max', 'promax'],
  ['team standard', 'teamstandard'],
  ['teams standard', 'teamstandard'],
  ['team premium', 'teampremium'],
  ['teams premium', 'teampremium'],
  ['ultra 20x', 'ultra20x'],
  ['ultra 5x', 'ultra5x'],
  ['max 20x', 'max20x'],
  ['max 5x', 'max5x'],
  ['pro 20x', 'pro20x'],
  ['pro 5x', 'pro5x'],
])

/**
 * 归一化:小写 → `+` 变 ` plus ` → 字母与数字之间插空格(`ultra20x`→`ultra 20x`)
 * → 非字母数字/中文变空格 → 应用复合词别名 → 折叠空格。
 *
 * 例:`"Gemini Code Assist in Google One AI Pro"` → `"geminicodeassist in googleone ai pro"`
 */
export function normalizePlanLabel(value: string): string {
  let text = value.toLowerCase().replace(/\+/g, ' plus ')
  text = text.replace(/([a-z])(\d)/g, '$1 $2')
  text = text.replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim()
  for (const [from, to] of LABEL_ALIASES) {
    if (text.includes(from)) text = text.split(from).join(to)
  }
  return text.replace(/\s+/g, ' ').trim()
}

/** 归一化文本 → token 集合。 */
export function planLabelTokens(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter(Boolean))
}

/* -------------------------------------------------------------------------- */
/* 价目表(PRD §4.2,13 个价目族)                                               */
/* 顺序敏感:族内细分在前、泛化在后;族限定规则全部排在通用规则之前。            */
/* -------------------------------------------------------------------------- */

export const PLAN_PRICE_BOOK: readonly PlanPriceRule[] = Object.freeze([
  // ── §4.2.1 ChatGPT / Codex ────────────────────────────────────────────────
  { family: 'codex', tier: 'Free', usd: 0, plan: 'free', keys: ['chatgpt', 'free'], source: SRC.chatgpt },
  { family: 'codex', tier: 'Free', usd: 0, plan: 'free', keys: ['codex', 'free'], source: SRC.chatgpt },
  { family: 'codex', tier: 'Go', usd: 8, plan: 'plus', keys: ['go'], source: SRC.openai },
  { family: 'codex', tier: 'Pro (20x)', usd: 200, plan: 'pro', keys: ['chatgpt', 'pro20x'], source: SRC.radar },
  { family: 'codex', tier: 'Pro (20x)', usd: 200, plan: 'pro', keys: ['codex', 'pro20x'], source: SRC.radar },
  { family: 'codex', tier: 'Pro (5x)', usd: 100, plan: 'pro', keys: ['chatgpt', 'pro5x'], source: SRC.chatgpt },
  { family: 'codex', tier: 'Pro (5x)', usd: 100, plan: 'pro', keys: ['codex', 'pro5x'], source: SRC.chatgpt },
  { family: 'codex', tier: 'Pro (5x)', usd: 100, plan: 'pro', keys: ['chatgpt', 'pro'], exclude: ['proplus'], source: SRC.chatgpt },
  { family: 'codex', tier: 'Pro (5x)', usd: 100, plan: 'pro', keys: ['codex', 'pro'], exclude: ['proplus'], source: SRC.chatgpt },
  { family: 'codex', tier: 'Pro (5x)', usd: 100, plan: 'pro', keys: ['openai', 'pro'], exclude: ['proplus'], source: SRC.chatgpt },
  { family: 'codex', tier: 'Plus', usd: 20, plan: 'plus', keys: ['chatgpt', 'plus'], exclude: ['proplus'], source: SRC.chatgpt },
  { family: 'codex', tier: 'Plus', usd: 20, plan: 'plus', keys: ['codex', 'plus'], exclude: ['proplus'], source: SRC.chatgpt },
  { family: 'codex', get tier() { return costDataText('businessFormerlyTeam') }, usd: 25, plan: 'business', keys: ['chatgpt', 'business'], source: SRC.chatgpt },
  { family: 'codex', get tier() { return costDataText('businessFormerlyTeam') }, usd: 25, plan: 'business', keys: ['openai', 'business'], source: SRC.chatgpt },
  { family: 'codex', get tier() { return costDataText('businessCodexUsageBasedSeatNoFixedSeatFee') }, usd: null, plan: 'unknown', keys: ['business', 'codex'], source: SRC.chatgpt },
  { family: 'codex', get tier() { return costDataText('enterpriseCustomNoPublicPriceFound') }, usd: null, plan: 'unknown', keys: ['chatgpt', 'enterprise'], source: SRC.chatgpt },

  // ── §4.2.2 Google / Gemini ────────────────────────────────────────────────
  { family: 'gemini', tier: 'Google AI Ultra (20x)', usd: 199.99, plan: 'pro', keys: ['ai', 'ultra20x'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Google AI Ultra (20x)', usd: 199.99, plan: 'pro', keys: ['gemini', 'ultra20x'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Google AI Ultra (5x)', usd: 99.99, plan: 'pro', keys: ['ai', 'ultra5x'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Google AI Ultra (5x)', usd: 99.99, plan: 'pro', keys: ['gemini', 'ultra5x'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Google AI Ultra (5x)', usd: 99.99, plan: 'pro', keys: ['ai', 'ultra'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Google AI Ultra (5x)', usd: 99.99, plan: 'pro', keys: ['gemini', 'ultra'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Google AI Plus', usd: 4.99, plan: 'plus', keys: ['ai', 'plus'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Google AI Plus', usd: 4.99, plan: 'plus', keys: ['gemini', 'plus'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Gemini Code Assist Enterprise', usd: 45, plan: 'business', keys: ['geminicodeassist', 'enterprise'], source: SRC.codeassist },
  { family: 'gemini', tier: 'Gemini Code Assist Enterprise', usd: 45, plan: 'business', keys: ['codeassist', 'enterprise'], source: SRC.codeassist },
  { family: 'gemini', tier: 'Gemini Code Assist Standard', usd: 19, plan: 'team', keys: ['geminicodeassist', 'standard'], source: SRC.codeassist },
  { family: 'gemini', tier: 'Gemini Code Assist Standard', usd: 19, plan: 'team', keys: ['codeassist', 'standard'], source: SRC.codeassist },
  // ⭐ PRD §4.2.2 第一个验收用例:本机 gemini 账号 plan_name
  //    "Gemini Code Assist in Google One AI Pro" → geminicodeassist in googleone ai pro
  { family: 'gemini', get tier() { return costDataText('googleAiProFormerlyGeminiAdvanced') }, usd: 19.99, plan: 'pro', keys: ['googleone', 'ai', 'pro'], source: SRC.geminiPx },
  { family: 'gemini', get tier() { return costDataText('googleAiProFormerlyGeminiAdvanced') }, usd: 19.99, plan: 'pro', keys: ['ai', 'pro'], source: SRC.geminiPx },
  { family: 'gemini', get tier() { return costDataText('googleAiProFormerlyGeminiAdvanced') }, usd: 19.99, plan: 'pro', keys: ['geminiadvanced'], source: SRC.geminiPx },
  { family: 'gemini', get tier() { return costDataText('googleAiProFormerlyGeminiAdvanced') }, usd: 19.99, plan: 'pro', keys: ['gemini', 'pro'], exclude: ['codeassist', 'geminicodeassist'], source: SRC.geminiPx },
  { family: 'gemini', tier: 'Gemini Code Assist for individuals', usd: 0, plan: 'free', keys: ['geminicodeassist'], exclude: ['standard', 'enterprise'], source: SRC.codeassist },
  { family: 'gemini', tier: 'Gemini Code Assist for individuals', usd: 0, plan: 'free', keys: ['codeassist'], exclude: ['standard', 'enterprise'], source: SRC.codeassist },
  { family: 'gemini', tier: 'Free', usd: 0, plan: 'free', keys: ['ai', 'free'], source: SRC.geminiSub },
  { family: 'gemini', tier: 'Free', usd: 0, plan: 'free', keys: ['gemini', 'free'], source: SRC.geminiSub },

  // ── §4.2.14 Antigravity(跟随 Google AI 档位)──────────────────────────────
  { family: 'antigravity', get tier() { return costDataText('includedWithGoogleAiUltra20x') }, usd: 199.99, plan: 'pro', keys: ['antigravity', 'ultra20x'], source: SRC.geminiSub },
  { family: 'antigravity', get tier() { return costDataText('includedWithGoogleAiUltra5x') }, usd: 99.99, plan: 'pro', keys: ['antigravity', 'ultra'], source: SRC.geminiSub },
  { family: 'antigravity', get tier() { return costDataText('includedWithGoogleAiPro') }, usd: 19.99, plan: 'pro', keys: ['antigravity', 'pro'], source: SRC.geminiSub },
  { family: 'antigravity', get tier() { return costDataText('includedWithGoogleAiPlus') }, usd: 4.99, plan: 'plus', keys: ['antigravity', 'plus'], source: SRC.geminiSub },
  { family: 'antigravity', get tier() { return costDataText('includedWithGoogleAiFree') }, usd: 0, plan: 'free', keys: ['antigravity', 'free'], source: SRC.geminiSub },

  // ── §4.2.3 Claude ─────────────────────────────────────────────────────────
  { family: 'claude', tier: 'Max 20x', usd: 200, plan: 'pro', keys: ['claude', 'max20x'], source: SRC.claudeHelp },
  { family: 'claude', tier: 'Max 20x', usd: 200, plan: 'pro', keys: ['max20x'], source: SRC.claudeHelp },
  { family: 'claude', tier: 'Max 5x', usd: 100, plan: 'pro', keys: ['claude', 'max5x'], source: SRC.claudeHelp },
  { family: 'claude', tier: 'Max 5x', usd: 100, plan: 'pro', keys: ['max5x'], source: SRC.claudeHelp },
  { family: 'claude', tier: 'Max 5x', usd: 100, plan: 'pro', keys: ['claude', 'max'], source: SRC.claudeHelp },
  { family: 'claude', tier: 'Team Premium', usd: 125, plan: 'business', keys: ['claude', 'teampremium'], source: SRC.claudeTeam },
  { family: 'claude', tier: 'Team Standard', usd: 25, plan: 'team', keys: ['claude', 'teamstandard'], source: SRC.claudeTeam },
  { family: 'claude', tier: 'Team Standard', usd: 25, plan: 'team', keys: ['claude', 'team'], source: SRC.claudeTeam },
  { family: 'claude', tier: 'Team Standard', usd: 25, plan: 'team', keys: ['claude', 'teams'], source: SRC.claudeTeam },
  { family: 'claude', tier: 'Pro', usd: 20, plan: 'pro', keys: ['claude', 'pro'], exclude: ['proplus'], source: SRC.claudePricing },
  { family: 'claude', tier: 'Free', usd: 0, plan: 'free', keys: ['claude', 'free'], source: SRC.claudePricing },
  { family: 'claude', get tier() { return costDataText('enterpriseSeatFeeUsage') }, usd: null, plan: 'unknown', keys: ['claude', 'enterprise'], source: SRC.claudeTeam },

  // ── §4.2.4 Cursor ─────────────────────────────────────────────────────────
  { family: 'cursor', tier: 'Teams Premium', usd: 120, plan: 'business', keys: ['cursor', 'teampremium'], source: SRC.cursorFello },
  { family: 'cursor', tier: 'Teams Standard', usd: 40, plan: 'team', keys: ['cursor', 'teamstandard'], source: SRC.cursorPricing },
  { family: 'cursor', tier: 'Teams Standard', usd: 40, plan: 'team', keys: ['cursor', 'teams'], source: SRC.cursorPricing },
  { family: 'cursor', tier: 'Teams Standard', usd: 40, plan: 'team', keys: ['cursor', 'team'], source: SRC.cursorPricing },
  { family: 'cursor', tier: 'Ultra', usd: 200, plan: 'pro', keys: ['cursor', 'ultra'], source: SRC.cursorPricing },
  { family: 'cursor', tier: 'Pro+', usd: 60, plan: 'pro', keys: ['cursor', 'proplus'], source: SRC.cursorPricing },
  { family: 'cursor', get tier() { return costDataText('proTrialProcurementCostTreatmentNotConfirmed') }, usd: null, plan: 'unknown', keys: ['cursor', 'pro', 'trial'], source: SRC.cursorPricing },
  { family: 'cursor', tier: 'Pro', usd: 20, plan: 'pro', keys: ['cursor', 'pro'], exclude: ['proplus', 'ultra', 'trial'], source: SRC.cursorPricing },
  { family: 'cursor', tier: 'Hobby', usd: 0, plan: 'free', keys: ['cursor', 'hobby'], source: SRC.cursorPricing },
  { family: 'cursor', get tier() { return costDataText('enterpriseCustomPriceNotFound') }, usd: null, plan: 'unknown', keys: ['cursor', 'enterprise'], source: SRC.cursorPricing },

  // ── §4.2.5 GitHub Copilot ─────────────────────────────────────────────────
  { family: 'github-copilot', tier: 'Enterprise', usd: 39, plan: 'business', keys: ['copilot', 'enterprise'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Enterprise', usd: 39, plan: 'business', keys: ['githubcopilot', 'enterprise'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Business', usd: 19, plan: 'business', keys: ['copilot', 'business'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Business', usd: 19, plan: 'business', keys: ['githubcopilot', 'business'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Max', usd: 100, plan: 'pro', keys: ['copilot', 'max'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Pro+', usd: 39, plan: 'pro', keys: ['copilot', 'proplus'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Pro+', usd: 39, plan: 'pro', keys: ['githubcopilot', 'proplus'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Pro', usd: 10, plan: 'pro', keys: ['copilot', 'pro'], exclude: ['proplus'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Pro', usd: 10, plan: 'pro', keys: ['githubcopilot', 'pro'], exclude: ['proplus'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Free / Student', usd: 0, plan: 'free', keys: ['copilot', 'free'], source: SRC.ghDocs },
  { family: 'github-copilot', tier: 'Free / Student', usd: 0, plan: 'free', keys: ['copilot', 'student'], source: SRC.ghDocs },

  // ── §4.2.6 Kiro ───────────────────────────────────────────────────────────
  { family: 'kiro', tier: 'Power', usd: 200, plan: 'pro', keys: ['kiro', 'power'], source: SRC.kiro },
  { family: 'kiro', tier: 'Pro Max', usd: 100, plan: 'pro', keys: ['kiro', 'promax'], source: SRC.kiro },
  { family: 'kiro', tier: 'Pro+', usd: 40, plan: 'pro', keys: ['kiro', 'proplus'], source: SRC.kiro },
  { family: 'kiro', tier: 'Pro', usd: 20, plan: 'pro', keys: ['kiro', 'pro'], exclude: ['proplus', 'promax'], source: SRC.kiro },
  { family: 'kiro', tier: 'Free', usd: 0, plan: 'free', keys: ['kiro', 'free'], source: SRC.kiro },
  { family: 'kiro', get tier() { return costDataText('teamUsageBased004CreditNoFixedSeat') }, usd: null, plan: 'unknown', keys: ['kiro', 'team'], source: SRC.kiro },

  // ── §4.2.7 Trae ───────────────────────────────────────────────────────────
  { family: 'trae', tier: 'Ultra', usd: 100, plan: 'pro', keys: ['trae', 'ultra'], exclude: ['cn'], source: SRC.trae },
  { family: 'trae', tier: 'Pro+', usd: 30, plan: 'pro', keys: ['trae', 'proplus'], exclude: ['cn'], source: SRC.trae },
  { family: 'trae', tier: 'Pro', usd: 10, plan: 'pro', keys: ['trae', 'pro'], exclude: ['proplus', 'ultra', 'cn'], source: SRC.trae },
  { family: 'trae', tier: 'Lite', usd: 3, plan: 'plus', keys: ['trae', 'lite'], exclude: ['cn'], source: SRC.trae },
  { family: 'trae', tier: 'Free', usd: 0, plan: 'free', keys: ['trae', 'free'], exclude: ['cn'], source: SRC.trae },
  { family: 'trae', get tier() { return costDataText('traeCnNoPublicPersonalPriceFound') }, usd: null, plan: 'unknown', keys: ['trae', 'cn'], source: SRC.unknown },

  // ── §4.2.8 Devin / Windsurf ───────────────────────────────────────────────
  { family: 'windsurf', get tier() { return costDataText('teams80BaseFee40Seat') }, usd: 80, plan: 'team', keys: ['windsurf', 'teams'], source: SRC.devin },
  { family: 'windsurf', get tier() { return costDataText('teams80BaseFee40Seat') }, usd: 80, plan: 'team', keys: ['devin', 'teams'], source: SRC.devin },
  { family: 'windsurf', tier: 'Max', usd: 200, plan: 'pro', keys: ['windsurf', 'max'], source: SRC.devin },
  { family: 'windsurf', tier: 'Max', usd: 200, plan: 'pro', keys: ['devin', 'max'], source: SRC.devin },
  { family: 'windsurf', tier: 'Pro', usd: 20, plan: 'pro', keys: ['windsurf', 'pro'], exclude: ['proplus'], source: SRC.devin },
  { family: 'windsurf', tier: 'Pro', usd: 20, plan: 'pro', keys: ['devin', 'pro'], exclude: ['proplus'], source: SRC.devin },
  { family: 'windsurf', tier: 'Free', usd: 0, plan: 'free', keys: ['windsurf', 'free'], source: SRC.windsurf },
  { family: 'windsurf', tier: 'Free', usd: 0, plan: 'free', keys: ['devin', 'free'], source: SRC.devin },
  { family: 'windsurf', get tier() { return costDataText('enterpriseCustomPriceNotFound') }, usd: null, plan: 'unknown', keys: ['windsurf', 'enterprise'], source: SRC.devin },

  // ── §4.2.9 CodeBuddy / WorkBuddy ──────────────────────────────────────────
  { family: 'codebuddy', get tier() { return costDataText('teamInternational') }, usd: 40, plan: 'team', keys: ['codebuddy', 'team'], exclude: ['cn'], source: SRC.codebuddyIntl },
  { family: 'codebuddy', get tier() { return costDataText('proInternational') }, usd: 10, plan: 'pro', keys: ['codebuddy', 'pro'], exclude: ['proplus', 'cn'], source: SRC.codebuddyIntl },
  { family: 'codebuddy', get tier() { return costDataText('freeInternational') }, usd: 0, plan: 'free', keys: ['codebuddy', 'free'], exclude: ['cn'], source: SRC.codebuddyIntl },
  { family: 'codebuddy', get tier() { return costDataText('flagshipCnCny999Month') }, usd: null, cny: 999, plan: 'pro', keys: ['codebuddy', 'cn', '旗舰版'], source: SRC.codebuddyCn },
  { family: 'codebuddy', get tier() { return costDataText('advancedCnCny199Month') }, usd: null, cny: 199, plan: 'pro', keys: ['codebuddy', 'cn', '高级版'], source: SRC.codebuddyCn },
  { family: 'codebuddy', get tier() { return costDataText('standardCnCny99Month') }, usd: null, cny: 99, plan: 'pro', keys: ['codebuddy', 'cn', '标准版'], source: SRC.codebuddyCn },
  { family: 'codebuddy', get tier() { return costDataText('trialCnFree') }, usd: 0, plan: 'free', keys: ['codebuddy', 'cn', '体验版'], source: SRC.codebuddyCn },
  { family: 'codebuddy', get tier() { return costDataText('codebuddyCnUnrecognizedTier') }, usd: null, plan: 'unknown', keys: ['codebuddy', 'cn'], source: SRC.codebuddyCn },
  { family: 'codebuddy', get tier() { return costDataText('workbuddySharesTheCodebuddySubscriptionNotChargedTwice') }, usd: null, plan: 'unknown', keys: ['workbuddy'], source: SRC.codebuddyCn },

  // ── §4.2.10 Qoder ─────────────────────────────────────────────────────────
  { family: 'qoder', get tier() { return costDataText('ultraInternational') }, usd: 200, plan: 'pro', keys: ['qoder', 'ultra'], exclude: ['cn'], source: SRC.qoderIntl },
  { family: 'qoder', get tier() { return costDataText('teamsInternational') }, usd: 40, plan: 'team', keys: ['qoder', 'teams'], exclude: ['cn'], source: SRC.qoderIntl },
  { family: 'qoder', get tier() { return costDataText('teamsInternational') }, usd: 40, plan: 'team', keys: ['qoder', 'team'], exclude: ['cn'], source: SRC.qoderIntl },
  { family: 'qoder', get tier() { return costDataText('proInternational2') }, usd: 60, plan: 'pro', keys: ['qoder', 'proplus'], exclude: ['cn'], source: SRC.qoderIntl },
  { family: 'qoder', get tier() { return costDataText('proInternational') }, usd: 20, plan: 'pro', keys: ['qoder', 'pro'], exclude: ['proplus', 'ultra', 'cn'], source: SRC.qoderIntl },
  { family: 'qoder', get tier() { return costDataText('freeInternational') }, usd: 0, plan: 'free', keys: ['qoder', 'free'], exclude: ['cn'], source: SRC.qoderIntl },
  { family: 'qoder', get tier() { return costDataText('enterpriseVpcCnCny199SeatMonth') }, usd: null, cny: 199, plan: 'business', keys: ['qoder', 'cn', 'vpc'], source: SRC.qoderCn },
  { family: 'qoder', get tier() { return costDataText('enterpriseStandardCnCny149SeatMonth') }, usd: null, cny: 149, plan: 'business', keys: ['qoder', 'cn', '标准版'], source: SRC.lingma },
  { family: 'qoder', get tier() { return costDataText('teamsCnCny99SeatMonth') }, usd: null, cny: 99, plan: 'team', keys: ['qoder', 'cn', 'teams'], source: SRC.qoderCn },
  { family: 'qoder', get tier() { return costDataText('teamsCnCny99SeatMonth') }, usd: null, cny: 99, plan: 'team', keys: ['qoder', 'cn', 'team'], source: SRC.qoderCn },
  { family: 'qoder', get tier() { return costDataText('personalAdvancedProCnCny169Month') }, usd: null, cny: 169, plan: 'pro', keys: ['qoder', 'cn', 'proplus'], source: SRC.lingma },
  { family: 'qoder', get tier() { return costDataText('personalProfessionalProCnCny59Month') }, usd: null, cny: 59, plan: 'pro', keys: ['qoder', 'cn', 'pro'], exclude: ['proplus'], source: SRC.qoderCn },
  { family: 'qoder', get tier() { return costDataText('personalCommunityFree') }, usd: 0, plan: 'free', keys: ['qoder', 'cn', '社区版'], source: SRC.qoderCn },
  { family: 'qoder', get tier() { return costDataText('qoderCnUnrecognizedTier') }, usd: null, plan: 'unknown', keys: ['qoder', 'cn'], source: SRC.qoderCn },

  // ── §4.2.11 Zed ───────────────────────────────────────────────────────────
  { family: 'zed', tier: 'Business', usd: 30, plan: 'business', keys: ['zed', 'business'], source: SRC.zed },
  { family: 'zed', tier: 'Pro', usd: 10, plan: 'pro', keys: ['zed', 'pro'], exclude: ['proplus'], source: SRC.zed },
  { family: 'zed', tier: 'Personal', usd: 0, plan: 'free', keys: ['zed', 'personal'], source: SRC.zed },
  { family: 'zed', get tier() { return costDataText('studentEducationBenefit') }, usd: 0, plan: 'free', keys: ['zed', 'student'], source: SRC.zed },

  // ── §4.2.12 Grok CLI ──────────────────────────────────────────────────────
  { family: 'grok', tier: 'SuperGrok Heavy', usd: 300, plan: 'pro', keys: ['supergrok', 'heavy'], source: SRC.xai },
  { family: 'grok', tier: 'SuperGrok Plus', usd: 100, plan: 'pro', keys: ['supergrok', 'plus'], source: SRC.xai },
  { family: 'grok', tier: 'SuperGrok Lite', usd: 10, plan: 'plus', keys: ['supergrok', 'lite'], source: SRC.grokPlans },
  { family: 'grok', tier: 'SuperGrok', usd: 30, plan: 'pro', keys: ['supergrok'], exclude: ['lite', 'plus', 'heavy'], source: SRC.xai },
  { family: 'grok', tier: 'X Premium+', usd: 40, plan: 'pro', keys: ['xpremium', 'plus'], source: SRC.xai },
  { family: 'grok', tier: 'X Premium', usd: 8, plan: 'plus', keys: ['xpremium'], exclude: ['plus'], source: SRC.xai },
  { family: 'grok', tier: 'Business', usd: 30, plan: 'business', keys: ['grok', 'business'], source: SRC.xai },
  { family: 'grok', tier: 'Free', usd: 0, plan: 'free', keys: ['grok', 'free'], source: SRC.grokPlans },
  { family: 'grok', get tier() { return costDataText('enterpriseCustomPriceNotFound') }, usd: null, plan: 'unknown', keys: ['grok', 'enterprise'], source: SRC.xai },

  // ── 通用档位(无法确定厂商):只保留**跨族一致**的档位,其余一律 null ──────────
  { family: 'codex', get tier() { return costDataText('studentEduFree') }, usd: 0, plan: 'free', keys: ['student'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('freeGeneric') }, usd: 0, plan: 'free', keys: ['free'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('plusGeneric20Month') }, usd: 20, plan: 'plus', keys: ['plus'], exclude: ['ai', 'googleone', 'gemini', 'google', 'xpremium', 'supergrok', 'cn'], source: SRC.chatgpt },
  { family: 'codex', get tier() { return costDataText('proGeneric20Month') }, usd: 20, plan: 'pro', keys: ['pro'], exclude: ['ai', 'chatgpt', 'codex', 'openai', 'google', 'googleone', 'gemini', 'plus', 'max', 'ultra', 'assist', 'codeassist', 'geminicodeassist', 'trial', 'cn'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('teamGeneric25Seat') }, usd: 25, plan: 'team', keys: ['team'], exclude: ['cursor', 'qoder', 'codebuddy', 'kiro', 'zed', 'claude', 'cn'], source: SRC.chatgpt },
  { family: 'codex', get tier() { return costDataText('teamsGeneric25Seat') }, usd: 25, plan: 'team', keys: ['teams'], exclude: ['cursor', 'qoder', 'codebuddy', 'kiro', 'zed', 'claude', 'cn'], source: SRC.chatgpt },
  { family: 'codex', get tier() { return costDataText('businessGeneric25UserMonth') }, usd: 25, plan: 'business', keys: ['business'], exclude: ['copilot', 'zed', 'grok', 'githubcopilot', 'cn'], source: SRC.chatgpt },
  { family: 'codex', get tier() { return costDataText('ultraPricesVaryByProductNotInferred') }, usd: null, plan: 'unknown', keys: ['ultra'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('maxPricesVaryByProductNotInferred') }, usd: null, plan: 'unknown', keys: ['max'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('proPricesVaryByProductNotInferred') }, usd: null, plan: 'unknown', keys: ['proplus'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('proMaxProviderDependentNotInferred') }, usd: null, plan: 'unknown', keys: ['promax'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('enterpriseUsuallyCustomPricingNotInferred') }, usd: null, plan: 'unknown', keys: ['enterprise'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('personalNotAClaudePricingTier') }, usd: null, plan: 'unknown', keys: ['personal'], exclude: ['zed'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('trialProcurementCostTreatmentNotConfirmed') }, usd: null, plan: 'unknown', keys: ['trial'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('apiKeyUsageBasedNoMonthlyFee') }, usd: null, plan: 'unknown', keys: ['apikey'], source: SRC.unknown },
  { family: 'codex', get tier() { return costDataText('apiKeyUsageBasedNoMonthlyFee') }, usd: null, plan: 'unknown', keys: ['api', 'key'], source: SRC.unknown },
])

/* -------------------------------------------------------------------------- */
/* 匹配 API                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 匹配 plan_name 原文。未命中返回 null(**调用方必须标注"未识别",不得编造价格**)。
 */
export function describePlanLabel(planLabel?: string | null): PlanLabelMatch | null {
  if (typeof planLabel !== 'string') return null
  const normalized = normalizePlanLabel(planLabel)
  if (!normalized) return null
  const tokens = planLabelTokens(normalized)
  if (tokens.size === 0) return null

  for (const rule of PLAN_PRICE_BOOK) {
    if (!rule.keys.every((key) => tokens.has(key))) continue
    if (rule.exclude?.some((key) => tokens.has(key))) continue
    return { rule, normalized, tokens: Array.from(tokens) }
  }
  return null
}

/**
 * plan_name 原文 → 官方月费(USD)。
 *
 * 未命中 / 官方未公开价 / 来源分歧 / 按量计费 → 返回 **null**(不编造)。
 *
 * @param cnyPerUsd CNY 档位折算用汇率;不传则 CNY 档位返回 null(宁缺勿造)。
 */
export function subscriptionPriceUsdOf(planLabel?: string | null, cnyPerUsd?: number | null): number | null {
  const matched = describePlanLabel(planLabel)
  if (!matched) return null

  const { usd, cny } = matched.rule
  if (typeof usd === 'number') return usd
  if (typeof cny === 'number' && typeof cnyPerUsd === 'number' && cnyPerUsd > 0 && Number.isFinite(cnyPerUsd)) {
    return cny / cnyPerUsd
  }
  return null
}

/** plan_name 原文 → CostPlan 枚举。未命中返回 'unknown'(由既有 unknown 兜底接管)。 */
export function planOfLabel(planLabel?: string | null): CostPlan {
  return describePlanLabel(planLabel)?.rule.plan ?? 'unknown'
}

/* -------------------------------------------------------------------------- */
/* 从账号对象里取 plan 原文                                                     */
/* -------------------------------------------------------------------------- */

/** 账号 extra 里可能存放 plan 原文的字段(按优先级)。 */
export const PLAN_LABEL_EXTRA_KEYS: readonly string[] = Object.freeze([
  'cockpit_plan_label',
  'plan_name',
  'plan_label',
  'subscription_name',
  'membership_type',
])
/** 账号 credentials 里可能存放 plan 原文的字段(按优先级)。 */
export const PLAN_LABEL_CREDENTIAL_KEYS: readonly string[] = Object.freeze([
  'plan_name',
  'plan_label',
  'membership_type',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

/**
 * 取账号的 plan 原文(cockpit 平台账号存在 `extra.cockpit_plan_label`)。
 * 取不到返回 null —— 调用方走既有 inferPlan 逻辑,行为不变。
 */
export function planLabelOf(
  account: { extra?: unknown; credentials?: unknown } | null | undefined,
): string | null {
  if (!account) return null
  const extra = isRecord(account.extra) ? account.extra : undefined
  const credentials = isRecord(account.credentials) ? account.credentials : undefined
  return pickString(extra, PLAN_LABEL_EXTRA_KEYS) ?? pickString(credentials, PLAN_LABEL_CREDENTIAL_KEYS)
}
