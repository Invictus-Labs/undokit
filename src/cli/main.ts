#!/usr/bin/env node
import { processStreams, promptSecret, readStdin } from "./io.js";
import { run } from "./run.js";

let stop: () => void = () => undefined;
const stopped = new Promise<void>((resolve) => {
  stop = resolve;
});
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());

const code = await run(process.argv.slice(2), {
  ...processStreams,
  env: process.env,
  stdin: () => readStdin(),
  isTTY: Boolean(process.stdin.isTTY),
  prompt: promptSecret,
  waitForStop: () => stopped,
});
process.exitCode = code;
