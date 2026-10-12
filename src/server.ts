import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./api/server.js";
import { loadConfig, resolveKeyRingChecked, type ServerConfig } from "./config.js";
import { createUndoKit, type UndoKit, type UndoKitOptions } from "./context.js";
import { createWorker } from "./workers/worker.js";

export interface RunningServer {
  app: FastifyInstance;
  kit: UndoKit;
  url: string;
  close(): Promise<void>;
}

/**
 * Find the built web UI by walking up from `fromDir` to the first `dist/web/index.html` (the package root holds
 * it for both the source tree and the compiled `dist/src` layout). The Vite source root `src/web` is never a
 * candidate: its index.html is the unbuilt dev page.
 */
export function defaultWebRoot(fromDir: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = fromDir;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "dist", "web");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * Start the API, the in-process worker and (when built) the web UI. A failed migration does not stop
 * the process: /health answers, /ready returns 503 and every other route refuses with NOT_READY.
 */
export async function startServer(config: ServerConfig = loadConfig(), overrides: Partial<UndoKitOptions> = {}): Promise<RunningServer> {
  const keyring = overrides.keyring ?? (await resolveKeyRingChecked(config));
  const kit = await createUndoKit({ databaseUrl: config.databaseUrl, keyring, config: config.service, ...overrides });
  const app = await buildServer(kit, { cookieSecure: config.cookieSecure, trustProxy: config.trustProxy, webRoot: config.webRoot ?? defaultWebRoot() });
  const stopWorker = config.runWorker && kit.readiness.ok ? createWorker(kit).start(config.workerPollMs, (err) => app.log.error({ msg: err instanceof Error ? err.message.slice(0, 200) : "worker error" })) : undefined;
  const address = await app.listen({ host: config.host, port: config.port });
  return {
    app,
    kit,
    url: address,
    async close() {
      stopWorker?.();
      await app.close();
      await kit.close();
    },
  };
}
