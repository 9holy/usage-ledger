import { costDataText } from './costDataText'
/**
 * cockpit 内置价目表(Codex/OpenAI 公开价,USD / 1M tokens)
 *
 * 数据来源(2026-09-08 取本机已安装版本,**不是**仓库里的老源码):
 *   - 已安装:`E:\Cockpit Tools\cockpit-tools.exe`(server.json version = 1.3.45)
 *   - 价目表编译在 Rust 二进制的 .rdata 中(const CODEX_LOCAL_ACCESS_PRICE_BOOK),
 *     条目布局 [&str 指针 8B][len 8B][standard 3×f64][long_context 8B][Option<price> tag 8B][priority 3×f64],
 *     按模型字符串池首地址定位后逐条解析导出。
 *   - 版本号取自 `codex_local_access.json.modelPricingVersion` = **3**
 *     (仓库 cockpit-tools-main 是老版本 2,缺 gpt-6-astra 等新模型)。
 *   - 交叉验证:标准档 17 个模型与老源码 CODEX_LOCAL_ACCESS_PRICE_BOOK 逐条一致,
 *     长上下文档位标记也完全一致 → 解析可信。
 *
 * 为什么不直接读文件:cockpit 只把**用户手动改过的**价目写进 `codex_local_access.json.modelPricings`
 * (本机仅 2 条),内置价目表不落盘、也不提供 HTTP 接口(本地接入服务只开放 /v1/models,不带价格)。
 *
 * **长上下文档位价已实测验证(2026-09-08)**:
 * 用本机 `codex_local_access_logs.sqlite` 的 179k 行单请求记录逐条对账——
 * cockpit 落库的 `input_usd_per_million` 恰好只有两个取值,切换点与
 * `input_tokens > 272_000` **完全一致**(如 astra:10/1/50 ↔ 20/2/75,即 ×2/×2/×1.5)。
 * 用"标准档 token × 标准价 + 长文本档 token × 长文本价"复算,与 cockpit 自己的
 * `estimated_cost_usd` 分毫不差(全量 $24,058.36;7 天窗口 $5,896.637222,差 0)。
 *
 * 维护提示:cockpit 升级后若 modelPricingVersion 变化,需重新按上述方法导出并覆盖本文件。
 */

/** 与 cockpit model_pricing_version 对齐(本机 1.3.45 = 3)。 */
// 仅类型导入(编译期擦除,不构成运行时循环依赖)
import type { CockpitModelPricing } from '@/api/cockpit'

export const COCKPIT_PRICE_BOOK_VERSION = 3

/** 长上下文阈值(单次会话 token 超过此值启用长上下文档位价)。 */
export const COCKPIT_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000

/** 长上下文档位倍率(输入 / 缓存命中 / 输出)。 */
export const COCKPIT_LONG_CONTEXT_MULTIPLIERS = {
  input: 2,
  cache: 2,
  output: 1.5,
} as const

/** 服务档位倍率:priority 无显式价时 ×2,flex ×0.5,standard 不调。 */
export const COCKPIT_SERVICE_TIER_MULTIPLIERS = {
  standard: 1,
  priority: 2,
  flex: 0.5,
} as const

/**
 * `service_tier` 原文 → 三档枚举。
 *
 * ★ 空串 / 未知值 / null 一律返回 `null` —— 它表示**「日志未记录档位」**,
 * **绝不**冒充 `standard`。本机实测该列值只有 `''`(185,509 行)与 `'standard'`(844 行),
 * 两者倍率恰好都是 ×1,但语义完全不同:一个是"不知道",一个是"知道是标准档"。
 */
export function normalizeCockpitServiceTier(tier?: string | null): CockpitPriceTier | null {
  const key = (tier ?? '').trim().toLowerCase()
  return key === 'standard' || key === 'priority' || key === 'flex' ? key : null
}

/**
 * 档位倍率。未记录 / 未知档位返回 1 —— 与 `standard` **数值相同、语义不同**:
 * 这是"按 ×1 计,且未按档位计价"的兜底,不是"我们认定它是标准档"。
 */
export function cockpitServiceTierMultiplier(tier?: string | null): number {
  const normalized = normalizeCockpitServiceTier(tier)
  return normalized ? COCKPIT_SERVICE_TIER_MULTIPLIERS[normalized] : 1
}

/** 档位展示文案。未记录档位必须显式写"未记录",不得渲染成 `Standard`。 */
export function cockpitServiceTierLabel(tier?: string | null): string {
  const normalized = normalizeCockpitServiceTier(tier)
  if (normalized === 'priority') return 'Fast（priority）'
  if (normalized === 'flex') return 'Flex'
  if (normalized === 'standard') return 'Standard'
  return costDataText('tierNotRecordedLogsHaveNoServiceTier')
}

export interface CockpitPriceBookPrice {
  /** 输入 美元/百万 token */
  inputUsdPerMillion: number
  /** 缓存命中 美元/百万 token */
  cachedInputUsdPerMillion: number
  /** 输出 美元/百万 token */
  outputUsdPerMillion: number
}

export interface CockpitPriceBookEntry {
  standard: CockpitPriceBookPrice
  /** 该模型是否启用长上下文档位价 */
  sessionLongContext: boolean
}

function price(input: number, cached: number, output: number): CockpitPriceBookPrice {
  return { inputUsdPerMillion: input, cachedInputUsdPerMillion: cached, outputUsdPerMillion: output }
}

/**
 * 从已安装 cockpit-tools 1.3.45 导出的内置价目表(标准档)。
 *
 * 说明:优先档(priority)价目未移植——导出值无法与老版本交叉验证(老版本与新版本
 * priority 不一致,疑似 v3 调整或解析偏移),不做无把握的数据搬运。需要优先档时
 * 走 cockpit 自身规则:无显式价 → 标准档 ×2(见 cockpitPriceForModel)。
 * 影响可控:本机 179k 行请求的 `service_tier` **全为空**(无优先档流量),
 * 且用户在 cockpit 手动配的覆盖价带显式 priority 价,那种情况走显式值不走 ×2。
 */
export const COCKPIT_PRICE_BOOK: Record<string, CockpitPriceBookEntry> = {
  'gpt-6-astra': { standard: price(10, 1, 50), sessionLongContext: true },
  'gpt-5.6-sol': { standard: price(5, 0.5, 30), sessionLongContext: true },
  // 裸 gpt-5.6 走 sol 档
  'gpt-5.6': { standard: price(5, 0.5, 30), sessionLongContext: true },
  'gpt-5.6-terra': { standard: price(2, 0.2, 12), sessionLongContext: true },
  'gpt-5.6-luna': { standard: price(0.2, 0.02, 1.2), sessionLongContext: true },
  'gpt-5.5': { standard: price(5, 0.5, 30), sessionLongContext: true },
  'codex-auto-review': { standard: price(5, 0.5, 30), sessionLongContext: true },
  'gpt-5.4': { standard: price(2.5, 0.25, 15), sessionLongContext: true },
  'gpt-5.4-mini': { standard: price(0.75, 0.075, 4.5), sessionLongContext: false },
  'gpt-5.4-nano': { standard: price(0.2, 0.02, 1.25), sessionLongContext: false },
  'gpt-5.3-codex': { standard: price(1.75, 0.175, 14), sessionLongContext: false },
  'gpt-5.3-codex-spark': { standard: price(1.75, 0.175, 14), sessionLongContext: false },
  'gpt-5.2': { standard: price(1.75, 0.175, 14), sessionLongContext: false },
  'gpt-5.2-codex': { standard: price(1.75, 0.175, 14), sessionLongContext: false },
  'gpt-5.1-codex': { standard: price(1.25, 0.125, 10), sessionLongContext: false },
  'gpt-5.1-codex-max': { standard: price(1.25, 0.125, 10), sessionLongContext: false },
  'gpt-5.1-codex-mini': { standard: price(0.25, 0.025, 2), sessionLongContext: false },
  'gpt-5-codex': { standard: price(1.25, 0.125, 10), sessionLongContext: false },
}

/** 价目组合(服务档位)。 */
export type CockpitPriceTier = 'standard' | 'priority' | 'flex'

/** 取某模型的计价价目(按服务档位)。
 *  priority:价目表未移植显式优先档价,按 cockpit 自身规则 = 标准档 ×2。
 *  flex:标准档 ×0.5。未收录的模型返 null(调用方回退:本地配置价 → 数据源估算)。 */
export function cockpitPriceForModel(
  modelId: string,
  tier: CockpitPriceTier = 'standard',
): CockpitPriceBookPrice | null {
  const entry = COCKPIT_PRICE_BOOK[normalizeCockpitModelKey(modelId)]
  if (!entry) return null
  const mult = COCKPIT_SERVICE_TIER_MULTIPLIERS[tier] ?? 1
  if (mult === 1) return entry.standard
  return {
    inputUsdPerMillion: entry.standard.inputUsdPerMillion * mult,
    cachedInputUsdPerMillion: entry.standard.cachedInputUsdPerMillion * mult,
    outputUsdPerMillion: entry.standard.outputUsdPerMillion * mult,
  }
}

/** 模型 key 归一化(与 cockpit normalize_model_key 同:trim + 小写)。 */
export function normalizeCockpitModelKey(model: string): string {
  return model.trim().toLowerCase()
}

/* -------------------------------------------------------------------------- */
/* 三档价目(标准 / 长文本 / 优先)                                            */
/* -------------------------------------------------------------------------- */

/**
 * 单档单价(per-token,与 ModelDefaultPricing 同单位)。
 * 注意命名沿用本项目口径:cache = 缓存**命中**(cache_read)。
 */
export interface CockpitTierPrice {
  input: number
  output: number
  cache: number
}

/**
 * 单模型完整价目。
 *
 * 为什么要三档而不是一个平价:
 * cockpit 的长上下文档位价是**按单请求** input_tokens > 272_000 判定的
 * (实测 179k 行:与 cockpit 落库单价档 100% 一致)。实测 gpt-6-astra
 * 有 2,688/5,418 条请求走长文本文档,却占了 93% 的成本——按"窗口平均 token"
 * 猜档会把成本算少近一半,必须逐请求分档。
 */
export interface CockpitModelPriceSet {
  standard: CockpitTierPrice
  /** 该模型启用长文本文档位价时存在;否则长文本 token 仍按标准档计价 */
  long?: CockpitTierPrice
  /** 优先档(service_tier=priority)。未配时按 cockpit 自身规则 = 标准档 ×2 */
  priority?: CockpitTierPrice
  sessionLongContext: boolean
  origin: 'local' | 'book'
}

/** cockpit modelPricings(用户手动覆盖价)的类型在这里只取字段,避免与 api 层循环依赖。 */
export interface CockpitLocalPricingInput {
  modelId: string
  longContextThresholdTokens?: number
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
  cachedInputUsdPerMillion?: number
  standardLongInputUsdPerMillion?: number
  standardLongOutputUsdPerMillion?: number
  standardLongCachedInputUsdPerMillion?: number
  priorityInputUsdPerMillion?: number
  priorityOutputUsdPerMillion?: number
  priorityCachedInputUsdPerMillion?: number
}

const PER_MILLION = 1e6

function perToken(input: number, output: number, cache: number): CockpitTierPrice {
  return { input: input / PER_MILLION, output: output / PER_MILLION, cache: cache / PER_MILLION }
}

function scale(p: CockpitTierPrice, m: number): CockpitTierPrice {
  return { input: p.input * m, output: p.output * m, cache: p.cache * m }
}

/** 内置价目表 → 三档价目(长文本档由标准档按 ×2/×2/×1.5 派生,与 cockpit 同规则)。 */
export function cockpitBookPriceSets(): Record<string, CockpitModelPriceSet> {
  const result: Record<string, CockpitModelPriceSet> = {}
  for (const [modelId, entry] of Object.entries(COCKPIT_PRICE_BOOK)) {
    const s = entry.standard
    const standard = perToken(s.inputUsdPerMillion, s.outputUsdPerMillion, s.cachedInputUsdPerMillion)
    result[modelId] = {
      standard,
      long: entry.sessionLongContext
        ? {
          input: standard.input * COCKPIT_LONG_CONTEXT_MULTIPLIERS.input,
          output: standard.output * COCKPIT_LONG_CONTEXT_MULTIPLIERS.output,
          cache: standard.cache * COCKPIT_LONG_CONTEXT_MULTIPLIERS.cache,
        }
        : undefined,
      priority: scale(standard, COCKPIT_SERVICE_TIER_MULTIPLIERS.priority),
      sessionLongContext: entry.sessionLongContext,
      origin: 'book',
    }
  }
  return result
}

/** 用户在 cockpit 里手动配的覆盖价 → 三档价目。
 *  cockpit 落盘的覆盖价带**显式**长文本/优先档价(实测本机 2 条都有),优先用显式值;
 *  缺省项回退由标准档按 cockpit 规则派生,不把"没配"当成 0。 */
export function cockpitLocalPriceSets(
  pricings: CockpitLocalPricingInput[] | undefined,
): Record<string, CockpitModelPriceSet> {
  const result: Record<string, CockpitModelPriceSet> = {}
  if (!pricings) return result
  const book = COCKPIT_PRICE_BOOK
  for (const p of pricings) {
    const key = normalizeCockpitModelKey(p.modelId)
    const base = book[key]
    const fallbackStd = base
      ? perToken(base.standard.inputUsdPerMillion, base.standard.outputUsdPerMillion, base.standard.cachedInputUsdPerMillion)
      : { input: 0, output: 0, cache: 0 }
    const num = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v / PER_MILLION : d)
    const standard: CockpitTierPrice = {
      input: num(p.inputUsdPerMillion, fallbackStd.input),
      output: num(p.outputUsdPerMillion, fallbackStd.output),
      cache: num(p.cachedInputUsdPerMillion, fallbackStd.cache),
    }
    // 长文本开关:显式阈值优先,否则沿用内置价目表标记
    const threshold = p.longContextThresholdTokens
    const sessionLongContext = typeof threshold === 'number'
      ? threshold > 0
      : (base?.sessionLongContext ?? false)
    const long: CockpitTierPrice | undefined = sessionLongContext
      ? {
        input: num(p.standardLongInputUsdPerMillion, standard.input * COCKPIT_LONG_CONTEXT_MULTIPLIERS.input),
        output: num(p.standardLongOutputUsdPerMillion, standard.output * COCKPIT_LONG_CONTEXT_MULTIPLIERS.output),
        cache: num(p.standardLongCachedInputUsdPerMillion, standard.cache * COCKPIT_LONG_CONTEXT_MULTIPLIERS.cache),
      }
      : undefined
    const hasPriority = p.priorityInputUsdPerMillion != null
      || p.priorityOutputUsdPerMillion != null
      || p.priorityCachedInputUsdPerMillion != null
    result[key] = {
      standard,
      long,
      priority: hasPriority
        ? {
          input: num(p.priorityInputUsdPerMillion, standard.input * COCKPIT_SERVICE_TIER_MULTIPLIERS.priority),
          output: num(p.priorityOutputUsdPerMillion, standard.output * COCKPIT_SERVICE_TIER_MULTIPLIERS.priority),
          cache: num(p.priorityCachedInputUsdPerMillion, standard.cache * COCKPIT_SERVICE_TIER_MULTIPLIERS.priority),
        }
        : scale(standard, COCKPIT_SERVICE_TIER_MULTIPLIERS.priority),
      sessionLongContext,
      origin: 'local',
    }
  }
  return result
}

/** 有效价目 = 内置价目表 + 用户本地覆盖(本地优先,逐模型整体覆盖)。 */
export function cockpitEffectivePriceSets(
  pricings: CockpitLocalPricingInput[] | undefined,
): Record<string, CockpitModelPriceSet> {
  return { ...cockpitBookPriceSets(), ...cockpitLocalPriceSets(pricings) }
}

/**
 * 有效价目 → **定价目录行**(USD / 百万 token)。
 *
 * 为什么必须有它:`codex_local_access.json.modelPricings` 只写**用户手动改过**的价目
 * (本机实测仅 2 条),内置价目表编译在 cockpit 二进制里、不落盘。定价目录若直接读
 * modelPricings,面板就只剩 2 个模型,其余主力模型(gpt-6-astra 等)在目录里凭空消失。
 * 成本计算早已走 `cockpitEffectivePriceSets`,目录展示必须同口径。
 */
export function cockpitEffectiveModelPricings(
  pricings: CockpitLocalPricingInput[] | undefined,
): Array<CockpitModelPricing & { origin: 'local' | 'book' }> {
  const rows = new Map<string, CockpitModelPricing & { origin: 'local' | 'book' }>()
  for (const [modelId, set] of Object.entries(cockpitBookPriceSets())) {
    rows.set(modelId, {
      modelId,
      longContextThresholdTokens: set.sessionLongContext ? COCKPIT_LONG_CONTEXT_THRESHOLD_TOKENS : undefined,
      inputUsdPerMillion: set.standard.input * PER_MILLION,
      outputUsdPerMillion: set.standard.output * PER_MILLION,
      cachedInputUsdPerMillion: set.standard.cache * PER_MILLION,
      standardLongInputUsdPerMillion: set.long ? set.long.input * PER_MILLION : undefined,
      standardLongOutputUsdPerMillion: set.long ? set.long.output * PER_MILLION : undefined,
      priorityInputUsdPerMillion: set.priority ? set.priority.input * PER_MILLION : undefined,
      priorityOutputUsdPerMillion: set.priority ? set.priority.output * PER_MILLION : undefined,
      origin: 'book',
    })
  }
  // 用户手动覆盖:逐模型整体覆盖(与 cockpitEffectivePriceSets 同规则),并补目录里没有的新模型
  const localSets = cockpitLocalPriceSets(pricings)
  for (const p of pricings ?? []) {
    const key = normalizeCockpitModelKey(p.modelId)
    const set = localSets[key]
    const merged: CockpitModelPricing & { origin: 'local' | 'book' } = {
      ...(rows.get(key) ?? { modelId: key }),
      ...p,
      modelId: key,
      longContextThresholdTokens: p.longContextThresholdTokens ?? (set?.sessionLongContext ? COCKPIT_LONG_CONTEXT_THRESHOLD_TOKENS : undefined),
      standardLongInputUsdPerMillion: p.standardLongInputUsdPerMillion ?? (set?.long ? set.long.input * PER_MILLION : undefined),
      standardLongOutputUsdPerMillion: p.standardLongOutputUsdPerMillion ?? (set?.long ? set.long.output * PER_MILLION : undefined),
      origin: 'local',
    }
    rows.set(key, merged)
  }
  return [...rows.values()].sort((a, b) => a.modelId.localeCompare(b.modelId))
}

/** 取某模型在给定档位下的单价。无该模型价目时返 null(调用方回退数据源估算)。 */
export function cockpitPriceSetFor(
  sets: Record<string, CockpitModelPriceSet> | undefined,
  modelId: string,
): CockpitModelPriceSet | undefined {
  if (!sets || !modelId) return undefined
  // 先精确匹配,再归一化匹配(cockpit 日志里的模型名与价目表 key 大小写/前后缀可能不同)
  return sets[modelId] ?? sets[normalizeCockpitModelKey(modelId)]
}
