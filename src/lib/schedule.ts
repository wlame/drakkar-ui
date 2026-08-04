// Poll coordination for a page that refreshes several endpoints at different
// rates. One timer advances a tick counter and asks this function what is due,
// instead of each endpoint owning its own setInterval. That is what lets a page
// keep two of its own endpoints off the same tick: every request costs the
// worker a main-loop dispatch, so several arriving together is a burst the
// worker feels, and it repeats forever once the intervals align. Other timers
// elsewhere in the app are not coordinated by this — the guarantee is per page.

export interface PollJob<Name extends string = string> {
  /** Identifies the job to the caller; returned by dueJobs when the job fires. */
  name: Name
  /** Fire once every this many ticks. Must be a positive integer. */
  everyTicks: number
  /** Tick of the first firing. Choose offsets so jobs cannot collide. */
  offsetTicks: number
}

/**
 * Return the names of the jobs due on `tick`.
 *
 * A job fires on `offsetTicks`, and then every `everyTicks` after it. It never
 * fires before its offset.
 *
 * @throws if any job has a non-positive or fractional `everyTicks`.
 */
export function dueJobs<Name extends string>(jobs: PollJob<Name>[], tick: number): Name[] {
  const due: Name[] = []
  for (const job of jobs) {
    // `% 0` is NaN and a negative period never matches, so an invalid value
    // would disable the job without a word. Job sets are static constants, so
    // throwing surfaces the typo on the first tick instead of hiding it.
    if (!Number.isInteger(job.everyTicks) || job.everyTicks <= 0) {
      throw new Error(
        `poll job "${job.name}" has everyTicks=${job.everyTicks}; expected a positive integer`,
      )
    }
    if (tick >= job.offsetTicks && (tick - job.offsetTicks) % job.everyTicks === 0) {
      due.push(job.name)
    }
  }
  return due
}
