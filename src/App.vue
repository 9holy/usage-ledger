<script setup lang="ts">
import { RouterView, useRouter, useRoute } from 'vue-router'
import { onMounted, onBeforeUnmount, watch } from 'vue'
import Toast from '@/components/common/Toast.vue'
import NavigationProgress from '@/components/common/NavigationProgress.vue'
import AdminComplianceDialog from '@/components/admin/AdminComplianceDialog.vue'
import { resolveRouteDocumentTitle } from '@/router/title'
import AnnouncementPopup from '@/components/common/AnnouncementPopup.vue'
import { useAppStore, useAuthStore, useSubscriptionStore, useAnnouncementStore, useAdminComplianceStore, useAdminSettingsStore } from '@/stores'
import { updateFavicon } from '@/utils/branding'
import { isDesktopRuntime } from '@/api/url'
import DesktopTitleBar from '@/features/desktop/DesktopTitleBar.vue'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const authStore = useAuthStore()
const subscriptionStore = useSubscriptionStore()
const announcementStore = useAnnouncementStore()
const adminComplianceStore = useAdminComplianceStore()
const adminSettingsStore = useAdminSettingsStore()
const desktopRuntime = isDesktopRuntime()
const nativeMacChrome = desktopRuntime && /Mac/i.test(navigator.platform)

function updateDocumentTitle() {
  const customMenuItems = [
    ...(appStore.cachedPublicSettings?.custom_menu_items ?? []),
    ...(authStore.isAdmin ? adminSettingsStore.customMenuItems : []),
  ]
  document.title = resolveRouteDocumentTitle(route, appStore.siteName, customMenuItems)
}

// Watch for site settings changes and update favicon/title
watch(
  () => appStore.siteLogo,
  (newLogo) => {
    if (newLogo) {
      updateFavicon(newLogo)
    }
  },
  { immediate: true }
)

watch(
  [
    () => route.fullPath,
    () => route.meta.title,
    () => route.meta.titleKey,
    () => appStore.siteName,
    () => appStore.cachedPublicSettings?.custom_menu_items,
    () => authStore.isAdmin,
    () => adminSettingsStore.customMenuItems,
  ],
  updateDocumentTitle,
  { deep: true }
)

// Watch for authentication state and manage subscription data + announcements
function onVisibilityChange() {
  if (route.path !== '/usage-monitor' && document.visibilityState === 'visible' && authStore.isAuthenticated) {
    announcementStore.fetchAnnouncements()
  }
}

function onAdminComplianceRequired(event: Event) {
  const detail = (event as CustomEvent<Record<string, string>>).detail || {}
  adminComplianceStore.requireAcknowledgement(detail)
}

watch(
  [() => authStore.isAuthenticated, () => route.path === '/usage-monitor'],
  ([isAuthenticated, localMonitor], oldValue) => {
    if (localMonitor) {
      subscriptionStore.stopPolling()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      return
    }
    if (isAuthenticated) {
      if (authStore.isAdmin) {
        adminComplianceStore.fetchStatus().catch((error) => {
          console.error('Failed to fetch admin compliance status:', error)
        })
      }

      // User logged in: preload subscriptions and start polling
      subscriptionStore.fetchActiveSubscriptions().catch((error) => {
        console.error('Failed to preload subscriptions:', error)
      })
      subscriptionStore.startPolling()

      // Announcements: new login vs page refresh restore
      if (oldValue?.[0] === false) {
        // New login: delay 3s then force fetch
        setTimeout(() => {
          if (route.path !== '/usage-monitor') announcementStore.fetchAnnouncements(true)
        }, 3000)
      } else {
        // Page refresh restore (oldValue was undefined)
        announcementStore.fetchAnnouncements()
      }

      // Register visibility change listener
      document.addEventListener('visibilitychange', onVisibilityChange)
    } else {
      // User logged out: clear data and stop polling
      subscriptionStore.clear()
      announcementStore.reset()
      adminComplianceStore.reset()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  },
  { immediate: true }
)

// Route change trigger (throttled by store)
router.afterEach(() => {
  if (route.path !== '/usage-monitor' && authStore.isAuthenticated) {
    announcementStore.fetchAnnouncements()
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('admin-compliance-required', onAdminComplianceRequired)
  document.documentElement.classList.remove('desktop-runtime', 'desktop-native-chrome')
})

async function initializeApplication() {
  if (route.path === '/usage-monitor') return
  // 连接恢复已由 router 守卫首次导航完成,这里只加载公共设置
  // 远程模式 /settings/public 可能不存在(cliproxy),失败由 appStore catch 兜底
  await appStore.fetchPublicSettings()

  // Re-resolve document title now that site settings are available
  updateDocumentTitle()
}

watch(() => route.path, (_next, previous) => {
  if (previous === '/usage-monitor') void initializeApplication()
})

onMounted(async () => {
  document.documentElement.classList.toggle('desktop-runtime', desktopRuntime)
  document.documentElement.classList.toggle('desktop-native-chrome', nativeMacChrome)
  window.addEventListener('admin-compliance-required', onAdminComplianceRequired)
  await initializeApplication()
})
</script>

<template>
  <div class="app-window" :class="{ 'app-window--desktop': desktopRuntime, 'app-window--native-chrome': nativeMacChrome }">
    <DesktopTitleBar v-if="desktopRuntime && !nativeMacChrome" />
    <div class="app-window__content">
      <NavigationProgress />
      <RouterView />
      <Toast />
      <AnnouncementPopup v-if="route.path !== '/usage-monitor'" />
      <AdminComplianceDialog v-if="route.path !== '/usage-monitor'" />
    </div>
  </div>
</template>

<style>
.app-window { min-height: 100vh; }
.app-window--desktop {
  --desktop-titlebar-height: 36px;
  display: flex;
  height: 100vh;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: #0c110d;
  border: 1px solid #2f3930;
}
.app-window--native-chrome {
  --desktop-titlebar-height: 0px;
  border: 0;
}
.app-window--desktop .app-window__content {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: auto;
}

/* Fixed descendants use the viewport instead of the flex content box. Keep
   them below the custom Tauri titlebar so every Sub2API route shares one
   desktop safe area. */
.app-window--desktop .app-window__content .sidebar {
  top: var(--desktop-titlebar-height);
}
.app-window--desktop .app-window__content .navigation-progress {
  top: var(--desktop-titlebar-height);
}
.app-window--desktop .app-window__content .min-h-screen {
  min-height: calc(100vh - var(--desktop-titlebar-height));
}
.app-window--desktop .app-window__content .h-screen {
  height: calc(100vh - var(--desktop-titlebar-height));
}

/* Teleported dialogs live under <body>, outside .app-window__content. They
   still belong to the application layer and must not cover the native window
   controls or drag region. */
:root.desktop-runtime {
  --desktop-titlebar-height: 36px;
}
:root.desktop-runtime.desktop-native-chrome {
  --desktop-titlebar-height: 0px;
}
:root.desktop-runtime body :is(.fixed.inset-0, .modal-overlay) {
  top: var(--desktop-titlebar-height);
}
</style>
