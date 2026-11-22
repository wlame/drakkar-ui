// Display names of partitions. A part of a split job runs on a partition of the
// internal parts topic, numbered from a base the backend reports
// (capabilities.split.parts_partition_base); the UI shows it as "parts <n>".

/**
 * The text to show for a partition number. Display only: anything sent back to
 * the backend (trace searches, links) keeps the raw number.
 */
export function partitionLabel(partition: number, base: number | null | undefined): string {
  if (typeof base === 'number' && partition >= base) return `parts ${partition - base}`
  return String(partition)
}
