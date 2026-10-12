# Human drill: synthetic smoke for a first-time operator

Purpose: prove that a person who did not build UndoKit can install it and run the synthetic smoke using only
the written documentation. This is the evidence for acceptance criterion AC-11. Only a human receipt
satisfies it. A run by an automated agent is **supplemental only** and must be labelled as such; it never
changes the AC-11 status, which stays `PENDING_HUMAN_RECEIPT` until a human receipt exists.

Time budget: about 30 minutes including install. No account, credential, paid service or telemetry is
involved. Everything here is synthetic.

## Rules for the participant and the observer

- The participant must not be an author of UndoKit.
- The observer may only answer questions after the participant has tried to solve them from the documents.
  Every answer, hint or fix is an **assistance event** and goes in the assistance log (Part C).
- Do not skip a failing step. Record the exact output and continue only if the document says to.
- Use only the commands in this document. Run them in a new, empty directory.

## Part A: before you start

You need a terminal, Node.js 22.12 or newer, and the three files the maintainer sends you, built by
`bash scripts/make-drill-kit.sh <dir>` from one committed revision:

- `undokit-0.1.0.tgz` (the tarball),
- `undokit-0.1.0.tgz.sha256` (its checksum, in `shasum` format),
- `DRILL-KIT.txt` (the git revision, the tarball name and the full sha256). Check that the sha256 you compute in
  Step 2 equals the one in `DRILL-KIT.txt`, and copy its first 12 characters into the receipt.

(Or a source checkout built with `npm ci && npm run build`, replacing `npx undokit` below with
`node <path-to-checkout>/dist/src/cli/main.js`. A source checkout is a weaker test of the install.)

Start the timing log. Run this line, then run the same line again at the start and end of every step:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ | tee -a drill-log.txt
```

Create the working directory first:

```bash
mkdir undokit-drill && cd undokit-drill
date -u +%Y-%m-%dT%H:%M:%SZ | tee -a drill-log.txt
```

## Part B: steps

For each step write down: start time, end time, the actual exit code (`echo $?` right after the command),
and PASS or FAIL against the expectation. Expected results describe behavior, not exact wording.

### Step 1: check Node

```bash
node --version
```

Expect: a version `v22.12.0` or higher. Exit code 0. If lower, stop and record FAIL.

Typical output: `v26.8.1` (any version at or above `v22.12.0` is fine).

### Step 2: verify the download checksum

Place the release files next to the working directory (one level up), then:

```bash
shasum -a 256 -c ../undokit-0.1.0.tgz.sha256
```

Expect: `OK` for the tarball, exit code 0. Any mismatch: stop, record FAIL.

Typical output: `../undokit-0.1.0.tgz: OK`. Also run `shasum -a 256 ../undokit-0.1.0.tgz` and compare the hash with the
one in `DRILL-KIT.txt`.

### Step 3: install

```bash
npm install ../undokit-0.1.0.tgz
npx undokit version
```

Expect: install finishes without errors (npm needs network access to fetch dependencies at install time only;
UndoKit itself makes no network calls). `version` prints `0.1.0`. Exit code 0.

Typical output: `added 86 packages` (the number can differ) and no `npm error` lines; then `0.1.0`.
npm `WARN` lines about deprecated packages are not a failure; record them.

### Step 4: read the help

```bash
npx undokit --help
```

Expect: the command list (`demo`, `serve`, `admin bootstrap`, `report`, `export`, `verify`, `import`,
`version`) and an exit code table. Exit code 0.

Typical output starts with `undokit - recover an approved CRM field change without overwriting later work`, then
`Usage: undokit <command> [flags]`, the command list, `Global flags`, and `Exit codes` (0 to 5).

### Step 5: run the synthetic demo

```bash
npx undokit demo --out ./out
echo "exit=$?"
```

Expect, as facts rather than wording:

- Exit code 0.
- A summary is printed. It shows at least one record whose compensation was restored and at least one
  record whose compensation was **blocked** because a later edit by someone else was kept.
- The files `out/report.html` and `out/evidence.json` exist (`ls out`).

Record the time the command took (about 1 to 6 seconds).

Typical output (abbreviated): it starts with `UndoKit demo: synthetic data, built-in simulator (not a live provider), no
network`, shows four numbered scenarios, ends with `Checks: 7/7 passed`, then `Wrote out/report.html`,
`Wrote out/evidence.json`. In scenario 2 you should see `compensation plan: conflict - blocked: VERSION_CHANGED` and
`compensate: COMPENSATION_BLOCKED - nothing was written; the later edit is preserved`.

### Step 6: read the report

Open `out/report.html` in a web browser (for example `open out/report.html` on macOS or
`xdg-open out/report.html` on Linux).

Expect, by eye:

- The page opens with no network access needed and shows tables, not a blank page.
- One operation shows `Compensated` (original value restored) with its fields restored.
- One operation shows `Compensation blocked` (or a conflict) and states that the later edit was kept.
- No operation is shown as successful when its outcome is unknown or blocked.

Answer in the receipt: in your own words, what happened to the later edit, and why was it not overwritten?

### Step 7: verify the evidence

```bash
npx undokit verify ./out/evidence.json
echo "exit=$?"
```

Expect: exit code 0 and a message that hashes match.

Typical output: `Verified ./out/evidence.json`, a `bundle_id`, `schema 1`, `files 3`, a `bundle_hash`, then
`All content hashes match.`

### Step 8: prove that damage is detected

```bash
head -c 1000 ./out/evidence.json > ./out/truncated.json
npx undokit verify ./out/truncated.json
echo "exit=$?"
```

Expect: a non-zero exit code (1 or 4) and a message that the bundle is truncated or invalid. Nothing is
imported. Record the exit code you saw.

Typical output: `undokit: bundle is not valid JSON (it may be truncated)` and `Nothing was changed.`, exit code 1.

### Step 9: restore into a clean installation

```bash
npx undokit import ./out/evidence.json --data-dir ./fresh-data
echo "exit=$?"
npx undokit report --data-dir ./fresh-data --out ./fresh-report.html
echo "exit=$?"
```

Expect: the import exits 0. The report command exits 0 or 5 (5 means the report is written and lists
unresolved or blocked outcomes, which this scenario contains on purpose). `fresh-report.html` exists and
shows the same operations as `out/report.html`.

Typical output: `Imported ./out/evidence.json` (exit 0); then `Report written to ./fresh-report.html`, `operations 3`,
`need attention 1`, `- contact-0002: applied (compensation conflict)` (exit 5, as intended).

### Step 10: finish and clean up

```bash
date -u +%Y-%m-%dT%H:%M:%SZ | tee -a drill-log.txt
cd ..
```

Keep `undokit-drill/drill-log.txt` until the receipt is filed, then delete the directory:

```bash
rm -r undokit-drill
```

Expect: the directory is gone (`ls undokit-drill` reports that it does not exist).

### Cleanup receipt

After Step 10, paste the output of these two commands into the receipt (they prove the directory is gone and
nothing was left running):

```bash
ls undokit-drill 2>&1 | head -1
pgrep -fl "undokit" || echo "no undokit process running"
```

Expect: `ls: undokit-drill: No such file or directory` (wording differs by system) and
`no undokit process running`. This drill starts no daemon, so there is nothing to stop.

## Part C: assistance log

Fill one row for every time anyone helped, including "I looked it up elsewhere". Zero rows is a valid and
valuable result.

| # | Step | Time (UTC) | Who helped | What was asked | What was said or done | Doc fix needed |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

## Part D: receipt template

Copy this block into the evidence record. Do not edit it afterwards.

```text
UndoKit human drill receipt
Participant (name or handle): ______________   Not an author of UndoKit: yes / no
Observer: ______________
Operating system and Node version: ______________
UndoKit version and tarball sha256 prefix (first 12): ______________
Start (UTC): ______________   End (UTC): ______________   Total minutes: ____

Step results (exit code seen / PASS or FAIL / start-end UTC):
 1 node version:       ____ / ____ / ____
 2 checksum:           ____ / ____ / ____
 3 install + version:  ____ / ____ / ____
 4 help:               ____ / ____ / ____
 5 demo:               ____ / ____ / ____   seconds: ____
 6 report read:        PASS / FAIL         Answer to the question in Step 6: ______________
 7 verify:             ____ / ____ / ____
 8 damage detected:    ____ / ____ / ____
 9 import + report:    ____ / ____ / ____
10 cleanup done:       yes / no   Directory removed: yes / no

Assistance events (count): ____   (details in the assistance log)
Documentation problems found: ______________
Overall: completed unaided / completed with help / not completed
Participant signature or handle and date (UTC): ______________
```

## Part E1: what the participant must send back (one page)

Send the maintainer exactly these items. Missing items keep AC-11 open.

1. The filled receipt block from Part D (every field, including the answer to the Step 6 question).
2. `drill-log.txt` from the working directory (the timestamps you recorded).
3. For each step, the exact terminal output you saw, copied as text (not a screenshot), including the exit code line.
   For Step 5 also send `out/evidence.json`'s `shasum -a 256` (`shasum -a 256 out/evidence.json`).
4. The assistance log (Part C), even if it is empty, with the sentence "no assistance events" when it is.
5. The cleanup receipt (output of the two commands above).
6. The operating system and Node version, and the 12-character sha256 prefix from `DRILL-KIT.txt`.
7. Anything in the documents that was unclear, wrong or missing, in your own words, even if you worked around it.
8. A sentence confirming you are not an author of UndoKit.

Do not send passwords, tokens or personal data; none are needed. Everything in this drill is synthetic.

## Part E: what happens with the receipt

- A human receipt with every step PASS is what moves AC-11 out of `PENDING_HUMAN_RECEIPT`. The maintainer
  records it in `docs/qa/AC-MATRIX.md` together with the date, the revision tested and a link or copy of the
  receipt.
- A receipt with any FAIL, or with assistance events that exposed a documentation gap, keeps AC-11 open and
  produces documentation fixes. Re-run the drill with a different participant after the fix.
- Runs by automated agents may be filed as supplemental evidence under `docs/qa/` and must be labelled
  `SUPPLEMENTAL (agent run, not a human receipt)`.
