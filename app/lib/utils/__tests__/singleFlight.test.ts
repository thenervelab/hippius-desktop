import { describe, expect, it, vi } from "vitest";
import { singleFlight } from "../singleFlight";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("shares one pending call instead of starting another", async () => {
    const first = deferred<number>();
    const run = vi.fn(() => first.promise);
    const call = singleFlight(run);

    const a = call();
    const b = call();
    const c = call();
    expect(run).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);

    first.resolve(7);
    await expect(a).resolves.toBe(7);
  });

  it("never piles up while the backend does not answer", () => {
    // A hung backend: the promise never settles. A poller ticking every two
    // seconds for an hour still has one call outstanding.
    const run = vi.fn(() => new Promise<never>(() => undefined));
    const call = singleFlight(run);
    for (let tick = 0; tick < 1800; tick++) void call();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh call once the previous one settled, even after a failure", async () => {
    const calls = [deferred<string>(), deferred<string>(), deferred<string>()];
    let i = 0;
    const run = vi.fn(() => calls[i++].promise);
    const call = singleFlight(run);

    const first = call();
    calls[0].reject(new Error("backend down"));
    await expect(first).rejects.toThrow("backend down");

    const second = call();
    expect(run).toHaveBeenCalledTimes(2);
    calls[1].resolve("ok");
    await expect(second).resolves.toBe("ok");

    void call();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
