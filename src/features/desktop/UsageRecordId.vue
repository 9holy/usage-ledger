<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { Copy, Check } from '@lucide/vue'

const { t } = useI18n()
const props = defineProps<{ label: string; value: string }>()
const copied = ref(false)
const error = ref(false)
async function copy() {
  copied.value = false
  error.value = false
  try { await navigator.clipboard.writeText(props.value); copied.value = true }
  catch { error.value = true }
}
</script>

<template>
  <div class="record-id">
    <span>{{ label }}</span><code>{{ value }}</code>
    <button type="button" :title="copied ? t('usageMonitor.text.copied') : t('usageMonitor.text.copy') + label" :aria-label="t('usageMonitor.text.copy') + label" @click="copy"><Check v-if="copied" :size="16" /><Copy v-else :size="16" /></button>
    <small role="status">{{ error ? t('usageMonitor.text.copyFailedSelectTheTextToCopy') : copied ? t('usageMonitor.text.copied') : '' }}</small>
  </div>
</template>

<style scoped>
.record-id{display:grid;grid-template-columns:90px minmax(0,1fr) 32px;gap:6px 12px;align-items:center;padding:8px 0;font-size:12px}.record-id>span{color:var(--cost-muted)}code{font-size:12px;overflow-wrap:anywhere;user-select:text}button{width:32px;height:32px;display:grid;place-items:center;border:1px solid var(--cost-line);border-radius:4px;color:var(--cost-blue)}button:hover{background:var(--cost-panel-2)}button:focus-visible{outline:2px solid var(--cost-lime);outline-offset:2px}small{grid-column:2/-1;color:var(--cost-blue);font-size:11px}small:empty{display:none}
</style>
