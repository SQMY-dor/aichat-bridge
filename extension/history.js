// Clearing the list retains job identities/receipts for idempotent callbacks.
// Existing retention sweeps still expire these records normally.
export function clearableHistoryIds(state) {
  const pending = new Set(state.outbox.filter(item => !item.abandoned).flatMap(item => [item.id, item.jobId]));
  return new Set(state.jobs.filter(job => !job.historyCleared &&
    ['completed', 'failed', 'cancelled'].includes(job.state) &&
    job.answerDelivery?.state !== 'pending' && !pending.has(job.id)).map(job => job.id));
}
