// Browser smoke for the static HTML report (QA-owned). Real Chromium, real file:// pages, no mocks.
// Reports are rendered from synthetic fixtures into a fresh temp directory for each run.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { reportInputFromBundle } from "../../src/report/from-bundle.js";
import { renderReport } from "../../src/report/render.js";
import { makeBundle, makeCompensation, makeField, makeOperation, scenarioOperations } from "../helpers/builders.js";
import { FIXED_NOW_ISO, loadHostile, loadSecrets } from "../helpers/fixtures.js";

const dir = mkdtempSync(join(tmpdir(), "undokit-report-smoke-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, html: string): string {
  const path = join(dir, name);
  writeFileSync(path, html);
  return pathToFileURL(path).href;
}

const base = { generated_at: FIXED_NOW_ISO, data_source: "synthetic smoke data (not a live provider)" };

/** Collect everything a safe static report must never do. */
function watch(page: Page) {
  const seen = { requests: [] as string[], dialogs: [] as string[], errors: [] as string[], popups: 0 };
  page.on("request", (r) => {
    if (!r.url().startsWith("file://") && !r.url().startsWith("data:")) seen.requests.push(r.url());
  });
  page.on("dialog", async (d) => {
    seen.dialogs.push(d.message());
    await d.dismiss();
  });
  page.on("pageerror", (e) => seen.errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") seen.errors.push(m.text());
  });
  page.on("popup", () => {
    seen.popups += 1;
  });
  return seen;
}

test.describe("report smoke: scenario data", () => {
  const ops = scenarioOperations();
  const url = () => write("scenario.html", renderReport(reportInputFromBundle(makeBundle(ops), "evidence bundle (synthetic)")));

  test("tables and every outcome are visible, and the page is silent on the network", async ({ page }, testInfo) => {
    const seen = watch(page);
    await page.goto(url());
    await expect(page).toHaveTitle("UndoKit recovery report");
    await expect(page.getByTestId("report-operation")).toHaveCount(5);
    await expect(page.getByTestId("report-attention")).toBeVisible();
    await expect(page.getByTestId("report-attention")).toContainText("4 operations need attention");
    await expect(page.getByTestId("report-clear")).toHaveCount(0);
    expect(await page.locator("table").count()).toBeGreaterThan(8);
    for (const caption of await page.locator("table caption").all()) await expect(caption).toBeVisible();

    const blocked = page.getByTestId("report-compensation").filter({ hasText: "Compensation blocked" });
    await expect(blocked).toHaveCount(1);
    await expect(blocked).toContainText("later edits were left untouched");
    await expect(page.getByTestId("report-compensation").filter({ hasText: "Compensated" }).first()).toBeVisible();
    await expect(page.getByTestId("report-operation").filter({ hasText: "Unknown outcome" })).toContainText("read-only reconciliation");
    await expect(page.getByTestId("report-partial")).toBeVisible();

    // Anchors in the attention banner jump to a real section.
    const firstLink = page.getByTestId("report-attention").locator("a").first();
    const href = await firstLink.getAttribute("href");
    await firstLink.click();
    await expect(page.locator(href as string)).toBeInViewport();

    expect(seen.requests, "network requests").toEqual([]);
    expect(seen.errors, "console and page errors").toEqual([]);
    expect(seen.dialogs).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("scenario-desktop.png"), fullPage: true });
  });

  for (const width of [360, 768, 1280]) {
    test(`no page-wide horizontal scroll at ${width}px (tables scroll inside their wrapper)`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url());
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `scrollWidth - innerWidth at ${width}px`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath(`scenario-${width}.png`), fullPage: true });
      // A readable crop (first operation, top of the page) for human review of table layout at this width.
      await page.screenshot({ path: testInfo.outputPath(`scenario-${width}-crop.png`), fullPage: true, clip: { x: 0, y: 380, width, height: 1100 } });
      await page.screenshot({ path: testInfo.outputPath(`scenario-${width}-crop2.png`), fullPage: true, clip: { x: 0, y: 1480, width, height: 1100 } });
    });
  }

  // Regression test for QA-D4 (fixed in 67e05fd): at phone width table cells must not collapse to one-character columns
  // (the no-overflow test above cannot see that, because collapsed tables never overflow).
  test("table headers stay readable at 360px: no header wraps into a tall letter stack", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(url());
    const tallest = await page.evaluate(() => Math.max(...[...document.querySelectorAll("table thead th")].map((th) => th.getBoundingClientRect().height)));
    expect(tallest, "tallest table header cell in px").toBeLessThanOrEqual(80);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`body text and state badges meet 4.5:1 contrast in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(url());
      const failures = await page.evaluate(() => {
        const lum = (rgb: number[]) => {
          const [r, g, b] = rgb.map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
        };
        const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const bgOf = (el: Element): number[] => {
          for (let n: Element | null = el; n; n = n.parentElement) {
            const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g) ?? [];
            if (m.length >= 3 && !(m.length === 4 && Number(m[3]) === 0)) return m.slice(0, 3).map(Number);
          }
          return [255, 255, 255];
        };
        const bad: string[] = [];
        const probes = document.querySelectorAll("body, h1, h2, td, th, .badge, .callout, .note, .lead, caption");
        for (const el of probes) {
          if (!(el.textContent ?? "").trim()) continue;
          const fg = parse(getComputedStyle(el).color);
          const bg = bgOf(el);
          const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
          const ratio = (hi + 0.05) / (lo + 0.05);
          if (ratio < 4.5) bad.push(`${el.tagName}.${(el as HTMLElement).className} ${ratio.toFixed(2)}`);
        }
        return [...new Set(bad)];
      });
      expect(failures).toEqual([]);
    });
  }

  test("keyboard: the attention links are reachable by Tab and activate with Enter", async ({ page }) => {
    await page.goto(url());
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBe("A");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#op-/);
  });
});

test.describe("report smoke: hostile content renders as text (AC-09)", () => {
  const payloads = loadHostile().html_payloads;
  const [bearer] = loadSecrets().planted.filter((p) => p.kind === "pattern").map((p) => p.value);

  test("every hostile payload in every slot executes nothing and stays visible as text", async ({ page }, testInfo) => {
    const seen = watch(page);
    const operations = payloads.map((p, i) => {
      const op = makeOperation({
        seed: `hostile-${i}`,
        record_ref: p.value,
        failure: { code: "X", message: p.value },
        fields: [makeField({ field: p.value, before: p.value, intended: p.value, observed_after: `${p.value} ${bearer}`, provider_version: p.value })],
      });
      op.connector = { ...op.connector, name: p.value };
      op.compensations = [
        makeCompensation({
          seed: `hostile-${i}`,
          operation_id: op.id,
          state: "conflict",
          conflicts: [{ field: p.value, code: "VALUE_CHANGED", expected: p.value, actual: p.value }],
        }),
      ];
      return op;
    });
    const html = renderReport({ ...base, title: payloads[0]?.value, notes: payloads.map((p) => p.value), operations });
    await page.goto(write("hostile.html", html));
    await page.waitForLoadState("load");

    expect(await page.evaluate(() => (window as unknown as { __undokit_pwned?: string }).__undokit_pwned)).toBeUndefined();
    expect(seen.dialogs).toEqual([]);
    expect(seen.popups).toBe(0);
    expect(seen.requests, "hostile img/iframe must not fetch anything").toEqual([]);
    expect(seen.errors).toEqual([]);
    await expect(page.locator("#injected-heading")).toHaveCount(0);
    await expect(page.locator("script, img, iframe, svg, object, embed")).toHaveCount(0);
    await expect(page.locator("body")).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe("none");

    // The literal characters are what the operator sees.
    const text = await page.locator("body").innerText();
    expect(text).toContain("<script>window.__undokit_pwned");
    expect(text).toContain("{{7*7}}");
    expect(text).not.toMatch(/\b49\b/); // template expressions are never evaluated
    // The planted secret that rode along in a field value is gone from the rendered page.
    expect(text).not.toContain(bearer as string);
    expect(text).toContain("[REDACTED]");
    await page.screenshot({ path: testInfo.outputPath("hostile.png"), fullPage: true });
  });

  test("the page's own CSP blocks an inline script even if one were somehow injected", async ({ page }) => {
    const html = renderReport({ ...base, operations: [] }).replace("</main>", "<script>window.__undokit_pwned='csp-bypass'</script></main>");
    const seen = watch(page);
    await page.goto(write("csp.html", html));
    expect(await page.evaluate(() => (window as unknown as { __undokit_pwned?: string }).__undokit_pwned)).toBeUndefined();
    expect(seen.errors.join(" ")).toMatch(/Content Security Policy/i);
  });
});

test.describe("report smoke: empty and error states", () => {
  test("empty evidence shows a clear message, no tables of data and no success banner", async ({ page }) => {
    await page.goto(write("empty.html", renderReport(reportInputFromBundle(makeBundle([]), "evidence bundle (synthetic)"))));
    await expect(page.getByTestId("report-empty")).toBeVisible();
    await expect(page.getByTestId("report-empty")).toContainText("No operations in this evidence");
    await expect(page.getByTestId("report-clear")).toHaveCount(0);
    await expect(page.getByTestId("report-operation")).toHaveCount(0);
  });

  test("an error shows a next step and hides all operation data", async ({ page }) => {
    const html = renderReport({ ...base, operations: scenarioOperations(), error: "bundle hash does not match its manifest" });
    await page.goto(write("error.html", html));
    await expect(page.getByTestId("report-error")).toBeVisible();
    await expect(page.getByTestId("report-error")).toContainText("bundle hash does not match its manifest");
    await expect(page.getByTestId("report-error")).toContainText("Next step");
    await expect(page.getByTestId("report-operation")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("contact-0001");
  });
});
