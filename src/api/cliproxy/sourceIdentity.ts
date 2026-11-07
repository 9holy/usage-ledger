import type { CliproxyUsageEvent, CliproxyUsageSnapshot } from './cpaData'

export type CliproxySourceMetadata = Pick<CliproxyUsageSnapshot, 'sourceInstanceId' | 'managementLinkAllowed'>

/** A loaded batch must represent one local producer; never infer it from a remote URL. */
export function cliproxySourceInstance(events: CliproxyUsageEvent[], metadata?: CliproxySourceMetadata): string {
  const declared = metadata?.sourceInstanceId
  if (declared != null && (typeof declared !== 'string' || !declared.trim())) throw new Error('Invalid CPA source instance')
  const instances = new Set(events.map(event => event.source_instance_id).filter((value): value is string => value != null))
  if ([...instances].some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid CPA source instance')
  if (instances.size > 1 || (declared != null && [...instances].some(value => value !== declared))) {
    throw new Error('Cannot combine different CPA source instances')
  }
  // Older native readers had exactly one fixed default path. Preserve its existing IDs.
  return declared ?? instances.values().next().value ?? 'local'
}

export function scopedCliproxyEvents(events: CliproxyUsageEvent[], metadata?: CliproxySourceMetadata): CliproxyUsageEvent[] {
  const instance = cliproxySourceInstance(events, metadata)
  return events.map(event => event.source_instance_id === instance ? event : { ...event, source_instance_id: instance })
}

export function cliproxyWindowSourceId(instance: string): string {
  return `cliproxy:${encodeURIComponent(instance)}:cpa_usage_events`
}
