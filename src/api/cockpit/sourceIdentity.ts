import { getCockpitSourceIdentity } from './index'

export function cockpitWindowSourceId(sourceInstanceId: string): string {
  return `cockpit:${encodeURIComponent(sourceInstanceId)}:request_logs`
}

/** Bracket a batch with native identities; never publish mixed roots under one scope. */
export async function assertCockpitSourceIdentity(expected: string): Promise<void> {
  const observed = await getCockpitSourceIdentity()
  if (observed.sourceInstanceId !== expected) throw new Error('Cockpit data source changed during the read; reload the current source')
}
