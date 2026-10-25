<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { Clock3 } from '@lucide/vue'
import { monitorCacheCoverage, monitorCacheRatio, monitorTotalCost, type MonitorSessionDetail } from '@/api/usageMonitor'

const { t } = useI18n()

type Turn = NonNullable<MonitorSessionDetail['turns']>[number]
const props = defineProps<{ turns: Turn[]; selected: string | null; loading: boolean }>()
const emit = defineEmits<{ select: [id: string | null] }>()
const number = computed(() => new Intl.NumberFormat(usageLocale()))
const compact = computed(() => new Intl.NumberFormat(usageLocale(), { notation: 'compact', maximumFractionDigits: 2 }))
const maximum = computed(() => Math.max(1, ...props.turns.map(row => row.totals.totalTokens)))
function width(value: number): string { return `${value / maximum.value * 100}%` }
function time(row: Turn): string {
  const timestamp = row.timing?.startedAtMs ?? row.startedAtMs
  return timestamp ? new Date(timestamp).toLocaleString(usageLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : t('usageMonitor.text.timeNotRecorded')
}
function elapsed(row: Turn): string {
  const ms = row.timing?.durationMs
  if (ms == null) return t('usageMonitor.text.durationNotReported')
  return ms < 60_000 ? t('usageMonitor.text.s2', { value0: (ms / 1000).toFixed(2) }) : t('usageMonitor.text.mS', { value0: Math.floor(ms / 60_000), value1: Math.floor(ms / 1000) % 60 })
}
function usageLabel(row: Turn): string {
  return t('usageMonitor.text.inputOutputTokens', { value0: number.value.format(row.totals.inputTokens), value1: number.value.format(row.totals.outputTokens), value2: row.totals.incompleteRequests ? t('usageMonitor.text.recordedPortionOnly') : '' })
}
</script>

<template>
  <section class="turn-index timeline-panel" :aria-label="t('usageMonitor.text.conversationTurnTimeline')">
    <div class="timeline-heading"><h3>{{ t('usageMonitor.text.conversationTurns') }} <span>{{ turns.length }}</span></h3><button type="button" class="parent-link" :aria-pressed="selected === null" @click="emit('select', null)">{{ t('usageMonitor.text.allTurns') }}</button></div>
    <div class="timeline-key"><span><i class="input-key" />{{ t('usageMonitor.text.input') }}</span><span><i class="output-key" />{{ t('usageMonitor.text.output') }}</span><small>{{ t('usageMonitor.text.turnLengthsUseTheSameScale') }}</small></div>
    <div class="turn-scroll" role="region" :aria-label="t('usageMonitor.text.completeTurnIndex')" tabindex="0">
      <ol v-if="turns.length" class="turn-track">
        <li v-for="(row, index) in turns" :key="row.id" :class="{ 'is-selected': selected === row.id }">
          <button type="button" class="turn-choice" :class="{ selected: selected === row.id }" :aria-pressed="selected === row.id" :title="t('usageMonitor.text.turnIdentifier2') + (row.id || t('usageMonitor.text.unknown'))" @click="emit('select', row.id)">
            <span class="turn-caption"><strong>{{ t('usageMonitor.text.turnRecord') }} {{ turns.length - index }}</strong><small>{{ number.format(row.totals.requestCount) }} {{ t('usageMonitor.text.requests8') }}</small></span>
            <time>{{ time(row) }} <small>{{ row.timing?.startedAtMs != null ? t('usageMonitor.text.turnStart') : t('usageMonitor.text.firstUsageRecord') }}</small></time>
            <span class="turn-volume" role="img" :aria-label="usageLabel(row)" :title="usageLabel(row)"><i class="input-volume" :style="{ width: width(row.totals.inputTokens) }" /><i class="output-volume" :style="{ width: width(row.totals.outputTokens) }" /></span>
            <span class="turn-amounts"><span>{{ t('usageMonitor.text.in') }} {{ compact.format(row.totals.inputTokens) }}</span><span>{{ t('usageMonitor.text.out') }} {{ compact.format(row.totals.outputTokens) }}</span></span>
            <span v-if="row.totals.incompleteRequests" class="partial">{{ row.totals.incompleteRequests }} {{ t('usageMonitor.text.incompleteKnownUsage') }}</span>
            <span class="turn-timing"><Clock3 :size="12" />{{ elapsed(row) }}<small>{{ t('usageMonitor.text.cacheHit') }} {{ monitorCacheRatio(row.totals) }}</small></span>
            <span class="turn-cache">{{ t('usageMonitor.text.cacheRead4') }} {{ compact.format(row.totals.cacheReadTokens) }} {{ t('usageMonitor.text.write2') }} {{ compact.format(row.totals.cacheWriteTokens) }}</span>
            <small v-if="monitorCacheCoverage(row.totals)" class="turn-cache">{{ monitorCacheCoverage(row.totals) }}</small>
            <span class="turn-cost">{{ monitorTotalCost(row.totals) }}</span>
            <small class="turn-id">{{ row.id || t('usageMonitor.text.identifierNotRecorded') }}</small>
          </button>
        </li>
      </ol>
      <p v-else class="timeline-empty">{{ loading ? t('usageMonitor.text.loadingTurns') : t('usageMonitor.text.noTurnRecordsInTheSelectedRange') }}</p>
    </div>
  </section>
</template>

<style scoped>
.timeline-panel{min-width:0}.timeline-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0 14px}.timeline-heading h3{margin:0;font-size:14px;font-weight:600}.timeline-heading h3 span{color:var(--cost-muted);font-size:12px;font-weight:400;margin-left:6px}.parent-link{color:var(--cost-blue);font-size:11px;white-space:nowrap}.parent-link:hover{color:var(--cost-text)}
.timeline-key{display:flex;align-items:center;gap:12px;padding:0 0 12px;font-size:10px;color:var(--cost-muted)}.timeline-key>span{display:flex;align-items:center;gap:5px}.timeline-key i{width:8px;height:5px;border-radius:1px}.input-key{background:var(--usage-input)}.output-key{background:var(--usage-output)}.timeline-key>small{margin-left:auto;font-size:10px}
.turn-scroll{max-height:460px;overflow:auto;scrollbar-width:thin;padding-right:4px}.turn-scroll:focus-visible{outline:2px solid var(--cost-lime);outline-offset:-2px}.turn-track{list-style:none;margin:0;padding:0 0 0 11px}.turn-track>li{position:relative;border-left:1px solid var(--cost-line-strong);padding:0 0 12px 13px}.turn-track>li:last-child{border-left-color:transparent;padding-bottom:0}.turn-track>li::before{content:'';position:absolute;left:-4px;top:14px;width:7px;height:7px;border:1px solid var(--cost-blue);background:var(--cost-bg);border-radius:50%}.turn-track>li.is-selected::before{background:var(--cost-lime);border-color:var(--cost-lime)}
.turn-choice{display:flex;flex-direction:column;gap:7px;width:100%;min-width:0;padding:10px 9px;text-align:left;border:1px solid transparent;border-radius:5px;color:var(--cost-text)}.turn-choice:hover{background:var(--cost-panel)}.turn-choice.selected{background:#1b2b27;border-color:#3d655b}.turn-caption,.turn-amounts{display:flex;align-items:center;justify-content:space-between;gap:9px}.turn-caption strong{font-size:12px;font-weight:600}.turn-caption small{font-size:10px;color:var(--cost-muted)}time{font-size:11px;color:var(--cost-blue)}time>small{font-size:10px;color:var(--cost-muted);margin-left:5px}
.turn-volume{display:flex;height:7px;border-radius:2px;background:var(--cost-panel-2);overflow:hidden;width:100%;margin:3px 0}.turn-volume i{height:100%;display:block;flex-shrink:0}.input-volume{background:var(--usage-input)}.output-volume{background:var(--usage-output)}.turn-amounts{font-size:11px}.turn-amounts>span:first-child{color:var(--usage-input)}.turn-amounts>span:last-child{color:var(--usage-output)}.turn-timing{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:10px;color:var(--cost-muted)}.turn-timing svg{flex-shrink:0}.turn-timing small{font-size:10px;margin-left:auto}.turn-cache{font-size:10px;color:var(--cost-muted);line-height:1.6}.turn-cost{font-size:11px;line-height:1.6;overflow-wrap:anywhere}.turn-id{font-size:9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cost-muted)}.partial{font-size:10px;color:var(--usage-warning)}.timeline-empty{padding:24px 8px;font-size:12px;line-height:1.7;color:var(--cost-muted)}
@media(max-width:1200px){.turn-scroll{max-height:240px}}
</style>
