import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { getLocalCostReport } from '../localCost'

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({}))}))

it('pairs account month totals with the local month of the exclusive reporting cutoff',async()=>{
  const start=new Date(2026,10,1).getTime(),end=new Date(2026,11,1).getTime()
  await getLocalCostReport(start,end)
  expect(invoke).toHaveBeenCalledWith('local_cost_report',{startMs:start,endMs:end,monthStartMs:start})
})
