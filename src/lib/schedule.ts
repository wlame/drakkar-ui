// Poll coordination for pages that refresh several endpoints at different
// rates. One timer advances a tick counter and asks this function what is due,
// instead of each endpoint owning its own setInterval. That is what keeps two
// endpoints from landing on the same tick: every request costs the worker a
// main-loop dispatch, so three of them arriving together is a burst the worker
// feels, and it repeats forever once the intervals align.

export interface PollJob {
  /** Identifies the job to the caller; returned by dueJobs when the job fires. */
  name: string
  /** Fire once every this many ticks. */
  everyTicks: number
  /** Tick of the first firing. Choose offsets so jobs cannot collide. */
  offsetTicks: number
}

/**
 * Return the names of the jobs due on `tick`.
 *
 * A job fires on `offsetTicks`, and then every `everyTicks` after it. It never
 * fires before its offset.
 */
export function dueJobs(jobs: PollJob[], tick: number): string[] {
  return jobs
    .filter((j) => tick >= j.offsetTicks && (tick - j.offsetTicks) % j.everyTicks === 0)
    .map((j) => j.name)
}
