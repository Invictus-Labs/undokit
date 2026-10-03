import { useState } from "react";
import { download, type User, canOperate } from "../api";
import { Async, StateBadge } from "../components";
import { useResource } from "../hooks";
import type { OperationView, Page, StatusView } from "../model";
import { compensationGuide, operationGuide } from "../../report/guide";

export function StatusPanel() {
  const [status, reload] = useResource<StatusView>("/status", (s) => s.jobs.queued + s.jobs.running > 0, 3000);
  return (
    <section aria-label="Status" data-testid="status-panel">
      <Async state={status} reload={reload} what="Loading status">
        {(s) => (
          <>
            <p className="muted" data-testid="status-counts">
              Jobs: {s.jobs.queued} queued, {s.jobs.running} running, {s.jobs.failed} failed. Operations: {s.operations.unknown} unknown, {s.operations.conflict} conflict, {s.operations.failed} failed,{" "}
              {s.operations.applied} applied.
              {s.compensations_unknown > 0 ? ` ${s.compensations_unknown} compensation(s) unknown.` : ""}
            </p>
            {s.attention.length > 0 ? (
              <div className="callout tone-warn" role="alert" data-testid="attention-list">
                <strong>{s.attention.length} item(s) need attention.</strong>
                <ul>
                  {s.attention.map((a) => (
                    <li key={a.operation_id} data-testid="attention-item">
                      <a href={`#/operations/${a.operation_id}`}>{a.operation_id}</a>: {a.state}. {a.reason} <strong>Next step:</strong> {a.next_step}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </Async>
    </section>
  );
}

export function OperationsPage({ user }: { user: User }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const path = `/operations?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const [page, reload] = useResource<Page<OperationView>>(path, (p) => p.items.some((o) => ["approved", "applying"].includes(o.state)));
  const [exportError, setExportError] = useState<string | null>(null);

  return (
    <>
      <h1>Operations</h1>
      <StatusPanel />
      <div className="actions">
        {canOperate(user) ? (
          <a className="button" href="#/operations/new" data-testid="new-plan-link">
            New plan
          </a>
        ) : (
          <span className="muted" data-testid="viewer-note">
            Your role is viewer: you can read redacted evidence but not change anything.
          </span>
        )}
        {canOperate(user) ? (
          <button
            type="button"
            className="secondary"
            data-testid="export-button"
            onClick={() => {
              setExportError(null);
              download("POST", "/exports", "undokit-evidence.json", {}).catch((e: Error) => setExportError(e.message));
            }}
          >
            Export evidence bundle
          </button>
        ) : null}
      </div>
      {exportError ? (
        <p className="state-error" role="alert" data-testid="export-error">
          {exportError}
        </p>
      ) : null}
      <Async state={page} reload={reload} what="Loading operations" isEmpty={(p) => p.items.length === 0} empty="No operations yet. Create a plan to record a before and after receipt for an allowlisted field change.">
        {(p) => (
          <>
            <div className="table-wrap">
              <table data-testid="operations-table">
                <caption>Operations in this workspace</caption>
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">State</th>
                    <th scope="col">Fields</th>
                    <th scope="col">Compensation</th>
                    <th scope="col">Created (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((o) => {
                    const attention = operationGuide(o.state, o.failure?.code).needsAttention || o.compensations.some((c) => compensationGuide(c.state, c.failure?.code).needsAttention);
                    const comp = o.compensations[o.compensations.length - 1];
                    return (
                      <tr key={o.id} data-testid="operation-row" data-state={o.state} className={attention ? "row-attention" : undefined}>
                        <th scope="row">
                          <a href={`#/operations/${o.id}`}>{o.record_ref}</a>
                        </th>
                        <td>
                          <StateBadge state={o.state} failureCode={o.failure?.code} />
                        </td>
                        <td>{o.fields.map((f) => f.field).join(", ")}</td>
                        <td>{comp ? compensationGuide(comp.state, comp.failure?.code).label : <span className="muted">none</span>}</td>
                        <td>{o.created_at}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="actions">
              {cursors.length > 1 ? (
                <button type="button" className="secondary" onClick={() => setCursors((c) => c.slice(0, -1))}>
                  Newer
                </button>
              ) : null}
              {p.next_cursor ? (
                <button type="button" className="secondary" onClick={() => setCursors((c) => [...c, p.next_cursor])}>
                  Older
                </button>
              ) : null}
            </div>
          </>
        )}
      </Async>
    </>
  );
}
