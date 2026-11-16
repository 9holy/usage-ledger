import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { connectionScopeKey } from './connectionScope'
import { announcementsAPI } from '@/api'
import type { UserAnnouncement } from '@/types'

const THROTTLE_MS = 20 * 60 * 1000 // 20 minutes

export const useAnnouncementStore = defineStore('announcements', () => {
  // State
  const announcements = ref<UserAnnouncement[]>([])
  const loading = ref(false)
  const lastFetchTime = ref(0)
  const popupQueue = ref<UserAnnouncement[]>([])
  const currentPopup = ref<UserAnnouncement | null>(null)

  // Session-scoped dedup set — not reactive, used as plain lookup only
  let shownPopupIds = new Set<number>()
  let generation = 0
  let popupTimer:ReturnType<typeof setTimeout>|null=null

  // Getters
  const unreadCount = computed(() =>
    announcements.value.filter((a) => !a.read_at).length
  )

  // Actions
  async function fetchAnnouncements(force = false) {
    const now = Date.now()
    if (!force && lastFetchTime.value > 0 && now - lastFetchTime.value < THROTTLE_MS) {
      return
    }

    // Set immediately to prevent concurrent duplicate requests
    lastFetchTime.value = now
    const requestedGeneration = ++generation

    try {
      loading.value = true
      const all = await announcementsAPI.list(false)
      if (requestedGeneration !== generation) return
      announcements.value = all.slice(0, 20)
      enqueueNewPopups()
    } catch (err: any) {
      if (requestedGeneration !== generation) return
      // Revert throttle timestamp on failure so retry is allowed
      lastFetchTime.value = 0
      console.error('Failed to fetch announcements:', err)
    } finally {
      if (requestedGeneration === generation) loading.value = false
    }
  }

  function enqueueNewPopups() {
    const newPopups = announcements.value.filter(
      (a) => a.notify_mode === 'popup' && !a.read_at && !shownPopupIds.has(a.id)
    )
    if (newPopups.length === 0) return

    for (const p of newPopups) {
      if (!popupQueue.value.some((q) => q.id === p.id)) {
        popupQueue.value.push(p)
      }
    }

    if (!currentPopup.value) {
      showNextPopup()
    }
  }

  function showNextPopup() {
    if (popupQueue.value.length === 0) {
      currentPopup.value = null
      return
    }
    currentPopup.value = popupQueue.value.shift()!
    shownPopupIds.add(currentPopup.value.id)
  }

  async function dismissPopup() {
    if (!currentPopup.value) return
    const id = currentPopup.value.id
    currentPopup.value = null

    // Mark as read (fire-and-forget, UI already updated)
    markAsRead(id)

    // Show next popup after a short delay
    if (popupQueue.value.length > 0) {
      popupTimer = setTimeout(() => { popupTimer = null; showNextPopup() }, 300)
    }
  }

  async function markAsRead(id: number) {
    const requestedGeneration = generation
    try {
      await announcementsAPI.markRead(id)
      if (requestedGeneration !== generation) return
      const ann = announcements.value.find((a) => a.id === id)
      if (ann) {
        ann.read_at = new Date().toISOString()
      }
    } catch (err: any) {
      console.error('Failed to mark announcement as read:', err)
    }
  }

  async function markAllAsRead() {
    const unread = announcements.value.filter((a) => !a.read_at)
    if (unread.length === 0) return
    const requestedGeneration = generation

    try {
      loading.value = true
      await Promise.all(unread.map((a) => announcementsAPI.markRead(a.id)))
      if (requestedGeneration !== generation) return
      announcements.value.forEach((a) => {
        if (!a.read_at) {
          a.read_at = new Date().toISOString()
        }
      })
    } catch (err: any) {
      console.error('Failed to mark all as read:', err)
      throw err
    } finally {
      if (requestedGeneration === generation) loading.value = false
    }
  }

  function reset() {
    generation++
    if(popupTimer){clearTimeout(popupTimer);popupTimer=null}
    announcements.value = []
    lastFetchTime.value = 0
    shownPopupIds = new Set()
    popupQueue.value = []
    currentPopup.value = null
    loading.value = false
  }

  watch(connectionScopeKey, reset, { flush: 'sync' })

  return {
    // State
    announcements,
    loading,
    currentPopup,
    // Getters
    unreadCount,
    // Actions
    fetchAnnouncements,
    dismissPopup,
    markAsRead,
    markAllAsRead,
    reset,
  }
})
