// FIFO queue with concurrency one and real cancellation.
//
// cancel(id) on a waiting entry removes it without ever running it; on the
// running one it aborts the entry's AbortSignal and the entry keeps the lane
// until its runner settles, so the next download never starts while the old
// process tree is still being killed.

export class MediaQueue {
  constructor() {
    this.pending = []; // { id, run }
    this.active = null; // { id, controller, run }
    this.idleWaiters = [];
  }

  get size() { return this.pending.length + (this.active ? 1 : 0); }
  get activeId() { return this.active?.id || null; }
  get pendingIds() { return this.pending.map((e) => e.id); }
  has(id) { return this.active?.id === id || this.pending.some((e) => e.id === id); }

  /** Add a job; run(signal) must return a promise. Never rejects. */
  enqueue(id, run) {
    if (this.has(id)) return false;
    this.pending.push({ id, run });
    this.#pump();
    return true;
  }

  /** "pending" (removed, never ran), "active" (abort sent) or false. */
  cancel(id) {
    const index = this.pending.findIndex((e) => e.id === id);
    if (index >= 0) { this.pending.splice(index, 1); return "pending"; }
    if (this.active?.id === id) { this.active.controller.abort(); return "active"; }
    return false;
  }

  /** Remove everything waiting and abort the running job. Returns the ids removed from the waiting list. */
  cancelAll() {
    const waiting = this.pending.splice(0).map((e) => e.id);
    this.active?.controller.abort();
    return waiting;
  }

  /** Resolves once nothing is running or waiting. */
  idle(timeoutMs = 0) {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); resolve(); };
      this.idleWaiters.push(done);
      if (timeoutMs) { timer = setTimeout(done, timeoutMs); timer.unref?.(); }
    });
  }

  #pump() {
    if (this.active) return;
    const next = this.pending.shift();
    if (!next) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
      return;
    }
    const controller = new AbortController();
    this.active = { id: next.id, controller };
    Promise.resolve()
      .then(() => next.run(controller.signal))
      .catch(() => {})
      .finally(() => {
        this.active = null;
        this.#pump();
      });
  }
}
