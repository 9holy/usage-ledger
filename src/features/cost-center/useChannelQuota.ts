import { costDataText } from './costDataText'
/**
 * 渠道配额视图数据层（PRD P0-21 / P1-12）。
 *
 * 把 `cockpit_quota.rs` 的四个命令接成一份可直接渲染的状态：
 * - 默认只走**路径 B**（落盘快照，零外网请求）；
 * - "立即刷新"才触发**路径 A**，失败自动降级并回传 `liveError`；
 * - 只加载**有账号的渠道**（P1-13：空渠道不占位，不渲染 19 个空面板）。
 *
 * ★ 铁律：不在这里把 `null` 变成 `0`。`percent == null` 就是"用量不可得"，
 * 由 UI 显示"用量不可得"，绝不显示 0%（P0-21 验收⑤ / P1-12）。
 */

import { computed, ref } from 'vue'
import { errMsg } from '@/stores/connection'
import {
  getQuotaChannels,
  getQuotaSnapshots,
  refreshQuotaSnapshots,
  type QuotaChannelSummary,
  type QuotaSnapshot,
} from '@/api/cockpit/quota'

export function useChannelQuota() {
  /** 全部渠道探测结果（含无账号的，供"渠道能力"展示）。 */
  const channels = ref<QuotaChannelSummary[]>([])
  /** channel → 归一化后的配额快照。 */
  const snapshotsByChannel = ref<Record<string, QuotaSnapshot[]>>({})
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)
  /** 正在走路径 A 刷新的渠道（按钮 loading 用）。 */
  const refreshingChannel = ref<string | null>(null)
  /** 最近一次实时刷新的降级原因（非空 = 已降级回落盘快照，UI 必须提示）。 */
  const liveError = ref<string | null>(null)

  /** 有账号的渠道 —— 只有这些才渲染（P1-13）。 */
  const activeChannels = computed(() => channels.value.filter((c) => c.hasAccounts))

  /** 展平的全部快照（做"不可得数量"之类的汇总用）。 */
  const allSnapshots = computed(() => Object.values(snapshotsByChannel.value).flat())

  /** 用量不可得的条数（API Key 类账号）。用于状态标注，不参与任何成本计算。 */
  const unavailableCount = computed(
    () => allSnapshots.value.filter((s) => s.unavailableReason != null || s.percent == null).length,
  )

  /** 过期条数（数据自身时间戳超 TTL）。 */
  const staleCount = computed(() => allSnapshots.value.filter((s) => s.stale).length)

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      channels.value = await getQuotaChannels()
      const withAccounts = channels.value.filter((c) => c.hasAccounts)
      // 并行读各渠道快照；单渠道失败不影响其它（Rust 侧单渠道错误已被 getQuotaSnapshots 吞成 []）
      const entries = await Promise.all(
        withAccounts.map(async (c) => [c.channel, await getQuotaSnapshots(c.channel)] as const),
      )
      const map: Record<string, QuotaSnapshot[]> = {}
      for (const [channel, snaps] of entries) map[channel] = snaps
      snapshotsByChannel.value = map
      loaded.value = true
    } catch (e) {
      error.value = errMsg(e, costDataText('failedToReadChannelQuota'))
    } finally {
      loading.value = false
    }
  }

  /** 路径 A：用户主动触发的实时刷新。失败不阻塞，只回传降级原因。 */
  async function refresh(channel: string): Promise<void> {
    refreshingChannel.value = channel
    liveError.value = null
    try {
      const result = await refreshQuotaSnapshots(channel)
      if (!result) return
      snapshotsByChannel.value = { ...snapshotsByChannel.value, [channel]: result.snapshots }
      liveError.value = result.liveError
    } finally {
      refreshingChannel.value = null
    }
  }

  return {
    channels,
    activeChannels,
    snapshotsByChannel,
    allSnapshots,
    unavailableCount,
    staleCount,
    loading,
    loaded,
    error,
    refreshingChannel,
    liveError,
    load,
    refresh,
  }
}
