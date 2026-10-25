/**
 * 渠道配额「同源合并」（纯函数层，无 Vue / 无 Tauri 依赖，便于单测）。
 *
 * ## 为什么要合并（2026-09-12 现场）
 *
 * `antigravity` / `gemini` / `antigravity_ide` 三个渠道在 Rust 侧**共用同一个账号目录**：
 *
 * ```rust
 * // src-tauri/src/cockpit_quota.rs · accounts_dir_name()
 * if matches!(channel, CH_ANTIGRAVITY | CH_GEMINI | CH_ANTIGRAVITY_IDE) {
 *     "accounts".to_string()
 * } else {
 *     format!("{channel}_accounts")
 * }
 * ```
 *
 * 于是它们读的是**同一份桌面缓存**，产出的快照集合一模一样 —— 真机实测
 * 11 账号 × 20 模型 × 3 渠道 = 660 条，其中 3 份完全相同。UI 上就是 3 个
 * 内容一模一样的 chip 并排，纯噪音。
 *
 * ## 判定口径：**两步都过才合并**（宁可不合并，也不能把有差异的渠道错误合并掉）
 *
 * 1. **候选组 = 同一账号目录**（Rust `ChannelSummary.dir`，即 `accounts_dir_name()` 的结果）。
 *    共用同一份账号文件才"有可能同源"；这是三者重复的根因，也是组边界。
 *    跨目录即使快照集合相同也**不合并**。
 * 2. **组内每个成员的快照集合签名必须完全一致**（`quotaSnapshotSetSignature`）。
 *    **只要有一丁点不同，整组逐个显示** —— 不是"把相同的那两个悄悄合掉"：
 *    三者本该同源，其中一个对不上说明它们已经不是同一批数据了，
 *    这时合并剩下的两个会让用户以为有差异的那个渠道不存在。
 *
 * ## 签名怎么算（保守）
 *
 * - 签名 = `accountId|modelId|percent|updatedAtMs|source` 逐条拼串 → **排序**后 join
 *   （快照顺序不保证稳定，必须排序）。
 * - `fetchedAtMs` **不参与**签名：它是"我们读取的时刻"，每个渠道一次 invoke 都不同，
 *   放进签名会让同源三渠道永远合并不了。
 * - `null` 序列化成固定占位符 `∅`，**不是空串** —— 空串会和"另一个空字段"撞上，
 *   也会让"用量不可得（null）"与"真实 0%"混为一谈（P0-21 验收⑤红线）。
 * - 空快照集合（"无快照"）**不参与合并**：两个都没数据的渠道并不是同一批数据，
 *   合并会把各自的 `accountCount` 藏掉。
 * - `accountCount` **不相加**：它们本来就是同一批账号，相加会虚增。
 */

import type { QuotaSnapshot } from './quota'

/** 合并后 chip 的渠道名连接符（如 `antigravity / gemini / antigravity_ide`）。 */
export const QUOTA_CHANNEL_JOINER = ' / '

/** 快照字段为 null 时的序列化占位符。绝不用空串 —— 见文件头"签名怎么算"。 */
export const QUOTA_NULL_TOKEN = '∅'

/** 字段分隔符（ASCII Unit Separator）。不用 `|`：accountId 里可能自带 `|`，拼串会有歧义。 */
const FIELD_SEP = String.fromCharCode(31)

/** 条目分隔符（ASCII Record Separator，排序后 join 用）。 */
const ITEM_SEP = String.fromCharCode(30)

/** 空快照集合的哨兵签名（ASCII NUL 开头，正常签名不可能撞上）。凡是它，一律不参与合并。 */
const EMPTY_SET_SIGNATURE = `${String.fromCharCode(0)}empty-set`

/** 资产总览「渠道配额」横条里一个 chip 的展示数据。 */
export interface QuotaChannelChip {
  /** 渠道名。合并后为 `a / b / c`；单渠道仍是单个字符串，无分隔符。 */
  channel: string
  /** 该渠道的账号目录（Rust `ChannelSummary.dir`）。**同源候选组的划分依据**。 */
  dir: string
  /** 该渠道的账号数。**合并时不相加**（同一批账号）。 */
  accountCount: number
  /** 剩余百分比最低的那一档（最接近真实占用）。null = 用量不可得，**绝不是 0**。 */
  worst: number | null
  /** 有快照但一条百分比都拿不到 = 该渠道账号属"用量不可得"。 */
  allUnavailable: boolean
  hasSnapshot: boolean
  /** 数据时间戳标签（来源类型 + 时间）。 */
  stamp: string | null
  /** 数据年龄（毫秒），null = 无从判断。 */
  oldestAgeMs: number | null
  /** 数据年龄文案，如 `47 天前`。 */
  ageLabel: string
  /** ≥1 天即视为"陈旧到不能代表当前用量"。 */
  ageDays: number
  /** 快照集合签名。仅用于合并判定，不参与渲染。 */
  signature: string
}

/** 单个字段的序列化：null / undefined → `∅`，其余 → 字符串。 */
function serializeField(value: string | number | null | undefined): string {
  return value == null ? QUOTA_NULL_TOKEN : String(value)
}

/**
 * 一个渠道的**快照集合签名**：快照顺序无关，只要集合内容一致就得到同一个串。
 *
 * 参与比对的字段：
 * - `accountId` —— 哪几个账号
 * - `modelId`   —— 哪个模型（空串 = 账号级配额）
 * - `percent`   —— 剩余%（**null 参与比较**，与 0 严格区分）
 * - `updatedAtMs` —— 数据本身的落盘时刻（决定"这数是不是现在"）
 * - `source`    —— 落盘快照 / 实时（决定 chip 上标的是哪个来源，混标等于骗人）
 *
 * 刻意**不包含** `fetchedAtMs`：它是"我们读取的时刻"，每个渠道一次 invoke 都不同，
 * 放进签名会让同源三渠道永远合并不了。
 */
export function quotaSnapshotSetSignature(snapshots: readonly QuotaSnapshot[]): string {
  if (!snapshots.length) return EMPTY_SET_SIGNATURE
  const items = snapshots.map((snapshot) =>
    [
      serializeField(snapshot.accountId),
      serializeField(snapshot.modelId),
      serializeField(snapshot.percent),
      serializeField(snapshot.updatedAtMs),
      serializeField(snapshot.source),
    ].join(FIELD_SEP),
  )
  // 顺序不保证稳定 → 必须排序后再 join，否则同源渠道会因顺序差异而漏合并。
  items.sort()
  return items.join(ITEM_SEP)
}

/** 该签名是否允许参与合并。空快照集合（"无快照"）一律不合并 —— 见文件头。 */
export function isMergeableQuotaSignature(signature: string): boolean {
  return signature !== EMPTY_SET_SIGNATURE
}

/**
 * 一个候选组（同一账号目录）能否整组合并。
 *
 * 条件：≥2 个成员 **且** 有快照（非空集合） **且** 组内签名两两完全一致。
 * 缺一即整组不合并 —— 保守。
 */
function canMergeCluster(members: readonly QuotaChannelChip[]): boolean {
  if (members.length < 2) return false
  const head = members[0]
  if (!isMergeableQuotaSignature(head.signature)) return false
  return members.every((member) => member.signature === head.signature)
}

/**
 * 把**同源且快照集合完全一致**的渠道合并成一个 chip。
 *
 * - 候选组 = 同一账号目录；组内签名必须**全部**一致才合并，否则整组逐个显示。
 * - 只有 1 个成员的组原样返回（`channel` 保持单个字符串，不加分隔符）。
 * - 合并组的 `channel` 用 ` / ` 连接，**保持原始顺序**；其余字段取组内第一个
 *   （判定为完全一致，取哪个都一样）；`accountCount` 取第一个而**不是求和**。
 * - 输出顺序与输入一致（合并 chip 落在组内首个成员的位置）。
 *
 * @param chips 按渠道原始顺序排列的 chip 列表。
 * @returns 合并后的 chip 列表。
 */
export function mergeIdenticalQuotaChannels(chips: readonly QuotaChannelChip[]): QuotaChannelChip[] {
  /** 账号目录 → 该组所有成员在 `chips` 里的下标（保持原始顺序）。 */
  const clusters = new Map<string, number[]>()
  chips.forEach((chip, index) => {
    const members = clusters.get(chip.dir)
    if (members) members.push(index)
    else clusters.set(chip.dir, [index])
  })

  /** 判定为"可整组合并"的账号目录。 */
  const mergedDirs = new Set<string>()
  clusters.forEach((indices, dir) => {
    if (canMergeCluster(indices.map((index) => chips[index]))) mergedDirs.add(dir)
  })

  const out: QuotaChannelChip[] = []
  const emittedDirs = new Set<string>()
  chips.forEach((chip) => {
    if (!mergedDirs.has(chip.dir)) {
      out.push(chip)
      return
    }
    // 该组已由首个成员产出合并 chip，其余成员不再单独出现。
    if (emittedDirs.has(chip.dir)) return
    emittedDirs.add(chip.dir)
    const members = (clusters.get(chip.dir) ?? []).map((index) => chips[index])
    out.push({
      ...members[0],
      channel: members.map((member) => member.channel).join(QUOTA_CHANNEL_JOINER),
    })
  })
  return out
}
