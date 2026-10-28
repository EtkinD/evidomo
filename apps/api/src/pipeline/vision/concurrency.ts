/**
 * Maps `items` through `fn` with at most `limit` calls in flight. After the first failure no new
 * call starts; the calls already running are awaited (so none keeps spending after the step has
 * failed) and the first error is rethrown. Results keep the input order.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: ({ readonly value: R } | undefined)[] = [];
  let next = 0;
  let failure: { readonly error: unknown } | undefined;

  async function worker(): Promise<void> {
    while (failure === undefined && next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = { value: await fn(item, index) };
      } catch (error) {
        failure ??= { error };
      }
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failure !== undefined) throw failure.error;
  return items.map((_, index) => {
    const result = results[index];
    if (result === undefined) throw new Error(`mapLimited: no result for item ${index}`);
    return result.value;
  });
}
