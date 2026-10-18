'use strict';

/** setTimeout as a promise that rejects when `signal` aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** Runs at most `max` jobs at the same time, the rest wait in order. */
class Limiter {
  constructor(max) {
    this.max = Math.max(1, max || 1);
    this.running = 0;
    this.queue = [];
  }

  run(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this._next();
    });
  }

  _next() {
    while (this.running < this.max && this.queue.length) {
      const { job, resolve, reject } = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          this._next();
        });
    }
  }
}

/**
 * A producer pushes chunks whenever it likes; one consumer reads them later
 * with `for await`. Lets TTS for sentence 3 download while sentence 2 is
 * still being sent, without changing the order on the wire.
 */
class BufferedStream {
  constructor() {
    this.chunks = [];
    this.ended = false;
    this.error = null;
    this.wake = null;
  }

  push(chunk) {
    if (this.ended) return;
    this.chunks.push(chunk);
    this._wake();
  }

  end() {
    this.ended = true;
    this._wake();
  }

  fail(err) {
    this.error = err;
    this.end();
  }

  _wake() {
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.chunks.length) {
        yield this.chunks.shift();
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise((r) => (this.wake = r));
    }
  }
}

module.exports = { sleep, Limiter, BufferedStream };
