<template>
  <div class="relative locale-switcher" ref="dropdownRef" @keydown.esc="handleEscape">
    <button
      ref="triggerRef"
      type="button"
      @click="toggleDropdown"
      :disabled="switching"
      :aria-expanded="isOpen"
      class="locale-trigger"
      :title="currentLocale?.name"
    >
      <span>{{ currentLocale?.name }}</span>
      <Icon
        name="chevronDown"
        size="xs"
        class="locale-chevron transition-transform duration-200"
        :class="{ 'rotate-180': isOpen }"
      />
    </button>

    <transition name="dropdown">
      <div
        v-if="isOpen"
        class="locale-menu"
      >
        <button
          v-for="locale in availableLocales"
          :key="locale.code"
          type="button"
          :disabled="switching"
          @click="selectLocale(locale.code)"
          class="locale-option"
          :class="{ 'is-selected': locale.code === currentLocaleCode }"
          :aria-pressed="locale.code === currentLocaleCode"
        >
          <span>{{ locale.name }}</span>
          <Icon v-if="locale.code === currentLocaleCode" name="check" size="sm" class="locale-check" />
        </button>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import { setLocale, availableLocales } from '@/i18n'

const { locale } = useI18n()

const isOpen = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const switching = ref(false)

const currentLocaleCode = computed(() => locale.value)
const currentLocale = computed(() => availableLocales.find((l) => l.code === locale.value))

function toggleDropdown() {
  isOpen.value = !isOpen.value
}

function handleEscape(event: KeyboardEvent) {
  if (!isOpen.value) return
  event.preventDefault()
  event.stopPropagation()
  isOpen.value = false
  triggerRef.value?.focus()
}

async function selectLocale(code: string) {
  if (switching.value || code === currentLocaleCode.value) {
    isOpen.value = false
    triggerRef.value?.focus()
    return
  }
  switching.value = true
  try {
    await setLocale(code)
    isOpen.value = false
  } finally {
    switching.value = false
    await nextTick()
    if (!isOpen.value) triggerRef.value?.focus()
  }
}

function handleClickOutside(event: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.locale-trigger,
.locale-option {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--cost-text, theme('colors.gray.700'));
  background: transparent;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
}
.locale-trigger { padding: 5px 8px; color: var(--cost-muted, theme('colors.gray.600')); }
.locale-chevron { color: currentColor; }
.locale-menu {
  position: absolute;
  right: 0;
  z-index: 50;
  min-width: 144px;
  margin-top: 4px;
  padding: 4px;
  border: 1px solid var(--cost-line-strong, theme('colors.gray.200'));
  border-radius: 4px;
  background: var(--cost-panel, #fff);
  box-shadow: 0 8px 24px #0006;
}
.locale-option { width: 100%; padding: 7px 8px; white-space: nowrap; }
.locale-trigger:hover:not(:disabled),
.locale-option:hover:not(:disabled) { background: var(--cost-panel-2, theme('colors.neutral.100')); color: var(--cost-text, theme('colors.gray.700')); }
.locale-option.is-selected,
.locale-option.is-selected:hover:not(:disabled) { background: var(--cost-panel-2, theme('colors.primary.50')); color: var(--cost-lime, theme('colors.primary.700')); }
.locale-check { margin-left: auto; color: currentColor; }
.locale-trigger:focus-visible,
.locale-option:focus-visible { outline: 2px solid var(--cost-lime, theme('colors.primary.600')); outline-offset: 2px; }
.locale-trigger:disabled,
.locale-option:disabled { opacity: .45; cursor: default; }
/* Vue requires the full ancestor selector inside :global to keep its suffix. */
:global(.dark .locale-trigger) { color: var(--cost-muted, theme('colors.neutral.300')); }
:global(.dark .locale-option) { color: var(--cost-text, theme('colors.neutral.200')); }
:global(.dark .locale-menu) { background: var(--cost-panel, theme('colors.neutral.900')); border-color: var(--cost-line-strong, theme('colors.neutral.700')); }
:global(.dark .locale-trigger:hover:not(:disabled)),
:global(.dark .locale-option:hover:not(:disabled)) { background: var(--cost-panel-2, theme('colors.neutral.800')); color: var(--cost-text, theme('colors.neutral.200')); }
:global(.dark .locale-option.is-selected),
:global(.dark .locale-option.is-selected:hover:not(:disabled)) { background: var(--cost-panel-2, theme('colors.neutral.800')); color: var(--cost-lime, theme('colors.primary.300')); }
:global(.dark .locale-trigger:focus-visible),
:global(.dark .locale-option:focus-visible) { outline-color: var(--cost-lime, theme('colors.primary.300')); }
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(-4px);
}
</style>
