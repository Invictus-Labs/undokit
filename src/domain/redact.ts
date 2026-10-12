export const REDACTED = "[REDACTED]";

/** Value patterns that look like credentials. Matches are replaced wholesale (key names kept). */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|prod|proj)?[-_]?[A-Za-z0-9_-]{12,}/gi,
  /\b(?:tok|token|key|secret|api|apikey|auth)[-_][A-Za-z0-9_-]{16,}/gi,
];

const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const KEY_VALUE =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|credential|cookie)(["']?\s*[:=]\s*["']?)[^\s"',;&}]{3,}/gi;

/** Object keys whose values are always redacted regardless of content. */
const SENSITIVE_KEY =
  /^(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|credentials?|private[_-]?key|session[_-]?token|csrf[_-]?token|x-csrf-token|access[_-]?key|client[_-]?secret|password[_-]?hash|credentials[_-]?enc)$/i;

/** Exact secrets known to this process (connector credentials, session tokens, keys). */
export class SecretRegistry {
  private readonly secrets = new Set<string>();
  private extra: RegExp[] = [];

  add(secret: string | undefined | null): void {
    if (secret && secret.length >= 4) this.secrets.add(secret);
  }

  addPattern(pattern: RegExp): void {
    this.extra.push(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
  }

  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    for (const pattern of this.extra) out = out.replace(pattern, REDACTED);
    return out;
  }
}

export function redactText(text: string, registry?: SecretRegistry): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  return registry ? registry.scrub(out) : out;
}

/** Deep-redact any JSON-like value: sensitive keys fully, every string by pattern/registry. */
export function redactDeep<T>(value: T, registry?: SecretRegistry, depth = 0): T {
  if (depth > 32) return REDACTED as unknown as T;
  if (typeof value === "string") return redactText(value, registry) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, registry, depth + 1)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) && child !== null && child !== undefined ? REDACTED : redactDeep(child, registry, depth + 1);
    }
    return out as T;
  }
  return value;
}
