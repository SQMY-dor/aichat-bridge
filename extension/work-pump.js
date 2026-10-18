// One step at a time: wake on new work; pace ready work without a one-second
// gap per operation. The idle timer is a recovery path, not a delivery queue.
export function createWorkPump({ step, onError = () => {}, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout, now = Date.now, idleMs = 1000, paceMs = 250 } = {}) {
  if (typeof step !== 'function') throw new TypeError('step is required');
  let timer; let running = false; let pendingWake = false; let stopped = true; let nextAllowedAt = 0;
  const arm = delay => {
    if (stopped) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => { timer = undefined; void run(); }, Math.max(delay, nextAllowedAt - now()));
  };
  async function run() {
    if (stopped || running) return;
    running = true; pendingWake = false;
    let worked = false;
    try { worked = (await step()) === true; }
    catch (error) { try { onError(error); } catch {} }
    finally {
      running = false;
      if (worked) nextAllowedAt = now() + paceMs;
      if (!stopped) arm(worked ? paceMs : pendingWake ? 0 : idleMs);
    }
  }
  return {
    start() { if (!stopped) return; stopped = false; arm(0); },
    wake() { if (stopped) return; if (running) { pendingWake = true; return; } arm(0); },
    stop() { stopped = true; pendingWake = false; if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}
