<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { monitorToken, type MonitorRequest } from '@/api/usageMonitor'
import { usageColors, usageIntensityColor } from './usageChartPalette'

const { t } = useI18n()
const props = defineProps<{ requests: MonitorRequest[]; selected: string | null }>()
const emit = defineEmits<{ select: [id: string, event: MouseEvent] }>()
const rows = computed(() => props.requests.map(row => ({ ...row, output: monitorToken(row, 'output_tokens') })))
const knownCount = computed(() => rows.value.filter(row => row.output != null).length)
const maximum = computed(() => Math.max(0, ...rows.value.map(row => row.output ?? 0)))
const peakIndex = computed(() => maximum.value > 0 ? rows.value.findIndex(row => row.output === maximum.value) : -1)
const total = computed(() => rows.value.reduce((sum, row) => sum + (row.output ?? 0), 0))
const number = (value: number) => value.toLocaleString(usageLocale())
const title = (row: typeof rows.value[number], index: number) => t('usageMonitor.text.requestOnThisPage', { value0: index + 1, value1: row.model || t('usageMonitor.text.modelNotRecorded2'), value2: row.output == null ? t('usageMonitor.text.outputNotRecorded') : number(row.output) + t('usageMonitor.text.outputTokens2'), value3: new Date(row.timestampMs).toLocaleTimeString(usageLocale(), { hour12: false }) })
</script>

<template>
  <section v-if="requests.length" class="request-pulse" :aria-label="t('usageMonitor.text.outputForEachRequestOnTheCurrentPage')">
    <header><div><h3>{{ t('usageMonitor.text.outputPerRequest') }}</h3><p>{{ t('usageMonitor.text.currentPage') }} {{ requests.length }} {{ t('usageMonitor.text.requests13') }} <template v-if="knownCount">{{ t('usageMonitor.text.recorded2') }} {{ number(total) }} {{ t('usageMonitor.text.outputTokens') }}<span v-if="knownCount < requests.length"> · {{ requests.length - knownCount }} {{ t('usageMonitor.text.requestsLackOutputRecords') }}</span></template><template v-else>{{ t('usageMonitor.text.outputCountsUnavailable') }}</template></p></div><span>{{ rows.some(row => row.output != null) ? t('usageMonitor.text.maximum') + number(maximum) + ' Token' : t('usageMonitor.text.outputNotYetRecorded') }}</span></header>
    <div class="pulse-key"><span>{{ t('usageMonitor.text.outputOnThisPage') }}</span><span>{{ t('usageMonitor.text.less') }}</span><i aria-hidden="true" /><span>{{ t('usageMonitor.text.more') }}</span></div>
    <div class="pulse-scroll" tabindex="0" role="region" :aria-label="t('usageMonitor.text.requestOutputChart')"><div class="pulse-grid" :style="{ gridTemplateColumns: `repeat(${requests.length}, minmax(16px, 1fr))` }"><button v-for="(row, index) in rows" :key="row.id" :class="{ 'is-selected': selected === row.id, unknown: row.output == null, peak: index === peakIndex }" :style="{ '--pulse-color': row.output == null ? usageColors.unknown : usageIntensityColor(row.output, maximum) }" :aria-label="title(row, index)" :aria-pressed="selected === row.id" :title="title(row, index)" @click="emit('select', row.id, $event)"><span class="pulse-column"><i v-if="row.output != null" :style="{ height: (maximum ? row.output / maximum * 100 : 0) + '%' }" /><b v-else>?</b></span><span class="pulse-dot" /><small v-if="index === 0 || index === rows.length - 1 || (index + 1) % 10 === 0">{{ index + 1 }}</small></button></div></div>
    <footer><span>{{ t('usageMonitor.text.usesTheOrderOfTheListBelowDoesNot') }}</span><span v-if="rows.some(row => row.output == null)">{{ t('usageMonitor.text.meansOutputWasNotRecordedForThatRequest') }}</span></footer>
  </section>
</template>

<style scoped>
.request-pulse{padding:18px 0 22px;border-top:1px solid var(--cost-line);border-bottom:1px solid var(--cost-line);margin-bottom:18px;min-width:0}.request-pulse header{display:flex;justify-content:space-between;align-items:flex-end;gap:15px;margin-bottom:20px}.request-pulse h3{font-size:16px;font-weight:600;margin:0}.request-pulse p{font-size:11px;color:#9fafaa;margin:6px 0 0}.request-pulse header>span{font-size:11px;color:var(--usage-output);white-space:nowrap}.pulse-scroll{overflow-x:auto;min-width:0;padding-bottom:4px}.pulse-grid{display:grid;gap:5px;min-height:152px}.pulse-grid button{position:relative;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:150px;min-width:16px;padding:0 2px;color:#95a99d}.pulse-column{display:flex;align-items:flex-end;justify-content:center;height:120px;width:100%;background:repeating-linear-gradient(to top,transparent 0px,transparent 24px,#29372e 25px)}.pulse-column i{position:relative;display:block;width:100%;max-width:38px;background:var(--pulse-color);border-radius:3px 3px 0 0}.pulse-column b{align-self:center;color:var(--usage-unknown);font-size:14px}.unknown .pulse-column{background:repeating-linear-gradient(135deg,transparent 0 6px,#a3adb816 6px 8px)}.pulse-dot{width:5px;height:5px;border-radius:50%;background:#52695a;margin:7px 0 14px}.pulse-grid button small{position:absolute;bottom:0;font-size:11px}.pulse-grid button:hover .pulse-column i{filter:brightness(1.12)}.pulse-grid button.is-selected .pulse-column{background-color:#ffffff08}.pulse-grid button.is-selected::after{content:'';position:absolute;bottom:0;width:12px;height:2px;border-radius:1px;background:#eef3f0}.pulse-grid button.is-selected i{box-shadow:inset 0 0 0 1px #fff9}.pulse-grid button.is-selected .pulse-dot{background:#eef3f0;box-shadow:0 0 0 3px #eef3f020}.pulse-grid button:focus-visible{outline:2px solid #b9e55a;outline-offset:1px}.request-pulse footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:#8fa699;font-size:10px;margin-top:10px}
.pulse-key{display:flex;align-items:center;gap:7px;margin:-7px 0 16px;font-size:11px;color:var(--cost-muted)}.pulse-key>span:first-child{margin-right:6px}.pulse-key>i{width:90px;height:5px;border-radius:2px;background:var(--usage-intensity)}.pulse-grid button.peak .pulse-column i::after{content:'';position:absolute;top:-9px;left:50%;width:5px;height:5px;background:#eef3f0;transform:translateX(-50%) rotate(45deg)}@media(max-width:700px){.pulse-key{flex-wrap:wrap}}
</style>
