/**
 * A load run that rejects outside its per-instance handling (a storage failure, a bug) must
 * still settle every instance, or the command shows a spinner forever.
 */
export function settleWithError<T extends { loading: boolean; error: Error | undefined }>(
  states: T[],
  reason: unknown,
): T[] {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  return states.map((state) => (state.loading ? { ...state, loading: false, error } : state));
}
