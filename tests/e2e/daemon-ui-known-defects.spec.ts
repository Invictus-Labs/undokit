// Known UI defects pinned as expected failures (QA-owned). Each flips to a failure when the owner fixes it; then change
// test.fail back to test and move the case into daemon-ui.spec.ts.
import { expect, test } from "@playwright/test";
import { startDaemon, type Daemon } from "../helpers/daemon.js";

test.describe.configure({ timeout: 45_000 });

let d: Daemon;
test.beforeEach(async () => {
  d = await startDaemon();
});
test.afterEach(async () => {
  await d.close();
});

// Regression test for QA-D11 (fixed in 185c801): after Reconcile the page polls until the worker records the result, so the
// resolved state appears without a manual reload. (Kept in this file; a new known defect is pinned here with test.fail.)
test("after Reconcile the page updates by itself once the worker resolves the operation (no manual reload)", async ({ page }) => {
  d.env.sim.failNextWrite("ambiguous_after_commit");
  const op = await d.env.applyOnce({ lifecycle_stage: "customer" });
  await page.goto(d.url);
  await page.getByLabel("Email").fill(d.env.emails.operator);
  await page.getByLabel("Password").fill(d.env.passwords.operator);
  await page.getByTestId("login-submit").click();
  await page.goto(`${d.url}/#/operations/${op.id}`);
  await expect(page.getByTestId("state-explainer")).toHaveAttribute("data-state", "unknown");
  await page.getByTestId("reconcile-button").click();
  await expect(page.getByTestId("state-explainer")).toHaveAttribute("data-state", "applied", { timeout: 8_000 });
});
