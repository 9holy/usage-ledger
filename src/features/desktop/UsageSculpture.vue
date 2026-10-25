<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { Group } from 'three'
import { createEfficiencyStage, type SculptureKind } from './usageEfficiencyScene'
const props = defineProps<{
  kind: SculptureKind
  factory: (width: number) => Group
  signature: string
  label: string
}>()
const emit = defineEmits<{
  anchors: [points: Record<string, { x: number; y: number }>]
}>()
const host = ref<HTMLElement>(),
  error = ref('')
let stage: ReturnType<typeof createEfficiencyStage> = null,
  observer: ResizeObserver | undefined,
  width = 0
function draw() {
  if (stage && host.value) {
    width = Math.max(200, Math.round(host.value.clientWidth))
    stage.replace(props.factory(width))
    stage.resize()
    emit('anchors', stage.anchors())
  }
}
function resize() {
  if (!host.value?.clientWidth) return
  if (!stage) {
    stage = createEfficiencyStage(host.value, props.kind, (message) => (error.value = message))
    draw()
  } else if (Math.max(200, Math.round(host.value.clientWidth)) !== width) draw()
  else {
    stage.resize()
    emit('anchors', stage.anchors())
  }
}
// Snapshot refreshes with unchanged values should not rebuild GPU resources.
watch(() => props.signature, draw)
onMounted(() => {
  resize()
  observer = new ResizeObserver(resize)
  if (host.value) observer.observe(host.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  stage?.dispose()
})
defineExpose({ focus: (name: string | null) => stage?.focus(name) })
</script>
<template>
  <div class="sculpture-wrap" role="img" :aria-label="label" :title="label">
    <div ref="host" class="sculpture-host" />
    <p v-if="error" role="status">{{ error }}</p>
  </div>
</template>
<style scoped>
.sculpture-wrap {
  position: relative;
  width: 100%;
  min-width: 0;
  aspect-ratio: 2.1;
}
.sculpture-host {
  position: absolute;
  inset: 0;
}
.sculpture-host :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}
.sculpture-wrap p {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 12px;
  color: #e4b977;
  background: #101c16dd;
  padding: 8px;
}
</style>
