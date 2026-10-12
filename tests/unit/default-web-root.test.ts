import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultWebRoot } from "../../src/server.js";

const made: string[] = [];
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "undokit-webroot-"));
  made.push(root);
  return root;
}
function page(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><div id=\"root\"></div>");
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("defaultWebRoot (where the daemon looks for the built UI)", () => {
  it("walks up from the compiled or source location to the first dist/web with an index.html", () => {
    const root = tree();
    page(join(root, "dist", "web"));
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    expect(defaultWebRoot(join(root, "a", "b", "c"))).toBe(join(root, "dist", "web"));
    expect(defaultWebRoot(root)).toBe(join(root, "dist", "web"));
  });

  it("never treats a sibling web directory (the Vite source root with its dev index) as the UI", () => {
    const root = tree();
    page(join(root, "web"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(defaultWebRoot(join(root, "a", "b"))).toBeUndefined();
    expect(defaultWebRoot(root)).toBeUndefined();
  });

  it("prefers the built UI when both exist, and finds nothing when there is no build", () => {
    const root = tree();
    page(join(root, "web"));
    page(join(root, "dist", "web"));
    expect(defaultWebRoot(root)).toBe(join(root, "dist", "web"));
    expect(defaultWebRoot(tree())).toBeUndefined();
  });

  it("an empty dist/web without an index.html is not a UI root", () => {
    const root = tree();
    mkdirSync(join(root, "dist", "web"), { recursive: true });
    expect(defaultWebRoot(root)).toBeUndefined();
  });
});
