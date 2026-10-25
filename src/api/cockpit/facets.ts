/**
 * `request_logs` 未读维度汇总客户端（PRD 缺口 ③）。
 *
 * ## 为什么需要它（2026-09-12）
 *
 * 审计发现 `request_logs` 28 列里只有 12 列被读（`cockpit_logs_db.rs` 的 SELECT 列表）。
 * 剩下 16 列**有量未读**，其中三处直接导致口径缺失：
 *
 * 1. **失败原因只暴露 3 类**：`TokenSplit` 只单独计数 `rate_limited` / `upstream_error` /
 *    `client_canceled`，而库里实际有 **12 类**。`request_failed`（本机 4,212 条）只能落进
 *    "其他 error"，在 UI 上彻底看不见。
 * 2. **三档单价快照从未被读**：`input/output/cached_input_usd_per_million` 是 cockpit
 *    当时**实际使用**的单价，100% 有值。它不参与我们的计价（红线：计价唯一入口是前端），
 *    但它是**唯一能独立校验我们价目表对不对**的基准 —— 此前完全没有交叉校验。
 * 3. **推理 token 不可见**：`reasoning_tokens` 13 万行有量。
 *
 * 另有 `reasoning_effort`（55.4%）、`gateway_mode`（sidecar/legacy）两个纯诊断维度。
 *
 * ## 已经查清的结论（别再重复怀疑）
 *
 * - **`cache_write_tokens` 不需要单独计价**。它是 `input` 的子集
 *   （`input = uncached + cache_read + cache_write`），且按 **input 单价 ×1.0** 计。
 *   我们的 `normal = input − cached` 恰好把它按同一单价算进去 ——
 *   2026-09-12 用真实库 **151,521 行** cost>0 记录逐行验证：**零偏差**。
 * - **`reasoning_tokens` 是 `output_tokens` 的子集**，不是额外量
 *   （`total_tokens == input + output` 恒成立），已含在 output 单价里，不需重复计价。
 *
 * 所以本模块**只做可见性与对账，不做任何计价**。
 *
 * ## 边界
 *
 * - 旧版 cockpit 缺列时，Rust 侧把列名列入 `missingColumns`，对应 map 为空。
 *   **前端必须显示"该版本 cockpit 不提供"，绝不显示 0。**
 * - 非桌面运行时 / 库缺失返 null，不抛错。
 */

import { invoke } from '@tauri-apps/api/core'
import { errMsg } from '@/stores/connection'
import { isDesktopRuntime as detectDesktop } from '@/api/url'
import i18n from '@/i18n'

const t = i18n.global.t

/** 一组单价快照（cockpit 当时实际使用的三档单价）。 */
export interface CockpitPriceVariant {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion: number
  /** 使用该组单价的请求数 */
  rows: number
  /**
   * 该组里**长上下文**请求数（`input_tokens > 272_000`）。
   *
   * ⚠️ 为什么必须有它：同一模型在同一窗口**天然有两组单价** —— 标准档 + 长文本档
   * （实测 gpt-5.6-sol 5/0.5/30 与 10/1/45 各一组）。只看"有两组"会把
   * **正常的长文本档**误报成"窗口内调价"。用它把两组归位。
   */
  longContextRows: number
  /** 该组里**标准档**请求数（`input_tokens <= 272_000`） */
  standardRows: number
  /** 该组单价下 cockpit 自己算出的成本合计（原样搬运，供对账）。
   *  `null` = 旧版 cockpit 没有 `estimated_cost_usd` 列 ⇒ **成本未知**，
   *  绝不是「该组成本为 0」（见文件头「假零」说明）。 */
  estimatedCostUsd: number | null
  /** 该组对应的价目版本号集合 */
  pricingVersions: number[]
}

/** 按模型的单价快照汇总。 */
export interface CockpitModelPriceSnapshot {
  model: string
  rows: number
  /**
   * ⚠️ 下面 5 个数字全部来自 `request_logs` 的**可选列**，Rust 侧用 `expr_or(col, "0")` 兜底
   * ⇒ 旧版 cockpit 缺列时会**静默出全 0**（假零）。Rust 已把缺失列名如实报进
   * `missingColumns`，但**此前前端没有任何消费点** —— 这份 payload 是「沉默的 0」。
   *
   * 判定收在 `nullifyMissingFacetNumbers`（本模块解析边界）：缺列 ⇒ 置 `null`，
   * 下游（含未来新增的显示点）拿到的就是「未知」而不是 0。类型放宽成 `number | null`
   * 是为了让 `vue-tsc` **强制**每个新消费点处理空值，而不是靠人记得加守卫。
   */
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  reasoningTokens: number | null
  estimatedCostUsd: number | null
  /** 该模型出现过的不同单价组合，按行数降序。>1 表示窗口内调过价。 */
  variants: CockpitPriceVariant[]
}

/** `cockpit_request_log_facets` 的返回（Rust `RequestLogFacets`，camelCase）。 */
export interface CockpitRequestLogFacets {
  available: boolean
  reason: string | null
  rowCount: number
  successRows: number
  failedRows: number
  /** 失败但 `errorCategory` 为空的请求数（单列，不与成功混淆） */
  failedWithoutCategory: number
  /** 失败原因**全量**分类（此前只暴露 3 类） */
  errorCategories: Record<string, number>
  /** 推理 token 合计。⚠️ 是 `outputTokens` 的**子集**，不参与计价。 */
  reasoningTokens: number
  reasoningRows: number
  reasoningEfforts: Record<string, number>
  gatewayModes: Record<string, number>
  requestKinds: Record<string, number>
  priceSnapshots: CockpitModelPriceSnapshot[]
  presentColumns: string[]
  /** 缺失的可选列；非空即表示对应维度"该版本 cockpit 不提供" */
  missingColumns: string[]
}

/**
 * 读 `request_logs` 的未读维度汇总。
 *
 * 窗口级小结果（几十行），与 `getCockpitRequestLogSummary` 的 17.9 万行扫描相互独立，
 * 可单独调用、单独失败。
 */
export async function getRequestLogFacets(
  startMs?: number | null,
  endMs?: number | null,
): Promise<CockpitRequestLogFacets | null> {
  if (!detectDesktop()) return null
  try {
    const raw = await invoke<string>('cockpit_request_log_facets', {
      startMs: startMs ?? null,
      endMs: endMs ?? null,
    })
    const parsed = JSON.parse(raw) as CockpitRequestLogFacets
    if (!parsed || typeof parsed.available !== 'boolean') return null
    // ★ 必须在**解析边界**把缺列的假 0 抹成 null,而不是留给各个显示点 ——
    //   「假零在源头产生就在源头修,不要在显示点各打补丁」(见 `nullifyMissingFacetNumbers`)。
    return nullifyMissingFacetNumbers(parsed)
  } catch (e) {
    console.warn('[cockpit] 用量维度汇总失败:', errMsg(e, '读取失败'))
    return null
  }
}

/**
 * 把「因旧版 cockpit 缺列而由 `expr_or(col, "0")` 兜底出来的 0」改成 `null`。
 *
 * ## 为什么必须在解析边界做
 *
 * Rust 侧对这 4 列用的是 `expr_or(&columns, "input_tokens", "0")` —— 缺列时**不报错**，
 * 直接给 0。Rust 已经把缺失列名报进 `missingColumns`，但那是**事实**，不是判定；
 * 真正「这些数字是未知而不是 0」的结论必须有且只有一处，就是这里。
 *
 * 此前这份 payload 的 5 个数字**没有任何前端消费点**，因此没有可见的假零 ——
 * 但那正是最危险的形态：下一个加显示点的人会直接拿到一串 0，且 `vue-tsc` 不会拦。
 * 现在类型放宽为 `number | null`，新消费点若忘了处理空值，**编译期就会报错**。
 *
 * ## 边界
 *
 * - 只处理 `priceSnapshots`（含其 `variants`）里的 token/成本数字。
 * - 顶层 `facets.reasoningTokens` **不在这里处理**：它有独立的视图级守卫
 *   （`CostCenterView.reasoningTokensUnavailable`，由 `uiShellContract.spec.ts` 钉住），
 *   在这里再抹一次会让那条守卫变成「没人测得到的第二入口」。
 * - 无缺列时**原样返回同一个对象**（不复制），避免每次调用都重建大数组。
 */
export function nullifyMissingFacetNumbers(facets: CockpitRequestLogFacets): CockpitRequestLogFacets {
  const miss = (column: string) => facetDimensionUnavailable(facets, column)
  const noInput = miss('input_tokens')
  const noOutput = miss('output_tokens')
  const noCached = miss('cached_tokens')
  const noReasoning = miss('reasoning_tokens')
  const noCost = miss('estimated_cost_usd')
  if (!noInput && !noOutput && !noCached && !noReasoning && !noCost) return facets

  return {
    ...facets,
    priceSnapshots: (facets.priceSnapshots ?? []).map((s) => ({
      ...s,
      inputTokens: noInput ? null : s.inputTokens,
      outputTokens: noOutput ? null : s.outputTokens,
      cachedTokens: noCached ? null : s.cachedTokens,
      reasoningTokens: noReasoning ? null : s.reasoningTokens,
      estimatedCostUsd: noCost ? null : s.estimatedCostUsd,
      // 每档位的成本合计同样来自 `estimated_cost_usd` 列
      variants: (s.variants ?? []).map((v) => ({
        ...v,
        estimatedCostUsd: noCost ? null : v.estimatedCostUsd,
      })),
    })),
  }
}

/** 某维度是否因**旧版 cockpit 缺列**而不可得。 */
export function facetDimensionUnavailable(
  facets: CockpitRequestLogFacets | null,
  column: string,
): boolean {
  if (!facets) return true
  return facets.missingColumns.some((c) => c.toLowerCase() === column.toLowerCase())
}

/** 中文标签：失败原因（12 类全覆盖；未知分类原样返回，不吞掉）。 */
export const ERROR_CATEGORY_LABELS: Record<string, string> = {
  get upstream_error() { return t('costCenter.api.upstreamError') },
  get request_failed() { return t('costCenter.api.requestFailed') },
  get client_canceled() { return t('costCenter.api.clientCanceled') },
  get quota_or_rate_limit() { return t('costCenter.api.quotaOrRateLimit') },
  get auth_failed() { return t('costCenter.api.authFailed') },
  get stream_incomplete() { return t('costCenter.api.streamIncomplete') },
  get model_not_available() { return t('costCenter.api.modelUnavailable') },
  get upstream_first_byte_timeout() { return t('costCenter.api.firstByteTimeout') },
  get account_prepare_failed() { return t('costCenter.api.accountPrepareFailed') },
  get cooldown() { return t('costCenter.api.cooldown') },
  get auth_refresh_failed() { return t('costCenter.api.authRefreshFailed') },
}

/** 中文标签：推理档位。 */
export const REASONING_EFFORT_LABELS: Record<string, string> = {
  get low() { return t('costCenter.api.low') },
  get medium() { return t('costCenter.api.medium') },
  get high() { return t('costCenter.api.high') },
  get xhigh() { return t('costCenter.api.xhigh') },
  get max() { return t('costCenter.api.max') },
}

/** 中文标签：网关模式。 */
export const GATEWAY_MODE_LABELS: Record<string, string> = {
  get sidecar() { return t('costCenter.api.sidecar') },
  get legacy() { return t('costCenter.api.legacy') },
}

/**
 * 中文标签：请求类型。
 *
 * 只收录**本仓有据可查**的取值 —— Rust 侧文档注释 `request_kind` 分布
 * (text / image_generation / image_edit …，cockpit_logs_db.rs:553)
 * 与夹具 schema 默认值（'text' / 'other'，cockpit_logs_db.rs:1207 / :856）。
 * 其余取值一律原样返回（见 `requestKindLabel`）—— 猜一个中文名比不翻译更糟。
 */
export const REQUEST_KIND_LABELS: Record<string, string> = {
  get text() { return t('costCenter.api.text') },
  get image_generation() { return t('costCenter.api.imageGeneration') },
  get image_edit() { return t('costCenter.api.imageEdit') },
  get other() { return t('costCenter.api.other') },
}

export function errorCategoryLabel(key: string): string {
  return ERROR_CATEGORY_LABELS[key] ?? key
}

export function reasoningEffortLabel(key: string): string {
  return REASONING_EFFORT_LABELS[key] ?? key
}

export function gatewayModeLabel(key: string): string {
  return GATEWAY_MODE_LABELS[key] ?? key
}

export function requestKindLabel(key: string): string {
  return REQUEST_KIND_LABELS[key] ?? key
}

/** 分布表的一行（按数量降序）。 */
export interface FacetDistributionRow {
  key: string
  label: string
  count: number
  /** 占比（0..1）。总数为 0 时为 null（不是 0 —— 0 会被读成"占 0%"）。 */
  share: number | null
}

function toRows(
  map: Record<string, number> | undefined,
  label: (key: string) => string,
): FacetDistributionRow[] {
  const entries = Object.entries(map ?? {})
  const total = entries.reduce((n, [, v]) => n + (Number.isFinite(v) ? v : 0), 0)
  return entries
    .map(([key, count]) => ({
      key,
      label: label(key),
      count,
      share: total > 0 ? count / total : null,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** 失败原因分布（全 12 类），按数量降序。 */
export function errorCategoryRows(facets: CockpitRequestLogFacets | null): FacetDistributionRow[] {
  return toRows(facets?.errorCategories, errorCategoryLabel)
}

/** 推理档位分布。 */
export function reasoningEffortRows(facets: CockpitRequestLogFacets | null): FacetDistributionRow[] {
  return toRows(facets?.reasoningEfforts, reasoningEffortLabel)
}

/** 网关模式分布。 */
export function gatewayModeRows(facets: CockpitRequestLogFacets | null): FacetDistributionRow[] {
  return toRows(facets?.gatewayModes, gatewayModeLabel)
}

/** 请求类型分布（text / image_generation / image_edit …）。 */
export function requestKindRows(facets: CockpitRequestLogFacets | null): FacetDistributionRow[] {
  return toRows(facets?.requestKinds, requestKindLabel)
}

/**
 * 失败分类的一句话摘要（UI 副标题用）。
 *
 * 必须把 `failedWithoutCategory` 单独说出来 —— 它不属于任何分类，
 * 合并进"其他"会让"未知失败"凭空消失。
 */
export function describeFailureBreakdown(facets: CockpitRequestLogFacets | null): string {
  if (!facets) return t('costCenter.api.failuresNotRead')
  if (!facets.available) return t('costCenter.api.failuresUnavailable', { reason: facets.reason ?? t('costCenter.api.sourceUnavailable') })
  const classified = Object.values(facets.errorCategories).reduce((n, v) => n + v, 0)
  const parts = [
    t('costCenter.api.failedCount', { count: facets.failedRows }),
    t('costCenter.api.classifiedCount', { count: classified, categories: Object.keys(facets.errorCategories).length }),
  ]
  if (facets.failedWithoutCategory > 0) {
    parts.push(t('costCenter.api.unclassifiedCount', { count: facets.failedWithoutCategory }))
  }
  return parts.join(' · ')
}
