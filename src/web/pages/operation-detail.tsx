import { useState } from "react";
import { api, canOperate, isAdmin, mutate, type User } from "../api";
import { Async, StateBadge } from "../components";
import { useResource } from "../hooks";
import type { CompensationView, OperationView, ResolveOutcome } from "../model";
import { ApprovalsTable, AttemptsTable, CompensationSummary, FieldDiffTable, OperationExplainer } from "../Report";

const IN_FLIGHT_OPERATION = ["approved", "applying"];
const IN_FLIGHT_COMPENSATION = ["approved", "compensating"];
/** A compensation that is still open: another preview must not be stacked on top of it. */
const OPEN_COMPENSATION = ["planned", "approved", "compensating", "unknown"];

function inFlight(op: OperationView): boolean {
  return IN_FLIGHT_OPERATION.includes(op.state) || op.compensations.some((c) => IN_FLIGHT_COMPENSATION.includes(c.state));
}

function ActionError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="state-error" role="alert" data-testid="action-error">
      {message}
    </p>
  );
}

/** Wrap an API action: busy flag, error text, and a reload on both success and failure so the page never shows stale state. */
function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  };
  return { busy, error, run };
}

function ApplyApproval({ op, reload }: { op: OperationView; reload: () => void }) {
  const [reviewed, setReviewed] = useState(false);
  const action = useAction(reload);
  return (
    <section className="panel" aria-label="Approve plan" data-testid="approve-panel">
      <h2>Approve this plan</h2>
      <p>
        Approval is bound to this exact plan hash. If the plan changes or the approval expires, authorization is invalidated and nothing is written.
      </p>
      <p>
        Plan hash: <code data-testid="plan-hash">{op.plan_hash}</code>
      </p>
      <label>
        <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} data-testid="approve-confirm" /> I reviewed the field changes above and approve plan hash{" "}
        <code>{op.plan_hash.slice(0, 15)}…</code>
      </label>
      <div className="actions">
        <button type="button" disabled={!reviewed || action.busy} data-testid="approve-button" onClick={() => void action.run(() => mutate(`/operations/${op.id}/approve`, { plan_hash: op.plan_hash, expected_version: op.expected_version }))}>
          {action.busy ? "Approving…" : "Approve plan"}
        </button>
      </div>
      <ActionError message={action.error} />
    </section>
  );
}

function CompensationBlock({ op, comp, index, user, reload }: { op: OperationView; comp: CompensationView; index: number; user: User; reload: () => void }) {
  const [reviewed, setReviewed] = useState(false);
  const action = useAction(reload);
  const canApprove = canOperate(user) && comp.state === "planned" && comp.conflicts.length === 0;
  return (
    <>
      <CompensationSummary comp={comp} index={index} />
      {canApprove ? (
        <section className="panel" aria-label="Approve compensation" data-testid="compensation-approve-panel">
          <h3>Approve this compensation separately</h3>
          <p>
            This is a second, separate approval. It restores only the fields listed above, and only while the record still has the exact current values and version shown. Anything that changed in the meantime blocks the restore.
          </p>
          <p>
            Compensation plan hash: <code data-testid="compensation-plan-hash">{comp.plan_hash}</code>
          </p>
          <label>
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} data-testid="compensation-confirm" /> I reviewed the exact restore above and approve compensation plan hash{" "}
            <code>{comp.plan_hash.slice(0, 15)}…</code>
          </label>
          <div className="actions">
            <button type="button" disabled={!reviewed || action.busy} data-testid="compensate-button" onClick={() => void action.run(() => mutate(`/operations/${op.id}/compensate`, { plan_hash: comp.plan_hash }))}>
              {action.busy ? "Approving…" : "Approve compensation"}
            </button>
          </div>
          <ActionError message={action.error} />
        </section>
      ) : comp.state === "conflict" ? (
        <p className="muted" data-testid="compensation-blocked-note">
          No restore will be attempted. Create a new preview after reviewing the later edits if a restore is still wanted.
        </p>
      ) : null}
      {comp.state === "unknown" && canOperate(user) ? <ReconcileButton op={op} reload={reload} /> : null}
    </>
  );
}

/** Reconcile attempts the server has recorded so far; a new one means the reconcile job has settled. */
function reconcileAttempts(op: OperationView): number {
  return op.attempts.filter((a) => a.phase === "reconcile" && a.outcome !== "started").length;
}

const SETTLE_POLL_MS = 500;
const SETTLE_MAX_POLLS = 60;

/** Wait for the worker to record the reconcile result. Gives up quietly: the state then simply stays Unknown. */
async function waitForReconcile(opId: string, before: number): Promise<void> {
  for (let i = 0; i < SETTLE_MAX_POLLS; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    try {
      const latest = await api<OperationView>("GET", `/operations/${encodeURIComponent(opId)}`);
      if (reconcileAttempts(latest) > before) return;
    } catch {
      return;
    }
  }
}

function ReconcileButton({ op, reload }: { op: OperationView; reload: () => void }) {
  const action = useAction(reload);
  return (
    <div className="actions">
      <button
        type="button"
        disabled={action.busy}
        data-testid="reconcile-button"
        onClick={() =>
          void action.run(async () => {
            const before = reconcileAttempts(op);
            await mutate(`/operations/${op.id}/reconcile`, {});
            await waitForReconcile(op.id, before);
          })
        }
      >
        {action.busy ? "Reconciling…" : "Reconcile (read-only check)"}
      </button>
      <span className="muted">Reads the record from the provider; it never repeats the write.</span>
      <ActionError message={action.error} />
    </div>
  );
}

const RESOLVE_REASON_MAX = 500;

const RESOLVE_OPTIONS: { value: ResolveOutcome; label: string; meaning: string }[] = [
  { value: "not_applied", label: "Not applied: the change did not take effect", meaning: "You are recording that the change did not reach the provider." },
  { value: "abandoned", label: "Abandon: stop tracking this change, outcome unknown", meaning: "You are recording that this change will not be pursued; whether it reached the provider stays unknown." },
];

/**
 * Mirrors the server rule: resolving is allowed only when the latest unknown/indeterminate attempt of the target is a
 * reconcile that read the provider and ended STATE_AMBIGUOUS or RECORD_MISSING. The server stays the authority and its
 * message is shown verbatim if it disagrees.
 */
function resolveEligibility(op: OperationView): { eligible: boolean; latest: string } {
  const comp = op.state === "unknown" ? null : op.compensations.find((c) => c.state === "unknown") ?? null;
  const attempts = op.attempts
    .filter((a) => (comp ? a.compensation_id === comp.id : a.compensation_id === null) && (a.outcome === "unknown" || a.outcome === "reconciled_indeterminate"))
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  const last = attempts[attempts.length - 1];
  const eligible = last !== undefined && last.outcome === "reconciled_indeterminate" && (last.error_code === "STATE_AMBIGUOUS" || last.error_code === "RECORD_MISSING");
  return { eligible, latest: last ? (last.error_code ?? last.outcome) : "no reconcile has run" };
}

/** Administrator-only last resort for an UNKNOWN outcome that read-only reconciliation could not settle. */
function ResolvePanel({ op, reload }: { op: OperationView; reload: () => void }) {
  const [outcome, setOutcome] = useState<ResolveOutcome | "">("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const action = useAction(reload);
  const target = op.state === "unknown" ? "this operation" : "its unknown compensation";
  const chosen = RESOLVE_OPTIONS.find((o) => o.value === outcome);
  const { eligible, latest } = resolveEligibility(op);
  const ready = eligible && chosen !== undefined && reason.trim().length > 0;
  const submit = () =>
    void action.run(async () => {
      await mutate(`/operations/${op.id}/resolve`, { outcome, reason: reason.trim(), expected_version: op.expected_version });
      setConfirming(false);
      setOutcome("");
      setReason("");
    });
  return (
    <section className="panel" aria-label="Close an unresolved outcome" data-testid="resolve-panel">
      <h2>Resolve manually (administrator)</h2>
      <p data-testid="resolve-applies">
        <strong>When this applies:</strong> only after Reconcile has read the provider and could not settle {target}: the record matches neither the before nor the intended values, or the record is gone. Reconcile is the
        normal way forward and is offered above.{" "}
        {eligible ? (
          <span data-testid="resolve-eligible">The latest reconcile ended {latest}, so a manual resolution is allowed.</span>
        ) : (
          <span data-testid="resolve-not-yet">Not available yet (latest result: {latest}). Run Reconcile first; try again when the provider is readable and the quiet period has passed.</span>
        )}
      </p>
      <p data-testid="resolve-warning">
        It <strong>never writes to the provider and never checks it</strong>: it records your decision and your reason, marks {target} as failed
        (closed by an administrator), and lets new changes be planned for this record. If the provider later reports that the original write did happen, {target} reopens as Unknown.
      </p>
      <label>
        Decision
        <select
          data-testid="resolve-outcome"
          value={outcome}
          onChange={(e) => {
            setOutcome(e.target.value as ResolveOutcome | "");
            setConfirming(false);
          }}
        >
          <option value="">Select a decision</option>
          {RESOLVE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reason (required, up to {RESOLVE_REASON_MAX} characters; it is stored in the evidence with your account)
        <textarea
          data-testid="resolve-reason"
          rows={3}
          maxLength={RESOLVE_REASON_MAX}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setConfirming(false);
          }}
        />
      </label>
      {!confirming ? (
        <div className="actions">
          <button type="button" className="secondary" disabled={!ready || action.busy} data-testid="resolve-start" onClick={() => setConfirming(true)}>
            Review and confirm
          </button>
        </div>
      ) : (
        <div className="callout tone-warn" role="alert" data-testid="resolve-confirm">
          <strong>Confirm.</strong> {chosen?.meaning} The provider will not be contacted. Reason on record: <q data-testid="resolve-confirm-reason">{reason.trim()}</q>
          <div className="actions">
            <button type="button" disabled={action.busy} data-testid="resolve-confirm-button" onClick={submit}>
              {action.busy ? "Closing…" : "Close it"}
            </button>
            <button type="button" className="secondary" disabled={action.busy} data-testid="resolve-cancel" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {action.error ? (
        <p className="state-error" role="alert" data-testid="resolve-error">
          {action.error} Nothing was changed.
        </p>
      ) : null}
    </section>
  );
}

function PreviewCompensation({ op, reload }: { op: OperationView; reload: () => void }) {
  const action = useAction(reload);
  return (
    <div className="actions">
      <button type="button" disabled={action.busy} data-testid="preview-compensation-button" onClick={() => void action.run(() => mutate(`/operations/${op.id}/compensation-plans`, {}))}>
        {action.busy ? "Reading current record…" : "Preview compensation"}
      </button>
      <span className="muted">Shows exactly what would be restored and whether later edits block it. Nothing is written.</span>
      <ActionError message={action.error} />
    </div>
  );
}

export function OperationDetail({ op, user, reload }: { op: OperationView; user: User; reload: () => void }) {
  const operate = canOperate(user);
  const openComp = op.compensations.some((c) => OPEN_COMPENSATION.includes(c.state));
  return (
    <>
      <p>
        <a href="#/">Back to operations</a>
      </p>
      <h1 data-testid="operation-title">
        {op.record_ref} <StateBadge state={op.state} failureCode={op.failure?.code} />
      </h1>
      <OperationExplainer op={op} />
      {inFlight(op) ? (
        <p className="state-note" role="status" data-testid="in-flight">
          Waiting for the worker. This page refreshes automatically. If the outcome cannot be confirmed it will show as Unknown, never as success.
        </p>
      ) : null}
      <dl className="kv">
        <dt>Operation</dt>
        <dd>
          <code>{op.id}</code>
        </dd>
        <dt>Connector</dt>
        <dd data-testid="connector-info">
          {op.connector.name} ({op.connector.label})
        </dd>
        <dt>Plan hash</dt>
        <dd>
          <code>{op.plan_hash}</code>
        </dd>
        <dt>Planned against version</dt>
        <dd>
          <code>{op.expected_version}</code>
        </dd>
        <dt>Observed version after write</dt>
        <dd>
          <code>{op.observed_version ?? "not confirmed"}</code>
        </dd>
        <dt>Created (UTC)</dt>
        <dd>{op.created_at}</dd>
      </dl>

      <FieldDiffTable op={op} />

      {op.state === "planned" && operate ? <ApplyApproval op={op} reload={reload} /> : null}
      {op.state === "planned" && !operate ? (
        <p className="state-note" role="status" data-testid="viewer-note">
          Your role is viewer. Only operators and admins can approve plans.
        </p>
      ) : null}
      {op.state === "unknown" && operate ? <ReconcileButton op={op} reload={reload} /> : null}
      {op.state === "unknown" && !operate ? <p className="muted">An operator or admin must run the read-only reconciliation.</p> : null}
      {isAdmin(user) && (op.state === "unknown" || op.compensations.some((c) => c.state === "unknown")) ? <ResolvePanel op={op} reload={reload} /> : null}

      <h2>Compensation</h2>
      {op.state === "applied" || op.compensations.length > 0 ? null : (
        <p className="muted" data-testid="compensation-unavailable">
          A compensation can only be previewed after the change is applied.
        </p>
      )}
      {op.compensations.map((c, i) => (
        <CompensationBlock key={c.id} op={op} comp={c} index={i} user={user} reload={reload} />
      ))}
      {op.state === "applied" && operate && !openComp ? <PreviewCompensation op={op} reload={reload} /> : null}

      <h2>Evidence</h2>
      <ApprovalsTable op={op} />
      <AttemptsTable op={op} />
    </>
  );
}

export function OperationPage({ id, user }: { id: string; user: User }) {
  const [state, reload] = useResource<OperationView>(`/operations/${encodeURIComponent(id)}`, inFlight);
  return (
    <Async state={state} reload={reload} what="Loading operation">
      {(op) => <OperationDetail op={op} user={user} reload={reload} />}
    </Async>
  );
}
