import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import api from '@/api/admin/compliance'
import { setActiveConnection } from '@/api/url'
import { useAdminComplianceStore } from '../adminCompliance'
import { useAnnouncementStore } from '../announcements'
import { announcementsAPI } from '@/api'

vi.mock('@/api/admin/compliance',()=>({default:{getStatus:vi.fn(),accept:vi.fn()}}))
vi.mock('@/api',()=>({announcementsAPI:{list:vi.fn()}}))

beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();(window as unknown as Record<string,unknown>).__TAURI_INTERNALS__={};setActiveConnection(null)})
afterEach(()=>{setActiveConnection(null);delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__})
const remote=()=>setActiveConnection({id:'sub',type:'sub2api',name:'Source',baseUrl:'https://example.test',apiKey:'fixture',lastUsed:0})

it('does not request Sub2API-only status for local Cockpit or CLIProxy',async()=>{
  const store=useAdminComplianceStore()
  expect(await store.fetchStatus()).toBeNull()
  setActiveConnection({id:'cli',type:'cliproxy',name:'CLIProxy',baseUrl:'http://127.0.0.1:8317',apiKey:'fixture',lastUsed:0})
  expect(await store.fetchStatus()).toBeNull()
  expect(api.getStatus).not.toHaveBeenCalled()
  expect(store.shouldShow).toBe(false)
})

it('keeps the actual Sub2API status check enabled',async()=>{
  remote();vi.mocked(api.getStatus).mockResolvedValue({required:true} as Awaited<ReturnType<typeof api.getStatus>>)
  const store=useAdminComplianceStore();await store.fetchStatus()
  expect(api.getStatus).toHaveBeenCalledOnce();expect(store.required).toBe(true)
})

it('does not apply a late status response after changing to a local source',async()=>{
  remote();let resolve!:(value:Awaited<ReturnType<typeof api.getStatus>>)=>void
  vi.mocked(api.getStatus).mockImplementation(()=>new Promise(done=>{resolve=done}))
  const store=useAdminComplianceStore(),pending=store.fetchStatus()
  setActiveConnection(null);await store.fetchStatus()
  resolve({required:true} as Awaited<ReturnType<typeof api.getStatus>>)
  expect(await pending).toBeNull();expect(store.shouldShow).toBe(false)
})

it('discards a late announcement response after the source state is reset',async()=>{
  let resolve!:(value:Awaited<ReturnType<typeof announcementsAPI.list>>)=>void
  vi.mocked(announcementsAPI.list).mockImplementation(()=>new Promise(done=>{resolve=done}))
  const store=useAnnouncementStore(),pending=store.fetchAnnouncements()
  store.reset();resolve([{id:1,title:'Previous source',notify_mode:'popup',read_at:null}] as Awaited<ReturnType<typeof announcementsAPI.list>>)
  await pending
  expect(store.announcements).toEqual([]);expect(store.currentPopup).toBeNull()
})
