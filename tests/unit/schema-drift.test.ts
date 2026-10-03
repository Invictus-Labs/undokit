import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeSchemas } from "../../src/domain/schema-gen.js";
import { HASH_PATTERN } from "../../src/domain/canonical.js";
import { REPO_ROOT } from "../helpers/fixtures.js";

const outDir = mkdtempSync(join(tmpdir(), "undokit-schema-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("shipped JSON Schemas cannot drift from the zod contract", () => {
  const written = writeSchemas(outDir);

  it("regenerating into a temp dir reproduces schemas/*.json byte for byte", () => {
    expect(written.length).toBeGreaterThanOrEqual(2);
    for (const path of written) {
      const name = path.split("/").pop() as string;
      const shipped = readFileSync(join(REPO_ROOT, "schemas", name), "utf8");
      expect(readFileSync(path, "utf8"), `${name} is stale: run node --import tsx src/domain/schema-gen.ts`).toBe(shipped);
    }
  });

  it("no shipped schema file is missing from the generator (no orphaned hand-edited files)", () => {
    const shipped = readdirSync(join(REPO_ROOT, "schemas")).filter((f) => f.endsWith(".json")).sort();
    const generated = readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
    expect(shipped).toEqual(generated);
  });

  it("schemas are draft 2020-12, declare schema_version 1 and use the documented hash pattern", () => {
    const bundle = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "evidence-bundle.json"), "utf8")) as Record<string, unknown>;
    expect(bundle.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const text = readFileSync(join(REPO_ROOT, "schemas", "evidence-bundle.json"), "utf8");
    expect(text).toContain(JSON.stringify(HASH_PATTERN.source).slice(1, -1));
    const op = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "operation.json"), "utf8")) as { schema_version: number; $defs: Record<string, unknown> };
    expect(op.schema_version).toBe(1);
    for (const def of ["CreateOperationRequest", "OperationView", "ErrorEnvelope", "StatusView", "CompensationPlanResponse"]) {
      expect(op.$defs[def], def).toBeDefined();
    }
  });

  it("the evidence bundle schema requires the trailing complete marker and a redacted flag", () => {
    const bundle = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "evidence-bundle.json"), "utf8")) as { required?: string[] };
    expect(bundle.required).toEqual(expect.arrayContaining(["complete", "redacted", "bundle_hash", "manifest", "files"]));
  });
});
