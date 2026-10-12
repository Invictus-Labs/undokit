import { attemptOutcomeLabel, compensationGuide, conflictText, fieldOutcome } from "../report/guide";
import { Badge, CompensationExplainer, EmptyState, FieldStatusBadge, StateExplainer, Value } from "./components";
import type { CompensationView, OperationView } from "./model";

/**
 * Read-only evidence views. Every value is rendered as a React text node, so
 * provider and user text (including markup) is displayed as text, never parsed.
 */

export function FieldDiffTable({ op }: { op: OperationView }) {
  if (op.fields.length === 0) return <EmptyState>No field snapshots were recorded for this operation.</EmptyState>;
  const partial = new Set(op.fields.map((f) => f.apply_outcome)).size > 1 && op.fields.length > 1;
  return (
    <>
      {partial ? (
        <p className="callout tone-warn" role="note" data-testid="partial-outcome">
          <strong>Partial outcome:</strong> fields ended in different states. Review each row; nothing here is summarised as fully successful.
        </p>
      ) : null}
      <div className="table-wrap">
        <table data-testid="field-diff">
          <caption>Field changes (outcomes are per field)</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Before</th>
              <th scope="col">Intended</th>
              <th scope="col">Observed after</th>
              <th scope="col">Apply outcome</th>
              <th scope="col">Restore outcome</th>
              <th scope="col">Provider version</th>
            </tr>
          </thead>
          <tbody>
            {op.fields.map((f) => {
              const attention = fieldOutcome(f.apply_outcome).tone === "warn" || fieldOutcome(f.apply_outcome).tone === "bad";
              return (
                <tr key={f.field} data-testid="field-row" data-field={f.field} className={attention ? "row-attention" : undefined}>
                  <th scope="row">
                    {f.field}
                    {f.redacted ? <span className="muted"> (redacted)</span> : null}
                  </th>
                  <td className="diff-before">
                    <Value value={f.before} />
                  </td>
                  <td className="diff-after">
                    <Value value={f.intended} />
                  </td>
                  <td>
                    <Value value={f.observed_after} />
                  </td>
                  <td>
                    <FieldStatusBadge status={f.apply_outcome} />
                  </td>
                  <td>{f.compensation_outcome === "pending" ? <span className="muted">none</span> : <FieldStatusBadge status={f.compensation_outcome} />}</td>
                  <td>
                    <code>{f.provider_version}</code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ApprovalsTable({ op }: { op: OperationView }) {
  if (op.approvals.length === 0) return <EmptyState>No approvals recorded.</EmptyState>;
  return (
    <div className="table-wrap">
      <table data-testid="approvals">
        <caption>Approvals (each binds a plan hash)</caption>
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Plan hash</th>
            <th scope="col">Approved at (UTC)</th>
            <th scope="col">Expires (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {op.approvals.map((a) => (
            <tr key={a.id}>
              <td>{a.phase}</td>
              <td>
                <code>{a.plan_hash}</code>
              </td>
              <td>{a.created_at}</td>
              <td>{a.expires_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AttemptsTable({ op }: { op: OperationView }) {
  if (op.attempts.length === 0) return <EmptyState>No attempts recorded yet.</EmptyState>;
  return (
    <div className="table-wrap">
      <table data-testid="attempts">
        <caption>Attempt history (append-only; failures are kept)</caption>
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Outcome</th>
            <th scope="col">At (UTC)</th>
            <th scope="col">Provider request</th>
            <th scope="col">Observed version</th>
            <th scope="col">Error code</th>
          </tr>
        </thead>
        <tbody>
          {op.attempts.map((a) => (
            <tr key={a.id} data-testid="attempt-row" data-outcome={a.outcome}>
              <td>{a.phase}</td>
              <td>{attemptOutcomeLabel(a.outcome)}</td>
              <td>{a.created_at}</td>
              <td>
                <code>{a.provider_request_id ?? ""}</code>
              </td>
              <td>
                <code>{a.observed_version ?? ""}</code>
              </td>
              <td>{a.error_code ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConflictList({ conflicts }: { conflicts: CompensationView["conflicts"] }) {
  if (conflicts.length === 0) return null;
  return (
    <div className="callout tone-warn" role="alert" data-testid="conflict-list">
      <strong>Why it is blocked or at risk</strong>
      <ul>
        {conflicts.map((c, i) => (
          <li key={`${c.field ?? "record"}-${c.code}-${i}`} data-testid="conflict-item" data-code={c.code}>
            {c.field ?? "record"}: {conflictText(c.code)} Expected <Value value={c.expected} />, found <Value value={c.actual} />.
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CompensationFieldsTable({ fields, caption }: { fields: CompensationView["fields"]; caption: string }) {
  if (fields.length === 0) return <EmptyState>No fields in this compensation.</EmptyState>;
  return (
    <div className="table-wrap">
      <table data-testid="compensation-fields">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Must currently be</th>
            <th scope="col">Would be restored to</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.field} data-testid="compensation-field-row" data-field={f.field}>
              <th scope="row">
                {f.field}
                {f.redacted ? <span className="muted"> (redacted)</span> : null}
              </th>
              <td>
                <Value value={f.expected_current} />
              </td>
              <td>
                <Value value={f.restore_to} />
              </td>
              <td>
                <FieldStatusBadge status={f.outcome} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compensation summary used in the detail page; actions are added by the caller. */
export function CompensationSummary({ comp, index }: { comp: CompensationView; index: number }) {
  const guide = compensationGuide(comp.state, comp.failure?.code);
  return (
    <div className="panel" data-testid="compensation" data-state={comp.state}>
      <h3>
        Compensation {index + 1} <Badge tone={guide.tone} testId="compensation-state">{guide.label}</Badge>
      </h3>
      <CompensationExplainer state={comp.state} failureCode={comp.failure?.code} {...(comp.failure ? { extra: `${comp.failure.code}: ${comp.failure.message}` } : {})} />
      <ConflictList conflicts={comp.conflicts} />
      <CompensationFieldsTable fields={comp.fields} caption={`Compensation preview (plan hash ${comp.plan_hash}; requires provider version ${comp.expected_version})`} />
    </div>
  );
}

/** Operation-level explanation with the recorded failure reason when there is one. */
export function OperationExplainer({ op }: { op: OperationView }) {
  return <StateExplainer state={op.state} failureCode={op.failure?.code} {...(op.failure ? { extra: `${op.failure.code}: ${op.failure.message}` } : {})} />;
}
