/**
 * 本地持久成本账本客户端（`src-tauri/src/ledger_db.rs` + `ledger_ingest.rs`）。
 *
 * ## 为什么必须有这一层（2026-09-12）
 *
 * 二期 Rust 已经把账本多源化（schema v8–v12）、摄取管线、幂等水位全部写好，但
 * **前端零调用** —— `ledger_ingest` 注册在 `main.rs` 里却没有任何一处 invoke，
 * 结果 `cost_ledger.sqlite` **从未落盘**，整套账本只是"有单测的库"。
 * 本文件就是那缺失的最后一公里。
 *
 * ## 账本要解决的真问题
 *
 * cockpit 的 `codex_local_access_logs.sqlite` 会被 cockpit 自己轮转/重建，
 * `codex-api.log` 只保留约 5 天。**不落一份自己的持久账本，历史就随 cockpit 一起消失**——
 * 这正是用户反复说的"数据不要又丢了"。
 *
 * ## 多源（2026-09-12 起）
 *
 * 一轮摄取现在会**顺序遍历全部已知源**：
 * - `codex_logs`：`codex_local_access_logs.sqlite` / `request_logs`（毫秒时间戳、有账号与成本）；
 * - `codex_sessions`：`codex_session_usage.sqlite` / `session_usage_events`
 *   （**秒**时间戳、`rowid` 水位、只有恒为 `__default__` 的实例、无成本字段），
 *   它带来 3~7 月单请求库没有的约 4.3 万行历史。
 *
 * 两源 `request_id` 格式不同、实测 JOIN 交集 = 0，因此**账本只做"源级隔离"，
 * 绝不在摄取层合并**（架构共享知识第 17 条）。合并口径由读取层 `mergePolicy` 决定，
 * 且必须等对账视图（P0-25）出证据后由用户拍板（P0-15 被 P0-25 阻塞）。
 *
 * ## 边界（红线）
 *
 * - 账本**只存量不存钱**：`estimated_cost_usd` 是原样搬运值，**绝不参与计价**；
 *   计价唯一入口仍是前端 `cockpitSplitCostUsd()` × `cockpitPriceBook.ts`。
 * - 源库不可用**不是错误**：返回 `sourceAvailable:false + reason`，由 UI 如实标注（B5）。
 * - **逐源上报**：绝不把两源合并成一个"成功"，否则又会退回"某源静默为零"的老问题。
 * - 非桌面运行时（web/dev）直接返回 null，不抛错。
 */

import { invoke } from '@tauri-apps/api/core'
import { errMsg } from '@/stores/connection'
import { isDesktopRuntime as detectDesktop } from '@/api/url'
import i18n from '@/i18n'

const t = i18n.global.t

const NOT_DESKTOP_MSG = '账本需要桌面运行时（Tauri）'

/** 单个源的摄取结果（Rust `SourceIngestOutcome`，camelCase）。 */
export interface LedgerSourceOutcome {
  /** 源标识：`codex_logs` / `codex_sessions`（源定位失败时为空串）。 */
  sourceName: string
  /** 人类可读源名（中文，可直接显示）。 */
  label: string
  /** 该源本轮流程是否正常结束。 */
  ok: boolean
  /** 让路（已有摄取在跑）。 */
  skipped: boolean
  /** 源库是否可用。false 时 `reason` 必有值。 */
  sourceAvailable: boolean
  reason: string | null
  /** 本批扫描到的源行数（含重叠窗口）。 */
  scannedRows: number
  upsertedBuckets: number
  newIdentityRows: number
  /** 摄取后该源的水位。 */
  lastId: number
  rescanTriggered: boolean
  /** 源库被重建（cockpit 清库/换机）→ 已自动全量重扫。 */
  sourceResetDetected: boolean
  sourceGeneration: number
  durationMs: number
}

/** `ledger_ingest` 的返回（Rust `IngestAllResult`，camelCase）。 */
export interface LedgerIngestResult {
  /** 所有源都正常结束（`skipped` 与"源不可用"都算正常，后者是 B5 语义）。 */
  ok: boolean
  /** 逐源明细，顺序 = Rust `IngestSource::all_known()`（codex_logs → codex_sessions）。 */
  sources: LedgerSourceOutcome[]
  totalScannedRows: number
  totalUpsertedBuckets: number
  /** 本轮总耗时（含全部源）。 */
  durationMs: number
}

/**
 * 触发一次账本摄取（增量，覆盖全部已知源）。
 *
 * 幂等：管线按 `(source_name, hour_bucket, instance)` 记水位，同一批数据重复摄取不产生新行。
 * 并发安全：Rust 侧 `INGEST_LOCK` 用 `try_lock`，**整轮**只持一次锁，竞争失败返全部 `skipped`。
 *
 * @param fullRescan 强制全量重扫（源库被重建或用户手动触发时用）
 * @param overlapRows 重叠行数，默认由 Rust 侧 `OVERLAP_ROWS` 决定
 */
export async function ledgerIngest(
  fullRescan = false,
  overlapRows?: number,
): Promise<LedgerIngestResult | null> {
  if (!detectDesktop()) {
    console.warn(`[ledger] ${NOT_DESKTOP_MSG}`)
    return null
  }
  try {
    return await invoke<LedgerIngestResult>('ledger_ingest', {
      fullRescan,
      overlapRows: overlapRows ?? null,
    })
  } catch (e) {
    // 摄取失败不阻塞首屏：如实记录，由调用方决定是否提示
    console.warn('[ledger] 摄取失败:', errMsg(e, '未知错误'))
    return null
  }
}

/** 某个源是否"如实拿到了数据"（可用且非让路）。 */
export function ledgerSourceDelivered(source: LedgerSourceOutcome): boolean {
  return source.ok && !source.skipped && source.sourceAvailable
}

/** 源的可读名字（定位失败时退回 sourceName，再退回"未知源"）。 */
export function ledgerSourceLabel(source: LedgerSourceOutcome): string {
  return source.label || source.sourceName || t('costCenter.api.unknownSource')
}

/** 单个源的一句话摘要。 */
export function describeLedgerSource(source: LedgerSourceOutcome): string {
  const name = ledgerSourceLabel(source)
  if (source.skipped) return t('costCenter.api.ingestSkipped', { name })
  if (!source.sourceAvailable) return t('costCenter.api.ingestUnavailable', { name, reason: source.reason ?? t('costCenter.api.sourceDatabaseUnavailable') })
  if (!source.ok) return t('costCenter.api.ingestFailed', { name, reason: source.reason ?? t('costCenter.text.unknownError') })
  const reset = source.sourceResetDetected ? t('costCenter.api.sourceReset', { generation: source.sourceGeneration }) : ''
  return t('costCenter.api.ingestSource', { name, scanned: source.scannedRows, updated: source.upsertedBuckets, watermark: source.lastId, reset })
}

/**
 * 把摄取结果转成一句人话（状态卡/日志用）。与 Rust `describe_all()` 同语义。
 *
 * 多源时**逐源一行**——绝不把两源合并成一个数字，否则"会话源一行都没进来"会被掩盖。
 */
export function describeLedgerIngest(result: LedgerIngestResult | null): string {
  if (!result) return t('costCenter.api.ingestNotRun')
  if (result.sources.length === 0) return t('costCenter.api.ingestNoSources')
  return result.sources.map(describeLedgerSource).join(t('costCenter.api.sourceSeparator'))
}

/** 全部源都不可用时的原因汇总（UI 一句话提示用）；只要有一个源可用就返回 null。 */
export function ledgerAllUnavailableReason(result: LedgerIngestResult | null): string | null {
  if (!result || result.sources.length === 0) return null
  if (result.sources.some((s) => s.sourceAvailable)) return null
  return result.sources.map((s) => s.reason ?? t('costCenter.api.sourceDatabaseUnavailable')).join(t('costCenter.api.sourceSeparator'))
}

/** 本次会话是否已触发过摄取（避免每次切窗口都重扫；模块级，跨组件共享）。 */
let ingestTriggered = false

/** 是否已在本会话触发过。 */
export function ledgerIngestTriggered(): boolean {
  return ingestTriggered
}

/**
 * 会话内只触发一次的后台摄取（fire-and-forget）。
 *
 * 为什么不让调用方 `await`：首次全量扫两源合计 40 万行需要数秒到数十秒，
 * 阻塞首屏渲染是不可接受的。这里只负责"开始"，结果由 `onDone` 回调上报。
 */
export function ledgerIngestOnce(
  onDone?: (result: LedgerIngestResult | null) => void,
  fullRescan = false,
): void {
  if (ingestTriggered) return
  ingestTriggered = true
  void ledgerIngest(fullRescan).then((result) => {
    onDone?.(result)
  })
}

/** 仅供测试重置模块级标记。 */
export function resetLedgerIngestTriggerForTest(): void {
  ingestTriggered = false
}
