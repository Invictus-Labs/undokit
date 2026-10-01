// Child process for the data-directory lock race test: waits for a shared start time, then tries to take the lock on <dbDir>.
// Prints WIN (and holds the lock for holdMs) or REFUSED:<message>. Run with tsx.
import { acquireDataLock } from "../../src/cli/kit.js";

const [dbUrl, startAt, holdMs] = process.argv.slice(2) as [string, string, string];
while (Date.now() < Number(startAt)) {
  /* busy-wait so every racer calls acquireDataLock within the same few milliseconds */
}
try {
  const release = acquireDataLock(dbUrl);
  process.stdout.write("WIN\n");
  setTimeout(() => {
    release();
    process.exit(0);
  }, Number(holdMs));
} catch (error) {
  process.stdout.write(`REFUSED:${(error as Error).message}\n`);
  process.exit(0);
}
