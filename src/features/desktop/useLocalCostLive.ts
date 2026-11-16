import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { getLocalCostLive, type LocalCostLiveReport } from '@/api/localCost'

export function useLocalCostLive(accountKey: Ref<string>, enabled: Ref<boolean>, sourceKey?: Ref<string>) {
  const report = ref<LocalCostLiveReport | null>(null), error = ref('')
  const visible = ref(document.visibilityState === 'visible')
  let timer: ReturnType<typeof setTimeout> | undefined, generation = 0
  async function update(current: number) {
    try {
      const value = sourceKey?.value && sourceKey.value !== 'all' ? await getLocalCostLive(accountKey.value,sourceKey.value) : await getLocalCostLive(accountKey.value)
      if (current === generation) { report.value = value; error.value = '' }
    } catch (failure) { if (current === generation) error.value = String(failure instanceof Error ? failure.message : failure) }
    finally { if (current === generation) timer = setTimeout(() => void update(current), 2000) }
  }
  const changed = () => { visible.value = document.visibilityState === 'visible' }
  watch(() => [accountKey.value, sourceKey?.value, enabled.value, visible.value], () => {
    const current = ++generation
    clearTimeout(timer); report.value = null; error.value = ''
    if (enabled.value && visible.value && accountKey.value) void update(current)
  }, { immediate: true })
  onMounted(() => document.addEventListener('visibilitychange', changed))
  onBeforeUnmount(() => { generation++; clearTimeout(timer); document.removeEventListener('visibilitychange', changed) })
  return { report, error }
}
