// Outbound-network denial preload (QA-owned).
//
// Use with: NODE_OPTIONS="--require <path>/deny-outbound.cjs" UNDOKIT_DENY_LOG=<file>
// Every attempt to open a non-loopback socket, resolve a non-loopback name, or call fetch to a non-loopback
// URL is recorded to UNDOKIT_DENY_LOG (one JSON line each) and then rejected.
// Loopback (localhost, 127.0.0.0/8, ::1) stays allowed because the daemon and tests talk to localhost.
//
// This is a harness for the AC-08 "outbound-denied" test. It is deliberately independent of product code.
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");

const logFile = process.env.UNDOKIT_DENY_LOG;

function record(kind, target) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${JSON.stringify({ kind, target: String(target) })}\n`);
  } catch {
    // never let logging mask the denial
  }
}

function isLoopback(host) {
  if (host === undefined || host === null || host === "") return true; // unix sockets, pipes, ephemeral listen
  const h = String(host).toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h) || h === "::ffff:127.0.0.1";
}

function denied(kind, target) {
  record(kind, target);
  const err = new Error(`outbound network denied by harness: ${kind} ${target}`);
  err.code = "UNDOKIT_OUTBOUND_DENIED";
  return err;
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  const first = args[0];
  let host;
  if (first && typeof first === "object" && !Array.isArray(first)) {
    if (first.path) return origConnect.apply(this, args);
    host = first.host;
  } else if (typeof first === "number") {
    host = typeof args[1] === "string" ? args[1] : undefined;
  } else if (typeof first === "string") {
    return origConnect.apply(this, args); // unix socket path
  }
  if (isLoopback(host)) return origConnect.apply(this, args);
  const err = denied("connect", host);
  process.nextTick(() => this.destroy(err));
  return this;
};

const origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  if (isLoopback(hostname)) return origLookup.call(dns, hostname, ...rest);
  const cb = rest[rest.length - 1];
  const err = denied("dns.lookup", hostname);
  if (typeof cb === "function") return process.nextTick(cb, err);
  throw err;
};

if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    } catch {
      return Promise.reject(denied("fetch", String(input)));
    }
    if (isLoopback(url.hostname)) return origFetch.call(globalThis, input, init);
    return Promise.reject(denied("fetch", url.origin));
  };
}
