/** First row of an INSERT/UPDATE ... RETURNING that must affect exactly one row. */
export function returnedRow<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (row === undefined) throw new Error(`Expected a returned ${what} row, got none`);
  return row;
}
