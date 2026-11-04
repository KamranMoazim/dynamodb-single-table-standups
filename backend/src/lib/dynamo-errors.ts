export function isConditionFailure(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  if (name === 'ConditionalCheckFailedException') {
    return true;
  }
  if (name === 'TransactionCanceledException') {
    const reasons =
      (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
    return reasons.some((reason) => reason.Code === 'ConditionalCheckFailed');
  }
  return false;
}
