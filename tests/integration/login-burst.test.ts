import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, FixedClock, KeyRing, SequentialIds, createUndoKit, createWorkspaceWithAdmin, login } from "../../src/index.js";
import { LOGIN_IP_FAILURE_MULTIPLIER, LOGIN_MAX_CONCURRENT_VERIFIES, VerifyGate } from "../../src/services/ratelimit.js";
import { FIXED_NOW_ISO } from "../helpers/fixtures.js";
import { newPassword } from "../helpers/kit.js";

/**
 * Concurrent login bursts must be counted while still in flight. Before attempts were reserved synchronously, every
 * request in a burst passed the limiter check before the first failure was recorded, so 200 parallel wrong-password
 * logins all reached scrypt and none was RATE_LIMITED.
 */
describe("login: concurrent bursts cannot bypass the failure budgets", () => {
  let kit: Awaited<ReturnType<typeof createUndoKit>>;
  const password = newPassword();
  const email = "burst-admin@example.test";
  const BUDGET = 10;
  beforeAll(async () => {
    kit = await createUndoKit({
      databaseUrl: "memory://",
      keyring: KeyRing.fromBase64(KeyRing.generateKeyText()),
      clock: new FixedClock(FIXED_NOW_ISO),
      ids: new SequentialIds("dddddddd"),
      config: { loginMaxFailures: BUDGET },
    });
    await createWorkspaceWithAdmin(kit, { email, password, workspace_name: "Burst" });
  }, 60_000);
  afterAll(async () => {
    await kit.close();
  });

  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
  const tally = (codes: string[]) => codes.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {});

  it("200 concurrent wrong-password logins for one account and address: at most the per-account budget is evaluated, the rest are RATE_LIMITED", async () => {
    kit.loginVerifyGate = new VerifyGate();
    const ip = "10.20.0.1";
    const codes = await Promise.all(Array.from({ length: 200 }, () => code(login(kit, { email, password: "wrong-password-xx" }, { ip }))));
    const t = tally(codes);
    expect(t.INVALID_CREDENTIALS).toBe(BUDGET);
    expect(t.RATE_LIMITED).toBe(200 - BUDGET);
    expect(Object.keys(t).sort()).toEqual(["INVALID_CREDENTIALS", "RATE_LIMITED"]);
    expect(kit.loginVerifyGate.peak, "verifications ran through the gate").toBeGreaterThanOrEqual(1);
    expect(kit.loginVerifyGate.peak, "scrypt verifications are capped").toBeLessThanOrEqual(LOGIN_MAX_CONCURRENT_VERIFIES);
    // Every reservation settled into a recorded failure: the account stays locked and nothing is left in flight.
    expect(kit.loginLimiter.inFlight(`${ip}|${email}`)).toBe(0);
    expect(await code(login(kit, { email, password }, { ip }))).toBe("RATE_LIMITED");
  }, 60_000);

  it("200 concurrent wrong logins from one address across distinct emails: at most the per-address budget is evaluated", async () => {
    const ip = "10.20.0.2";
    const codes = await Promise.all(
      Array.from({ length: 200 }, (_, i) => code(login(kit, { email: `nobody-${i}@example.test`, password: "wrong-password-xx" }, { ip }))),
    );
    const t = tally(codes);
    expect(t.INVALID_CREDENTIALS).toBe(BUDGET * LOGIN_IP_FAILURE_MULTIPLIER);
    expect(t.RATE_LIMITED).toBe(200 - BUDGET * LOGIN_IP_FAILURE_MULTIPLIER);
    expect(kit.loginIpLimiter.inFlight(`ip|${ip}`)).toBe(0);
  }, 60_000);

  it("a correct password inside a burst that stays under the budget signs in", async () => {
    const ip = "10.20.0.3";
    const attempts = [code(login(kit, { email, password }, { ip }))];
    for (let i = 0; i < BUDGET - 1; i += 1) attempts.push(code(login(kit, { email, password: "wrong-password-xx" }, { ip })));
    const [correct, ...wrong] = await Promise.all(attempts);
    expect(correct).toBe("ok");
    expect(wrong).toEqual(Array.from({ length: BUDGET - 1 }, () => "INVALID_CREDENTIALS"));
  }, 60_000);

  it("a correct password sent after a full budget of in-flight wrong guesses is RATE_LIMITED: pending attempts count", async () => {
    const ip = "10.20.0.4";
    const wrong = Array.from({ length: BUDGET }, () => code(login(kit, { email, password: "wrong-password-xx" }, { ip })));
    const correct = code(login(kit, { email, password }, { ip }));
    expect(await correct).toBe("RATE_LIMITED");
    expect(await Promise.all(wrong)).toEqual(Array.from({ length: BUDGET }, () => "INVALID_CREDENTIALS"));
  }, 60_000);

  it("a success clears completed per-account failures, and the next burst is again capped at the budget", async () => {
    const ip = "10.20.0.5";
    for (let i = 0; i < BUDGET - 1; i += 1) expect(await code(login(kit, { email, password: "wrong-password-xx" }, { ip }))).toBe("INVALID_CREDENTIALS");
    expect(await code(login(kit, { email, password }, { ip }))).toBe("ok");
    const codes = await Promise.all(Array.from({ length: 50 }, () => code(login(kit, { email, password: "wrong-password-xx" }, { ip }))));
    expect(tally(codes)).toEqual({ INVALID_CREDENTIALS: BUDGET, RATE_LIMITED: 50 - BUDGET });
  }, 60_000);

  it("when the verification queue is full the login is RATE_LIMITED and its reservation is released, not counted as a failure", async () => {
    const saved = kit.loginVerifyGate;
    kit.loginVerifyGate = new VerifyGate(1, 0);
    try {
      const ipA = "10.20.0.6";
      const ipB = "10.20.0.7";
      const [a, b] = await Promise.all([
        code(login(kit, { email, password: "wrong-password-xx" }, { ip: ipA })),
        code(login(kit, { email, password: "wrong-password-xx" }, { ip: ipB })),
      ]);
      expect([a, b].sort()).toEqual(["INVALID_CREDENTIALS", "RATE_LIMITED"]);
      const shed = a === "RATE_LIMITED" ? ipA : ipB;
      expect(kit.loginLimiter.inFlight(`${shed}|${email}`)).toBe(0);
      expect(kit.loginIpLimiter.inFlight(`ip|${shed}`)).toBe(0);
    } finally {
      kit.loginVerifyGate = saved;
    }
    // The shed attempt was not recorded as a failure, so a correct password from either address still signs in.
    expect(await code(login(kit, { email, password }, { ip: "10.20.0.6" }))).toBe("ok");
    expect(await code(login(kit, { email, password }, { ip: "10.20.0.7" }))).toBe("ok");
  }, 60_000);
});
