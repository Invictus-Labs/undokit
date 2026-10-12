import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "../domain/errors.js";

/** Default outbound allowlist: loopback only. The core has no other outbound network. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];

const LOOPBACK_V4 = /^127\./;

export function isLoopbackAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_V4.test(a) || a === "::1" || a === "0:0:0:0:0:0:0:1" || a === "::ffff:127.0.0.1";
}

function isLinkLocalOrMetadata(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  return a.startsWith("169.254.") || a.startsWith("fe80:") || a === "0.0.0.0" || a === "::";
}

function hostMatches(allowed: readonly string[], host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return allowed.some((entry) => entry.replace(/^\[|\]$/g, "").toLowerCase() === h);
}

export interface OutboundCheck {
  url: URL;
}

/**
 * Validate a connector base URL against the operator's outbound allowlist (SSRF guard):
 * http(s) only, no embedded credentials, host must be allowlisted by name, and every address it
 * resolves to must be loopback unless the operator allowlisted a non-loopback host explicitly
 * (link-local and metadata ranges are never reachable unless that literal IP is allowlisted).
 * Redirects are never followed by the connectors themselves (see couchdb.ts), so a redirect cannot
 * move a request to a different host after this check.
 */
export async function assertOutboundAllowed(
  rawUrl: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<OutboundCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("VALIDATION_FAILED", "connector base_url is not a valid URL", [{ code: "OUTBOUND_URL_INVALID", field: "base_url", message: "invalid URL" }]);
  }
  const reject = (message: string): never => {
    throw new AppError("VALIDATION_FAILED", message, [{ code: "OUTBOUND_HOST_NOT_ALLOWED", field: "base_url", message }]);
  };
  if (url.protocol !== "http:" && url.protocol !== "https:") reject("connector base_url must use http or https");
  if (url.username || url.password) reject("connector base_url must not embed credentials");
  const host = url.hostname;
  if (!hostMatches(allowedHosts, host)) reject("connector host is not in the outbound allowlist");
  const explicitLiteral = isIP(host.replace(/^\[|\]$/g, "")) !== 0;
  const addresses = explicitLiteral ? [host.replace(/^\[|\]$/g, "")] : await resolve(host).catch(() => []);
  if (addresses.length === 0) reject("connector host did not resolve");
  const loopbackOnly = allowedHosts.every((h) => isLoopbackAddress(h) || h === "localhost");
  for (const address of addresses) {
    if (isLinkLocalOrMetadata(address) && !hostMatches(allowedHosts, address)) reject("connector host resolves to a blocked address range");
    if (loopbackOnly && !isLoopbackAddress(address)) reject("connector host does not resolve to a loopback address");
  }
  return { url };
}

async function defaultResolve(host: string): Promise<string[]> {
  const res = await lookup(host, { all: true });
  return res.map((r) => r.address);
}
