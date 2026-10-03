// In-process daemon for browser tests (QA-owned): the real Fastify server, the real worker polling the real database,
// the built web UI served from dist/web. Running in-process lets tests plant provider-side edits through the simulator
// while a real browser drives the UI. No route mocking anywhere.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildServer, createWorker } from "../../src/index.js";
import { REPO_ROOT } from "./fixtures.js";
import { makeEnv, type Env, type EnvOptions } from "./kit.js";

export interface Daemon {
  env: Env;
  url: string;
  close(): Promise<void>;
}

export async function startDaemon(opts: EnvOptions & { worker?: boolean } = {}): Promise<Daemon> {
  const webRoot = join(REPO_ROOT, "dist", "web");
  if (!existsSync(join(webRoot, "index.html"))) throw new Error("dist/web is missing: run `npm run build` before the browser tests");
  const env = await makeEnv(opts);
  const app = await buildServer(env.kit, { webRoot });
  // `worker: false` leaves approved jobs queued so a test can show queued/in-flight states and run the worker itself.
  const stop = opts.worker === false ? () => undefined : createWorker(env.kit, { workerId: "daemon-worker" }).start(50);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    env,
    url,
    async close() {
      stop();
      await app.close();
      await env.close();
    },
  };
}
