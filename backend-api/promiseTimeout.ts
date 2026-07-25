// @ts-nocheck

// Race a promise against a timeout. If `promise` resolves first, the timer is
// cleared and its value passes through. If the timer fires first, the returned
// promise rejects with `new Error(message)`. The underlying `promise` is
// abandoned but not cancelled — callers that need real cancellation must
// thread their own AbortSignal into the work `promise` is doing.
function runWithTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(message || `Operation exceeded ${timeoutMs}ms timeout`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Cancellable variant: invokes `factory(signal)` with a fresh AbortController.
// On timeout, the controller is aborted before the timeout error rejects, so
// the underlying work has a chance to clean up (close file handles, kill
// subprocesses, etc.). The factory receives `{ signal, controller }` to allow
// composing with upstream signals.
function runWithCancellableTimeout(factory, timeoutMs, message) {
  const controller = new AbortController();
  let timer;
  const timeoutMessage = message || `Operation exceeded ${timeoutMs}ms timeout`;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(timeoutMessage);
      try {
        controller.abort(error);
      } catch {
        /* abort with reason isn't supported on older runtimes — fall back */
      }
      reject(error);
    }, timeoutMs);
  });
  const work = Promise.resolve().then(() => factory({ signal: controller.signal, controller }));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { runWithTimeout, runWithCancellableTimeout };
