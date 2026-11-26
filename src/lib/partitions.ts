// Display names of partitions. A part of a split job runs on a partition of the
// internal parts topic, numbered from a base the backend reports
// (capabilities.split.parts_partition_base); the UI shows it as "parts <n>".

/**
 * The text to show for a partition number. Display only: anything sent back to
 * the backend (trace searches, links) keeps the raw number.
 */
export function partitionLabel(partition: number, base: number | null | undefined): string {
  if (isPartsPartition(partition, base)) return `parts ${partition - (base as number)}`
  return String(partition)
}

/**
 * True for a partition of the internal parts topic. Such a number is not a
 * partition of the source topic, so no Kafka or probe link may point at it.
 */
export function isPartsPartition(partition: number, base: number | null | undefined): boolean {
  return typeof base === 'number' && base > 0 && partition >= base
}

/**
 * The label with a short prefix ("p5", "P5"), except for a parts partition,
 * which already names itself ("parts 3" and not "pparts 3").
 */
export function prefixedPartitionLabel(
  partition: number,
  base: number | null | undefined,
  prefix: string,
): string {
  const label = partitionLabel(partition, base)
  return label.startsWith('parts') ? label : `${prefix}${label}`
}
