<script lang="ts">
  // A clickable table header. Exists so the sort affordance — the button, the
  // direction arrow, the aria-sort wiring and the hover styling — is written
  // once instead of in every table that wants sorting.
  //
  // The sort state is bindable, so a table owns one `$state` object and each
  // header mutates it. That keeps "only one column is sorted at a time" true by
  // construction rather than by convention.
  import { ariaSort, nextSortState, type SortState } from '../lib/sort'

  let {
    sort = $bindable(),
    key,
    label,
    numeric = false,
  }: {
    sort: SortState
    /** Matches the accessor key the table passes to sortRows(). */
    key: string
    label: string
    /** Right-aligns the column, matching the `num` class used across the UI. */
    numeric?: boolean
  } = $props()
</script>

<th class:num={numeric} aria-sort={ariaSort(sort, key)}>
  <button class="sort" onclick={() => (sort = nextSortState(sort, key))}>
    {label}<span class="ind">{sort.key === key ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</span>
  </button>
</th>

<style>
  /* `all: unset` so the header keeps the table's own header styling instead of
     looking like one of the page's buttons. */
  button.sort {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
  }
  button.sort:hover,
  button.sort:focus-visible {
    color: var(--accent);
  }
  /* Fixed width so the header does not shift when the arrow appears. */
  .ind {
    font-size: 0.7rem;
    width: 0.6rem;
    display: inline-block;
  }
</style>
