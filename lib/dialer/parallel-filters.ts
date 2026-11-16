// Parallel targets its selected list. Workspace location belongs to Manual/Power.
export function parallelLeadFilters(input: { listId?: string; parallelLocation?: string }) {
  return {
    p_list: input.listId ?? null,
    p_location: input.parallelLocation?.trim() || null,
  };
}
