import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  exportBundle,
  getImport,
  importBundle,
  listImports,
  verifyBundleText,
  type EvidenceBundle,
} from "../../src/index.js";
import { reportInputFromBundle } from "../../src/report/from-bundle.js";
import { renderReport } from "../../src/report/render.js";
import { leakedNeedles, loadHostile, loadSecrets } from "../helpers/fixtures.js";
import { makeEnv, rejection, type Env } from "../helpers/kit.js";

let env: Env;
let clean: Env;
beforeEach(async () => {
  env = await makeEnv();
  clean = await makeEnv();
});
afterEach(async () => {
  await env.close();
  await clean.close();
});

async function seedEvidence(): Promise<{ text: string; bundle: EvidenceBundle; ids: string[] }> {
  const a = await env.applyOnce({ lifecycle_stage: "customer" });
  const b = await env.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
  await env.compensateOnce(a.id);
  const bundle = await exportBundle(env.kit, env.operator, {});
  return { text: JSON.stringify(bundle), bundle, ids: [a.id, b.id] };
}

const stateOf = async (e: Env) => ({ imports: await e.count("evidence_imports"), ops: await e.count("operations"), events: await e.count("evidence_events") });

describe("AC-10 portability and corruption", () => {
  it("happy: export then verify passes and every file hash matches its manifest entry", async () => {
    const { text, bundle } = await seedEvidence();
    const verified = verifyBundleText(text);
    expect(verified.bundle_hash).toBe(bundle.bundle_hash);
    expect(bundle.redacted).toBe(true);
    expect(bundle.complete).toBe(true);
    expect(bundle.manifest.file_count).toBe(2);
    for (const entry of bundle.manifest.files) expect(contentHash(bundle.files[entry.path])).toBe(entry.sha256);
    expect(Object.keys(JSON.parse(text)).at(-1)).toBe("complete");
  });

  it("happy: a clean installation imports the bundle and reads back identical content and hashes, creating no operations", async () => {
    const { text, bundle } = await seedEvidence();
    const before = await stateOf(clean);
    const res = await importBundle(clean.kit, clean.operator, text);
    expect(res.replayed).toBe(false);
    expect(res.bundle_hash).toBe(bundle.bundle_hash);
    expect(res.file_count).toBe(2);
    const stored = await getImport(clean.kit, clean.operator, res.import_id);
    expect(stored).toEqual(bundle);
    expect(verifyBundleText(JSON.stringify(stored)).bundle_hash).toBe(bundle.bundle_hash);
    const after = await stateOf(clean);
    expect(after.imports).toBe(before.imports + 1);
    expect(after.ops).toBe(before.ops); // imported evidence is read-only history, not live operations
    const html = renderReport(reportInputFromBundle(stored, "imported bundle (synthetic)"));
    expect(html).toContain(bundle.bundle_hash);
    expect((await listImports(clean.kit, clean.operator, {})).items).toHaveLength(1);
  });

  it("importing the same bundle twice is a replay: one stored import", async () => {
    const { text } = await seedEvidence();
    const a = await importBundle(clean.kit, clean.operator, text);
    const b = await importBundle(clean.kit, clean.operator, text);
    expect(b.replayed).toBe(true);
    expect(b.import_id).toBe(a.import_id);
    expect(await clean.count("evidence_imports")).toBe(1);
  });

  it("export is deterministic for fixed data and clock apart from the bundle id", async () => {
    await seedEvidence();
    const one = await exportBundle(env.kit, env.operator, {});
    const two = await exportBundle(env.kit, env.operator, {});
    expect(two.files).toEqual(one.files);
    expect(two.manifest).toEqual(one.manifest);
    expect(two.bundle_id).not.toBe(one.bundle_id);
  });

  it("a subset export contains only the requested operations", async () => {
    const { ids } = await seedEvidence();
    const only = await exportBundle(env.kit, env.operator, { operation_ids: [ids[0]!] });
    expect(Object.keys(only.files)).toEqual([`operations/${ids[0]}.json`]);
  });

  describe("sad: corrupt bundles fail with a typed error and leave zero accepted rows", () => {
    async function expectRejected(text: string, code: string) {
      const before = await stateOf(clean);
      const err = await rejection(() => importBundle(clean.kit, clean.operator, text));
      expect(err.code).toBe(code);
      expect(await stateOf(clean)).toEqual(before);
      return err;
    }

    it("truncated at half length", async () => {
      const { text } = await seedEvidence();
      await expectRejected(text.slice(0, Math.floor(text.length / 2)), "BUNDLE_MALFORMED");
    });

    it("truncated one byte short (the completion marker is the last key)", async () => {
      const { text } = await seedEvidence();
      await expectRejected(text.slice(0, -1), "BUNDLE_MALFORMED");
    });

    it("a flipped value inside an evidence file (hash mismatch)", async () => {
      const { text } = await seedEvidence();
      const tampered = text.replace('"contact-0001"', '"contact-0009"');
      expect(tampered).not.toBe(text);
      const err = await expectRejected(tampered, "BUNDLE_INTEGRITY_FAILED");
      expect(JSON.stringify(err.details)).toMatch(/HASH_MISMATCH|PATH_ID_MISMATCH|SIZE_MISMATCH/);
    });

    it("an altered bundle_hash", async () => {
      const { bundle } = await seedEvidence();
      await expectRejected(JSON.stringify({ ...bundle, bundle_hash: `sha256:${"f".repeat(64)}` }), "BUNDLE_INTEGRITY_FAILED");
    });

    it("an altered event in the hash chain is detected even if the file hash is recomputed by the attacker", async () => {
      const { bundle } = await seedEvidence();
      const forged = structuredClone(bundle);
      const path = Object.keys(forged.files)[0]!;
      const doc = forged.files[path]!;
      doc.events[1]!.payload = { ...doc.events[1]!.payload, plan_hash: `sha256:${"9".repeat(64)}` };
      const entry = forged.manifest.files.find((f) => f.path === path)!;
      entry.sha256 = contentHash(doc);
      entry.bytes = Buffer.byteLength(JSON.stringify(doc));
      await rejection(() => importBundle(clean.kit, clean.operator, JSON.stringify(forged)));
      expect(await clean.count("evidence_imports")).toBe(0);
    });

    it("an unsupported schema_version", async () => {
      const { bundle } = await seedEvidence();
      await expectRejected(JSON.stringify({ ...bundle, schema_version: 2 }), "BUNDLE_UNSUPPORTED");
    });

    it("a different kind of document", async () => {
      const { bundle } = await seedEvidence();
      await expectRejected(JSON.stringify({ ...bundle, kind: "something.else" }), "BUNDLE_UNSUPPORTED");
    });

    it("a missing completion marker", async () => {
      const { bundle } = await seedEvidence();
      const { complete: _drop, ...rest } = bundle;
      await expectRejected(JSON.stringify(rest), "BUNDLE_MALFORMED");
    });

    it("not JSON, an array, null and an empty string", async () => {
      for (const text of ["{", "[]", "null", "", "   ", "\u0000", "{}"]) await expectRejected(text, text === "{}" ? "BUNDLE_UNSUPPORTED" : "BUNDLE_MALFORMED");
    });

    it("a file that is in the bundle but not in the manifest", async () => {
      const { bundle } = await seedEvidence();
      const forged = structuredClone(bundle);
      const [first] = Object.entries(forged.files);
      const extraPath = `operations/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.json`;
      forged.files[extraPath] = first![1];
      await expectRejected(JSON.stringify(forged), "BUNDLE_INTEGRITY_FAILED");
    });

    it("a manifest path that tries to escape: traversal, absolute, backslash and nested paths are all rejected by schema", async () => {
      const { bundle } = await seedEvidence();
      for (const bad of loadHostile().path_traversal_entries) {
        const forged = structuredClone(bundle);
        const entry = forged.manifest.files[0]!;
        const doc = forged.files[entry.path]!;
        delete forged.files[entry.path];
        entry.path = bad;
        forged.files[bad] = doc;
        await expectRejected(JSON.stringify(forged), "BUNDLE_MALFORMED");
      }
    });

    it("manifest counts that lie (file_count, total_bytes)", async () => {
      const { bundle } = await seedEvidence();
      const lie = structuredClone(bundle);
      lie.manifest.file_count = 99;
      await expectRejected(JSON.stringify(lie), "BUNDLE_INTEGRITY_FAILED");
      const lie2 = structuredClone(bundle);
      lie2.manifest.total_bytes += 1;
      await expectRejected(JSON.stringify(lie2), "BUNDLE_INTEGRITY_FAILED");
    });

    it("oversize: above the byte limit and above the file-count limit are refused before any parsing work or state", async () => {
      const { text, bundle } = await seedEvidence();
      expect(() => verifyBundleText(text, { maxBytes: 100 })).toThrow(/exceeds the import size limit/);
      expect(() => verifyBundleText(text, { maxFiles: 1 })).toThrow(/more than 1 files/);
      const small = await makeEnv({ config: { maxImportBytes: 1000 } });
      try {
        const err = await rejection(() => importBundle(small.kit, small.operator, text));
        expect(err.code).toBe("PAYLOAD_TOO_LARGE");
        expect(await small.count("evidence_imports")).toBe(0);
      } finally {
        await small.close();
      }
      expect(bundle.manifest.files.length).toBe(2);
    });

    it("extra top-level keys are refused (strict schema)", async () => {
      const { bundle } = await seedEvidence();
      await expectRejected(JSON.stringify({ ...bundle, injected: { x: 1 } }), "BUNDLE_MALFORMED");
    });

    it("a viewer cannot import or export, and a rejected import by anyone leaves the database untouched", async () => {
      const { text } = await seedEvidence();
      expect((await rejection(() => importBundle(clean.kit, clean.viewer, text))).code).toBe("FORBIDDEN");
      expect((await rejection(() => exportBundle(clean.kit, clean.viewer, {}))).code).toBe("FORBIDDEN");
      expect(await clean.count("evidence_imports")).toBe(0);
    });
  });

  describe("redaction in bundles (AC-09)", () => {
    it("planted secrets stored as field values never appear in the exported bundle", async () => {
      const [bearer, tokenNote] = loadSecrets().planted.filter((p) => p.kind === "pattern").map((p) => p.value) as [string, string];
      env.sim.seed("contact-0003", { lifecycle_stage: "lead", owner_label: `Bearer ${bearer}` });
      const op = await env.applyOnce({ owner_label: `see ${tokenNote}` }, { record_ref: "contact-0003" });
      const bundle = await exportBundle(env.kit, env.operator, { operation_ids: [op.id] });
      expect(leakedNeedles(JSON.stringify(bundle))).toEqual([]);
      expect(JSON.stringify(bundle)).toContain("[REDACTED]");
    });

    it("sensitive fields are redacted in every export, even for an admin, and the bundle says so", async () => {
      const e = await makeEnv({ sensitiveFields: ["owner_label"] });
      try {
        const op = await e.applyOnce({ owner_label: "alice-private-name" });
        const bundle = await exportBundle(e.kit, e.admin, { operation_ids: [op.id] });
        const text = JSON.stringify(bundle);
        expect(text).not.toContain("alice-private-name");
        expect(text).not.toContain("team-red");
        const field = Object.values(bundle.files)[0]!.operation.fields[0]!;
        expect(field.redacted).toBe(true);
        expect(field.sensitive).toBe(true);
      } finally {
        await e.close();
      }
    });

    it("a registered connector credential is scrubbed even though it has no recognisable shape", async () => {
      const secret = `${loadSecrets().planted.find((p) => p.label === "connector password")!.value}`;
      env.kit.secrets.add(secret);
      env.sim.seed("contact-0004", { lifecycle_stage: "lead", owner_label: "start" });
      const op = await env.applyOnce({ owner_label: `note ${secret} end` }, { record_ref: "contact-0004" });
      const bundle = await exportBundle(env.kit, env.operator, { operation_ids: [op.id] });
      expect(JSON.stringify(bundle)).not.toContain(secret);
    });

    it("hostile markup in field values is carried as inert data and renders as text in the report from the bundle", async () => {
      const payload = loadHostile().html_payloads[0]!.value;
      env.sim.seed("contact-0005", { lifecycle_stage: "lead", owner_label: "start" });
      const op = await env.applyOnce({ owner_label: payload }, { record_ref: "contact-0005" });
      const bundle = await exportBundle(env.kit, env.operator, { operation_ids: [op.id] });
      const html = renderReport(reportInputFromBundle(bundle, "bundle (synthetic)"));
      expect(html).not.toContain("<script>window.__undokit_pwned");
      expect(html).toContain("&lt;script&gt;");
    });
  });
});
