import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, FixedClock, KeyRing, SequentialIds, createUndoKit, createWorkspaceWithAdmin, login } from "../../src/index.js";
import { LOGIN_IP_FAILURE_MULTIPLIER } from "../../src/services/ratelimit.js";
import { FIXED_NOW_ISO } from "../helpers/fixtures.js";
import { newPassword } from "../helpers/kit.js";

describe("login: per-address failure bucket across emails", () => {
  let kit: Awaited<ReturnType<typeof createUndoKit>>;
  const password = newPassword();
  const email = "ip-limit-admin@example.test";
  beforeAll(async () => {
    kit = await createUndoKit({
      databaseUrl: "memory://",
      keyring: KeyRing.fromBase64(KeyRing.generateKeyText()),
      clock: new FixedClock(FIXED_NOW_ISO),
      ids: new SequentialIds("cccccccc"),
      config: { loginMaxFailures: 2 },
    });
    await createWorkspaceWithAdmin(kit, { email, password, workspace_name: "IP Limit" });
  }, 60_000);
  afterAll(async () => {
    await kit.close();
  });

  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AppError ? e.code : String(e)));

  it("one address cycling through emails is throttled before any further password hashing, a valid account does not reset it, and another address is unaffected", async () => {
    const budget = 2 * LOGIN_IP_FAILURE_MULTIPLIER;
    for (let i = 0; i < budget; i += 1) {
      // A fresh email each time never trips the per-(address,email) limit.
      expect(await code(login(kit, { email: `nobody-${i}@example.test`, password: "wrong-password-xx" }, { ip: "10.6.6.6" }))).toBe("INVALID_CREDENTIALS");
    }
    expect(await code(login(kit, { email: "fresh@example.test", password: "wrong-password-xx" }, { ip: "10.6.6.6" }))).toBe("RATE_LIMITED");
    expect(await code(login(kit, { email, password }, { ip: "10.6.6.6" }))).toBe("RATE_LIMITED");
    expect(await code(login(kit, { email, password }, { ip: "10.5.5.5" }))).toBe("ok");
  });
});
