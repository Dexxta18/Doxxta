// Web features pdf.js uses that some browsers the apps run on lack, added where missing. (pdf.js's
// legacy build adds the JavaScript built-ins it needs, but not these.) Imported before anything else.

// Reading a stream with `for await`, as pdf.js reads a page's text. Safari can't: without this, Edit
// text, search and the exports found no text in the iPhone app.
const streams = typeof ReadableStream === "undefined" ? null : (ReadableStream.prototype as unknown as Record<PropertyKey, unknown>);
if (streams && !(Symbol.asyncIterator in streams)) {
  function values<T>(this: ReadableStream<T>, { preventCancel = false } = {}): AsyncIterableIterator<T> {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result as IteratorResult<T>;
        } catch (e) {
          reader.releaseLock();
          throw e;
        }
      },
      // Leaving the loop early (break, or an error in it) cancels the stream.
      async return(value?: unknown) {
        const cancelled = preventCancel ? undefined : reader.cancel(value);
        reader.releaseLock();
        await cancelled;
        return { done: true, value: value as T };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  Object.defineProperty(streams, "values", { value: values, writable: true, configurable: true });
  Object.defineProperty(streams, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
}

// A signal that aborts when any of several do: Safari has it from 17.4, the iPhone app runs from iOS 16.4.
if (typeof AbortSignal !== "undefined" && !("any" in AbortSignal)) {
  Object.defineProperty(AbortSignal, "any", {
    value: (signals: Iterable<AbortSignal>) => {
      const controller = new AbortController();
      for (const signal of signals) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          break;
        }
        signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal });
      }
      return controller.signal;
    },
    writable: true,
    configurable: true,
  });
}

export {};
