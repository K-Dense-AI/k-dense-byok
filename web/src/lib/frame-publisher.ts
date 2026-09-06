/** Coalesce display updates only. The caller still consumes every wire event. */
export function createFramePublisher<T>(publish: (value: T) => void) {
  let pending: { value: T } | undefined;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = undefined;
    timer = undefined;
    pending = undefined;
  };
  const flush = () => {
    const next = pending;
    cancel();
    if (next) publish(next.value);
  };
  return {
    schedule(value: T) {
      pending = { value };
      if (timer !== undefined) return;
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(flush);
      // RAF pauses in hidden tabs. Keep state current without relying on paint.
      timer = setTimeout(flush, 50);
    },
    publish(value: T) {
      cancel();
      publish(value);
    },
    flush,
    cancel,
  };
}
