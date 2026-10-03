import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { AppError } from "../domain/errors.js";

/** Separate sub-keys per data class, derived from one operator-managed master key held outside the database. */
export type KeyPurpose = "field-snapshot" | "connector-credentials" | "conflicts" | "field-hash";

export interface Envelope {
  v: 1;
  alg: "aes-256-gcm";
  kid: string;
  iv: string;
  ct: string;
  tag: string;
}

const MASTER_BYTES = 32;

export class KeyRing {
  private readonly subkeys = new Map<KeyPurpose, Buffer>();
  readonly keyId: string;

  constructor(private readonly master: Buffer) {
    if (master.length !== MASTER_BYTES) throw new Error(`encryption key must be ${MASTER_BYTES} bytes (base64 encoded)`);
    this.keyId = createHash("sha256").update(master).digest("hex").slice(0, 8);
  }

  /** `value` is the base64 text of 32 random bytes (see generateKeyText). */
  static fromBase64(value: string): KeyRing {
    const buf = Buffer.from(value.trim(), "base64");
    if (buf.length !== MASTER_BYTES) throw new Error(`encryption key must decode to ${MASTER_BYTES} bytes`);
    return new KeyRing(buf);
  }

  /** Read a key file; refuses a file readable by group/other (owner-only, like an SSH key). */
  static fromFile(path: string): KeyRing {
    const stat = statSync(path);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("encryption key file must be owner-only (chmod 600)");
    }
    return KeyRing.fromBase64(readFileSync(path, "utf8"));
  }

  static generateKeyText(): string {
    return randomBytes(MASTER_BYTES).toString("base64");
  }

  /** Create a new owner-only key file; never overwrites an existing one. */
  static writeNewKeyFile(path: string): void {
    writeFileSync(path, `${KeyRing.generateKeyText()}\n`, { mode: 0o600, flag: "wx" });
  }

  private key(purpose: KeyPurpose): Buffer {
    let key = this.subkeys.get(purpose);
    if (!key) {
      key = Buffer.from(hkdfSync("sha256", this.master, Buffer.from("undokit/v1"), Buffer.from(`undokit/${purpose}/v1`), 32));
      this.subkeys.set(purpose, key);
    }
    return key;
  }

  /** Keyed hash (`sha256:<hex>`) so low-entropy sensitive values cannot be brute-forced from a stored hash. */
  keyedHash(purpose: KeyPurpose, data: string): string {
    return `sha256:${createHmac("sha256", this.key(purpose)).update(data).digest("hex")}`;
  }

  /** `aad` binds the ciphertext to its row/column so a value cannot be swapped between rows. */
  encryptJson(purpose: KeyPurpose, value: unknown, aad: string): Envelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(purpose), iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { v: 1, alg: "aes-256-gcm", kid: this.keyId, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

  decryptJson<T = unknown>(purpose: KeyPurpose, envelope: Envelope, aad: string): T {
    if (envelope.v !== 1 || envelope.alg !== "aes-256-gcm") throw new AppError("INTERNAL_ERROR", "unsupported encryption envelope");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key(purpose), Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const pt = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
      return JSON.parse(pt.toString("utf8")) as T;
    } catch {
      throw new AppError("INTERNAL_ERROR", "stored data could not be decrypted (wrong key or tampered row)");
    }
  }
}
