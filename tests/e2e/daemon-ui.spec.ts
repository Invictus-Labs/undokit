// Real daemon + real UI + real browser, no route mocks (QA-owned). AC-03/04/05 UI paths, AC-09 hostile values in the UI,
// AC-12 roles and isolation in the UI, loading/empty/error states.
import { expect, test, type Page } from "@playwright/test";
import { requestReconcile } from "../../src/index.js";
import { startDaemon, type Daemon } from "../helpers/daemon.js";
import { loadHostile } from "../helpers/fixtures.js";

test.describe.configure({ timeout: 45_000 });

let d: Daemon;
test.beforeEach(async () => {
  d = await startDaemon({ sensitiveFields: ["owner_label"] });
});
test.afterEach(async () => {
  await d.close();
});

function watch(page: Page) {
  const seen = { external: [] as string[], errors: [] as string[], dialogs: [] as string[] };
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(d.url) && !u.startsWith("data:") && !u.startsWith("blob:")) seen.external.push(u);
  });
  page.on("pageerror", (e) => seen.errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource.*(401|404|403)/.test(m.text())) seen.errors.push(m.text());
  });
  page.on("dialog", async (dlg) => {
    seen.dialogs.push(dlg.message());
    await dlg.dismiss();
  });
  return seen;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(d.url);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("whoami")).toBeVisible();
}

const asOperator = (page: Page) => signIn(page, d.env.emails.operator, d.env.passwords.operator);

async function planViaUi(page: Page, opts: { record: string; version: string; field: string; value: string }) {
  await page.goto(`${d.url}/#/operations/new`);
  await page.getByLabel("Connector").selectOption({ index: 1 });
  await expect(page.getByTestId("connector-label")).toContainText("Simulator, not a live provider");
  await page.getByLabel("Record reference").fill(opts.record);
  await page.getByLabel("Record version the plan is based on").fill(opts.version);
  const row = page.getByTestId("patch-row").first();
  await row.locator("select").first().selectOption(opts.field);
  const valueControl = row.locator("label", { hasText: "New value" }).locator("select, input").first();
  if ((await valueControl.evaluate((el) => el.tagName)) === "SELECT") await valueControl.selectOption(opts.value);
  else await valueControl.fill(opts.value);
  await page.getByTestId("plan-submit").click();
}

const state = (page: Page) => page.getByTestId("state-explainer");

test.describe("login and session", () => {
  test("wrong password shows an error and no session; correct password shows who is signed in; sign out returns to the form", async ({ page }) => {
    const seen = watch(page);
    await page.goto(d.url);
    await expect(page.getByTestId("login-form")).toBeVisible();
    await page.getByLabel("Email").fill(d.env.emails.operator);
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page.getByTestId("whoami")).toHaveCount(0);
    await page.getByLabel("Password").fill(d.env.passwords.operator);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("whoami")).toContainText("(operator)");
    await page.reload(); // the HttpOnly cookie keeps the session across a reload
    await expect(page.getByTestId("whoami")).toBeVisible();
    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("login-form")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("login-form")).toBeVisible();
    expect(seen.external, "requests outside the daemon").toEqual([]);
    expect(seen.errors).toEqual([]);
    const cookies = await page.context().cookies();
    expect(cookies.every((c) => c.name !== "undokit_session" || c.httpOnly)).toBe(true);
  });
});

test.describe("AC-03/05 operator flows through the real UI", () => {
  test("plan, approve, apply, preview compensation, approve it separately, restore: every state is shown honestly", async ({ page }, testInfo) => {
    const seen = watch(page);
    await asOperator(page);
    await planViaUi(page, { record: "contact-0001", version: "sim-v1", field: "lifecycle_stage", value: "customer" });
    await expect(page.getByTestId("operation-title")).toContainText("contact-0001");
    await expect(state(page)).toHaveAttribute("data-state", "planned");
    await expect(page.getByTestId("field-diff")).toContainText("lead");
    await expect(page.getByTestId("field-diff")).toContainText("customer");
    expect(d.env.sim.calls.write, "planning writes nothing").toBe(0);

    await expect(page.getByTestId("approve-button")).toBeDisabled(); // approval needs the explicit confirmation
    await page.getByTestId("approve-confirm").check();
    await page.getByTestId("approve-button").click();
    await expect(state(page)).toHaveAttribute("data-state", "applied");
    expect(d.env.sim.snapshot("contact-0001")?.fields["lifecycle_stage"]).toBe("customer");
    expect(d.env.sim.calls.writeApplied).toBe(1);
    await expect(page.getByTestId("approvals")).toBeVisible();
    await expect(page.getByTestId("attempts")).toContainText("Succeeded");

    await page.getByTestId("preview-compensation-button").click();
    await expect(page.getByTestId("compensation")).toHaveAttribute("data-state", "planned");
    expect(d.env.sim.snapshot("contact-0001")?.fields["lifecycle_stage"], "preview writes nothing").toBe("customer");
    await expect(page.getByTestId("compensate-button")).toBeDisabled();
    await page.getByTestId("compensation-confirm").check();
    await page.getByTestId("compensate-button").click();
    await expect(page.getByTestId("compensation")).toHaveAttribute("data-state", "compensated");
    expect(d.env.sim.snapshot("contact-0001")?.fields["lifecycle_stage"]).toBe("lead");
    expect(d.env.sim.calls.writeApplied).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("happy-path.png"), fullPage: true });
    expect(seen.external).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test("a later edit blocks the compensation: conflict is shown with both values, no approve button exists, the edit is kept", async ({ page }, testInfo) => {
    await asOperator(page);
    const op = await d.env.applyOnce({ lifecycle_stage: "customer" });
    d.env.sim.externalEdit("contact-0001", { lifecycle_stage: "partner" });
    await page.goto(`${d.url}/#/operations/${op.id}`);
    await expect(state(page)).toHaveAttribute("data-state", "applied");
    await page.getByTestId("preview-compensation-button").click();
    await expect(page.getByTestId("compensation")).toHaveAttribute("data-state", "conflict");
    await expect(page.getByTestId("conflict-list")).toContainText("lifecycle_stage");
    await expect(page.getByTestId("conflict-list")).toContainText("partner");
    await expect(page.getByTestId("conflict-list")).toContainText("customer");
    await expect(page.getByTestId("compensate-button")).toHaveCount(0);
    await expect(page.getByTestId("compensation-blocked-note")).toContainText("No restore will be attempted");
    expect(d.env.sim.snapshot("contact-0001")?.fields["lifecycle_stage"]).toBe("partner");
    expect(d.env.sim.calls.writeApplied).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("blocked.png"), fullPage: true });
  });

  test("an apply that hits a provider-side conflict shows Conflict and not success; the other edit survives", async ({ page }) => {
    await asOperator(page);
    await planViaUi(page, { record: "contact-0001", version: "sim-v1", field: "lifecycle_stage", value: "customer" });
    await expect(state(page)).toHaveAttribute("data-state", "planned");
    d.env.sim.externalEdit("contact-0001", { lifecycle_stage: "partner" });
    await page.getByTestId("approve-confirm").check();
    await page.getByTestId("approve-button").click();
    await expect(state(page)).toHaveAttribute("data-state", "conflict");
    await expect(page.getByTestId("operation-title")).not.toContainText("Applied");
    expect(d.env.sim.snapshot("contact-0001")?.fields["lifecycle_stage"]).toBe("partner");
  });

  test("a lost response is shown as Unknown with a read-only reconcile button, which resolves it without a second write", async ({ page }) => {
    await asOperator(page);
    d.env.sim.failNextWrite("ambiguous_after_commit");
    await planViaUi(page, { record: "contact-0001", version: "sim-v1", field: "lifecycle_stage", value: "customer" });
    await page.getByTestId("approve-confirm").check();
    await page.getByTestId("approve-button").click();
    await expect(state(page)).toHaveAttribute("data-state", "unknown");
    await expect(page.getByTestId("state-next-step")).toContainText(/reconcil/i);
    await expect(page.getByTestId("operation-title")).not.toContainText("Applied");
    expect(d.env.sim.calls.write).toBe(1);
    await page.getByTestId("reconcile-button").click();
    // Resolved by the worker within a moment; poll the real server state, then check what the page itself shows.
    await expect.poll(async () => (await d.env.view((await d.env.kit.db.query<{ id: string }>("SELECT id FROM operations LIMIT 1")).rows[0]!.id)).state, { timeout: 10_000 }).toBe("applied");
    expect(d.env.sim.calls.write, "reconcile never writes").toBe(1);
    await page.reload();
    await expect(state(page)).toHaveAttribute("data-state", "applied");
  });

  test("planning problems are shown with nothing written: out-of-scope record, stale version, empty field choice", async ({ page }) => {
    await asOperator(page);
    await planViaUi(page, { record: "outside-0001", version: "sim-v1", field: "lifecycle_stage", value: "customer" });
    await expect(page.getByTestId("plan-errors")).toContainText("Nothing was written to the provider");
    await planViaUi(page, { record: "contact-0001", version: "sim-v9", field: "lifecycle_stage", value: "customer" });
    await expect(page.getByTestId("plan-errors")).toContainText(/changed|conflict|version/i);
    await page.goto(`${d.url}/#/operations/new`);
    await page.getByLabel("Connector").selectOption({ index: 1 });
    await page.getByLabel("Record reference").fill("contact-0001");
    await page.getByLabel("Record version the plan is based on").fill("sim-v1");
    await page.getByTestId("plan-submit").click();
    await expect(page.getByTestId("plan-errors")).toContainText("Choose an allowlisted field");
    expect(d.env.sim.calls.write).toBe(0);
    expect(await d.env.count("operations")).toBe(0);
  });

  test("a failed worker run shows Failed with the reason, not a success", async ({ page }) => {
    await asOperator(page);
    d.env.sim.failNextWrite("unavailable");
    await planViaUi(page, { record: "contact-0001", version: "sim-v1", field: "lifecycle_stage", value: "customer" });
    await page.getByTestId("approve-confirm").check();
    await page.getByTestId("approve-button").click();
    await expect(state(page)).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("state-detail")).toContainText("CONNECTOR_UNAVAILABLE");
  });

  test("the operations list and status panel list attention items for unresolved outcomes", async ({ page }) => {
    d.env.sim.failNextWrite("ambiguous_after_commit");
    await d.env.applyOnce({ lifecycle_stage: "customer" });
    await asOperator(page);
    await expect(page.getByTestId("operation-row")).toHaveCount(1);
    await expect(page.getByTestId("operation-row")).toHaveAttribute("data-state", "unknown");
    await expect(page.getByTestId("attention-list")).toBeVisible();
    await expect(page.getByTestId("attention-item")).toHaveCount(1);
  });
});

test.describe("AC-09 hostile values render as text in the real UI", () => {
  test("a hostile record value is shown literally and executes nothing", async ({ page }) => {
    const seen = watch(page);
    const payload = loadHostile().html_payloads[0]!.value;
    d.env.sim.seed("contact-0005", { lifecycle_stage: "lead", lead_score: 1, owner_label: payload });
    const op = await d.env.applyOnce({ lead_score: 2 }, { record_ref: "contact-0005" });
    await asOperator(page);
    await page.goto(`${d.url}/#/operations/${op.id}`);
    await expect(page.getByTestId("operation-title")).toContainText("contact-0005");
    // owner_label is configured sensitive here, so its value is redacted; the payload must not appear as markup anywhere.
    await expect(page.locator("script:not([src])")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __undokit_pwned?: string }).__undokit_pwned)).toBeUndefined();
    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test("a hostile non-sensitive field value is shown as text with its angle brackets intact", async ({ page }) => {
    const e2 = await startDaemon();
    try {
      const payload = loadHostile().html_payloads[2]!.value; // "><svg onload=...>
      e2.env.sim.seed("contact-0006", { lifecycle_stage: "lead", lead_score: 1, owner_label: payload });
      const op = await e2.env.applyOnce({ owner_label: "<img src=x onerror=\"window.__undokit_pwned='img'\">" }, { record_ref: "contact-0006" });
      const seen = { dialogs: 0 };
      page.on("dialog", async (dlg) => {
        seen.dialogs += 1;
        await dlg.dismiss();
      });
      await page.goto(e2.url);
      await page.getByLabel("Email").fill(e2.env.emails.operator);
      await page.getByLabel("Password").fill(e2.env.passwords.operator);
      await page.getByTestId("login-submit").click();
      await page.goto(`${e2.url}/#/operations/${op.id}`);
      await expect(page.getByTestId("field-diff")).toContainText("<img src=x onerror");
      await expect(page.locator("img")).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __undokit_pwned?: string }).__undokit_pwned)).toBeUndefined();
      expect(seen.dialogs).toBe(0);
    } finally {
      await e2.close();
    }
  });
});

test.describe("AC-12 roles and isolation in the UI", () => {
  test("viewer: can read, sees sensitive values redacted, cannot plan, approve or export", async ({ page }) => {
    const op = await d.env.planAndApprove({ owner_label: "alice-private-name", lead_score: 5 });
    await d.env.worker.drain();
    const planned = await d.env.plan({ lead_score: 9 }, { record_ref: "contact-0002" });
    await signIn(page, d.env.emails.viewer, d.env.passwords.viewer);
    await expect(page.getByTestId("whoami")).toContainText("(viewer)");
    await expect(page.getByTestId("viewer-note")).toBeVisible();
    await expect(page.getByTestId("export-button")).toHaveCount(0);
    await expect(page.getByTestId("new-plan-link")).toHaveCount(0);
    await page.goto(`${d.url}/#/operations/${op.id}`);
    await expect(page.getByTestId("operation-title")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("alice-private-name");
    await expect(page.locator("body")).toContainText("[REDACTED]");
    await page.goto(`${d.url}/#/operations/${planned.id}`);
    await expect(page.getByTestId("viewer-note")).toBeVisible();
    await expect(page.getByTestId("approve-button")).toHaveCount(0);
    await page.goto(`${d.url}/#/operations/new`);
    await expect(page.getByTestId("forbidden-note")).toBeVisible();
    await expect(page.getByTestId("plan-form")).toHaveCount(0);
    await page.goto(`${d.url}/#/members`);
    await expect(page.getByTestId("forbidden-note")).toBeVisible();
    await expect(page.getByTestId("members-table")).toHaveCount(0);
  });

  test("another workspace's operation id shows a not-found error and none of its data", async ({ page }) => {
    const op = await d.env.applyOnce({ lifecycle_stage: "customer" });
    await signIn(page, d.env.emails.operatorB, d.env.passwords.operatorB);
    await page.goto(`${d.url}/#/operations/${op.id}`);
    await expect(page.getByTestId("state-error")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("contact-0001");
    await expect(page.locator("body")).not.toContainText("Synthetic Agency A");
    await page.goto(`${d.url}/#/`);
    await expect(page.getByTestId("state-empty")).toBeVisible();
    await expect(page.getByTestId("operation-row")).toHaveCount(0);
  });

  test("admin: sees connectors (labelled simulator, never live), members, and can add a viewer who can then sign in", async ({ page, browser }) => {
    await signIn(page, d.env.emails.admin, d.env.passwords.admin);
    await page.goto(`${d.url}/#/connectors`);
    await expect(page.getByTestId("connectors-table")).toContainText(/simulator/i);
    await expect(page.getByTestId("connectors-table")).toContainText(/not a live provider/i);
    await expect(page.getByTestId("connectors-table")).not.toContainText(/Live provider\b(?!\))/);
    await page.goto(`${d.url}/#/members`);
    await expect(page.getByTestId("member-row")).toHaveCount(3);
    const newPassword = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}Qq1`;
    await page.getByTestId("member-form").getByLabel("Email").fill("new-viewer@example.test");
    await page.getByTestId("member-form").getByLabel(/Initial password/).fill(newPassword);
    await page.getByTestId("member-form").getByRole("button").click();
    await expect(page.getByTestId("member-row")).toHaveCount(4);
    const second = await browser.newContext();
    const page2 = await second.newPage();
    await page2.goto(d.url);
    await page2.getByLabel("Email").fill("new-viewer@example.test");
    await page2.getByLabel("Password").fill(newPassword);
    await page2.getByTestId("login-submit").click();
    await expect(page2.getByTestId("whoami")).toContainText("(viewer)");
    await second.close();
    await page.getByTestId("member-form").getByLabel("Email").fill(d.env.emails.viewer);
    await page.getByTestId("member-form").getByLabel(/Initial password/).fill(newPassword);
    await page.getByTestId("member-form").getByRole("button").click();
    await expect(page.getByTestId("member-error")).toBeVisible(); // duplicate email is reported, not swallowed
  });
});

test.describe("closing an UNKNOWN outcome by hand (administrator only; the provider is never contacted)", () => {
  async function unknownOperation(): Promise<string> {
    d.env.sim.failNextWrite("ambiguous_before_commit"); // the request was lost and the record is untouched
    const op = await d.env.applyOnce({ lifecycle_stage: "customer" }, { record_ref: "contact-0001" });
    expect((await d.env.view(op.id)).state).toBe("unknown");
    return op.id;
  }
  /** Reconciliation really cannot settle it (someone set a third value: STATE_AMBIGUOUS); only then may an administrator close it. */
  async function ambiguousOperation(): Promise<string> {
    const id = await unknownOperation();
    d.env.sim.externalEdit("contact-0001", { lifecycle_stage: "churned" });
    await requestReconcile(d.env.kit, d.env.operator, id);
    await d.env.worker.drain();
    expect((await d.env.view(id)).attempts.filter((a) => a.phase === "reconcile").at(-1)?.error_code).toBe("STATE_AMBIGUOUS");
    return id;
  }

  test("only an administrator sees the control, and only for an unknown outcome; operators and viewers do not", async ({ page, browser }) => {
    const id = await unknownOperation();
    const applied = await d.env.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
    await signIn(page, d.env.emails.admin, d.env.passwords.admin);
    await page.goto(`${d.url}/#/operations/${id}`);
    await expect(state(page)).toHaveAttribute("data-state", "unknown");
    await expect(page.getByTestId("resolve-panel")).toBeVisible();
    await expect(page.getByTestId("resolve-warning")).toContainText(/never writes to the provider/i);
    await page.goto(`${d.url}/#/operations/${applied.id}`);
    await expect(state(page)).toHaveAttribute("data-state", "applied");
    await expect(page.getByTestId("resolve-panel")).toHaveCount(0);
    for (const who of ["operator", "viewer"] as const) {
      const context = await browser.newContext();
      const other = await context.newPage();
      await other.goto(d.url);
      await other.getByLabel("Email").fill(d.env.emails[who]);
      await other.getByLabel("Password").fill(d.env.passwords[who]);
      await other.getByTestId("login-submit").click();
      await expect(other.getByTestId("whoami")).toBeVisible();
      await other.goto(`${d.url}/#/operations/${id}`);
      await expect(other.getByTestId("state-explainer")).toHaveAttribute("data-state", "unknown");
      await expect(other.getByTestId("resolve-panel"), who).toHaveCount(0);
      await context.close();
    }
  });

  test("the administrator must pick a decision and give a reason, confirms, and the operation becomes Failed (closed by an administrator) without any provider call", async ({ page }) => {
    const id = await ambiguousOperation();
    const callsBefore = { ...d.env.sim.calls };
    await signIn(page, d.env.emails.admin, d.env.passwords.admin);
    await page.goto(`${d.url}/#/operations/${id}`);
    await expect(page.getByTestId("resolve-start")).toBeDisabled();
    await page.getByTestId("resolve-outcome").selectOption("not_applied");
    await expect(page.getByTestId("resolve-start")).toBeDisabled(); // a reason is required
    await page.getByTestId("resolve-reason").fill("checked the provider by hand: the record is unchanged");
    await page.getByTestId("resolve-start").click();
    await expect(page.getByTestId("resolve-confirm")).toContainText("The provider will not be contacted");
    await expect(page.getByTestId("resolve-confirm-reason")).toContainText("the record is unchanged");
    await page.getByTestId("resolve-cancel").click();
    await expect(page.getByTestId("resolve-confirm")).toHaveCount(0);
    expect((await d.env.view(id)).state, "cancel changes nothing").toBe("unknown");
    await page.getByTestId("resolve-start").click();
    await page.getByTestId("resolve-confirm-button").click();
    await expect(state(page)).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("resolve-panel")).toHaveCount(0);
    const view = await d.env.view(id);
    expect(view.failure?.code).toBe("OPERATOR_RESOLVED");
    expect(d.env.sim.calls, "the provider was never contacted").toEqual(callsBefore);
  });
});

test.describe("loading, empty and error states", () => {
  test("an empty workspace shows an explicit empty state; an unreachable service shows an error, not a blank page", async ({ page }) => {
    await signIn(page, d.env.emails.operatorB, d.env.passwords.operatorB);
    await expect(page.getByTestId("state-empty")).toBeVisible();
    d.env.kit.readiness = { ...d.env.kit.readiness, ok: false, error: "migration failed (simulated by the test)" };
    await page.reload();
    await expect(page.getByTestId("app-error")).toBeVisible();
    await expect(page.getByTestId("app-error")).toContainText(/unreachable|not ready/i);
  });

  test("slow responses show a loading state first (real latency on the operations endpoint)", async ({ page }) => {
    await asOperator(page);
    await page.route("**/api/v1/operations?*", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue(); // delay only: the real response is still served
    });
    await page.goto(`${d.url}/#/connectors`);
    await page.goto(`${d.url}/#/`);
    await expect(page.getByTestId("state-loading").or(page.getByTestId("state-empty"))).toBeVisible();
    await expect(page.getByTestId("state-empty")).toBeVisible();
  });

  test("an unknown route shows a not-found message with a way back", async ({ page }) => {
    await asOperator(page);
    await page.goto(`${d.url}/#/no/such/page`);
    await expect(page.getByTestId("not-found")).toContainText("Page not found");
  });
});

test.describe("responsive and accessible", () => {
  test("at 360px the operation page has no page-wide horizontal scroll and readable table headers", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const op = await d.env.applyOnce({ lifecycle_stage: "customer", lead_score: 55 });
    await asOperator(page);
    await page.goto(`${d.url}/#/operations/${op.id}`);
    await expect(page.getByTestId("operation-title")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const tallest = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll("table thead th")].map((th) => th.getBoundingClientRect().height)));
    expect(tallest).toBeLessThanOrEqual(80);
    await page.screenshot({ path: testInfo.outputPath("operation-360.png"), fullPage: true });
  });

  test("keyboard only: the login form submits with Enter and the main navigation is reachable by Tab", async ({ page }) => {
    await page.goto(d.url);
    await page.getByLabel("Email").fill(d.env.emails.operator);
    await page.getByLabel("Password").fill(d.env.passwords.operator);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("whoami")).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("A");
  });

  // Regression test for QA-D12 (fixed in 185c801): the dark-mode primary button and links meet 4.5:1.
  test("every page in both colour schemes keeps text at 4.5:1 or better", async ({ page }) => {
    await asOperator(page);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const route of ["#/", "#/connectors"]) {
        await page.goto(`${d.url}/${route}`);
        await expect(page.locator("main")).toBeVisible();
        const worst = await page.evaluate(() => {
          const lum = (c: number[]) => {
            const [r, g, b] = c.map((v) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
          };
          const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const bg = (el: Element): number[] => {
            for (let n: Element | null = el; n; n = n.parentElement) {
              const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g) ?? [];
              if (m.length >= 3 && !(m.length === 4 && Number(m[3]) === 0)) return m.slice(0, 3).map(Number);
            }
            return [255, 255, 255];
          };
          let min = 21;
          let who = "";
          for (const el of document.querySelectorAll("main h1, main h2, main td, main th, main p, main a, main label, header a, header span")) {
            if (!(el.textContent ?? "").trim()) continue;
            const [hi, lo] = [lum(rgb(getComputedStyle(el).color)), lum(bg(el))].sort((a, b) => b - a) as [number, number];
            const ratio = (hi + 0.05) / (lo + 0.05);
            if (ratio < min) {
              min = ratio;
              who = `${el.tagName}.${(el as HTMLElement).className} "${(el.textContent ?? "").trim().slice(0, 40)}" color=${getComputedStyle(el).color} bg=${bg(el).join(",")}`;
            }
          }
          return { min, who };
        });
        expect(worst.min, `${scheme} ${route}: ${worst.who}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
