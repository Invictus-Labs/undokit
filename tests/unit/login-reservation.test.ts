import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import { GateFullError, LoginRateLimiter, VerifyGate } from "../../src/services/ratelimit.js";

describe("LoginRateLimiter reservations", () => {
  const make = () => new LoginRateLimiter(new FixedClock("2026-01-15T12:00:00.000Z"), 3, 15 * 60 * 1000);

  it("in-flight reservations count against the budget before any failure is recorded", () => {
    const l = make();
    expect([l.tryReserve("k"), l.tryReserve("k"), l.tryReserve("k"), l.tryReserve("k")]).toEqual([true, true, true, false]);
    expect(l.blocked("k")).toBe(true);
    expect(l.inFlight("k")).toBe(3);
  });

  it("settle(false) frees the slot; settle(true) turns it into a recorded failure", () => {
    const l = make();
    l.tryReserve("k");
    l.tryReserve("k");
    l.settle("k", false);
    expect(l.inFlight("k")).toBe(1);
    l.settle("k", true);
    expect(l.inFlight("k")).toBe(0);
    l.tryReserve("k");
    l.tryReserve("k");
    expect(l.tryReserve("k"), "1 failure + 2 pending fills a budget of 3").toBe(false);
  });

  it("clear() forgets completed failures but pending reservations keep counting until they settle", () => {
    const l = make();
    l.recordFailure("k");
    for (let i = 0; i < 2; i += 1) l.tryReserve("k");
    expect(l.blocked("k")).toBe(true);
    l.clear("k");
    expect(l.tryReserve("k")).toBe(true);
    expect(l.tryReserve("k"), "three reservations still in flight").toBe(false);
  });
});

describe("VerifyGate", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("runs at most maxActive tasks at once and starts the next waiter as a slot frees", async () => {
    const gate = new VerifyGate(2, 10);
    const holds = Array.from({ length: 5 }, deferred);
    let running = 0;
    let max = 0;
    const runs = holds.map((h) =>
      gate.run(async () => {
        running += 1;
        max = Math.max(max, running);
        await h.promise;
        running -= 1;
      }),
    );
    await Promise.resolve();
    expect(running).toBe(2);
    for (const h of holds) h.resolve();
    await Promise.all(runs);
    expect(max).toBe(2);
    expect(gate.peak).toBe(2);
  });

  it("refuses with GateFullError once maxQueued callers are waiting, and a failing task frees its slot", async () => {
    const gate = new VerifyGate(1, 1);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const second = gate.run(async () => "second");
    await expect(gate.run(async () => "third")).rejects.toBeInstanceOf(GateFullError);
    hold.resolve();
    await first;
    expect(await second).toBe("second");
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(async () => "after")).toBe("after");
  });

  it("rejects a non-positive slot count", () => {
    expect(() => new VerifyGate(0)).toThrow(RangeError);
  });
});
