import { type FormEvent, useRef, useState } from "react";
import { ApiError, canOperate, mutate, type User } from "../api";
import { Async, Badge } from "../components";
import { useResource } from "../hooks";
import type { ConnectorView, FieldConfig, Page, PlanResponse, Scalar } from "../model";

interface Row {
  field: string;
  raw: string;
  isNull: boolean;
}

/** Convert the typed text of one row to the scalar the API expects; returns an error string instead on bad input. */
export function parseValue(cfg: FieldConfig, row: Row): { ok: true; value: Scalar } | { ok: false; error: string } {
  if (row.isNull) return cfg.nullable ? { ok: true, value: null } : { ok: false, error: `${cfg.name} cannot be set to null` };
  if (cfg.type === "boolean") {
    if (row.raw === "true") return { ok: true, value: true };
    if (row.raw === "false") return { ok: true, value: false };
    return { ok: false, error: `${cfg.name} must be true or false` };
  }
  if (cfg.type === "number") {
    if (row.raw.trim() === "" || !Number.isFinite(Number(row.raw))) return { ok: false, error: `${cfg.name} must be a number` };
    return { ok: true, value: Number(row.raw) };
  }
  if (row.raw.length > cfg.max_length) return { ok: false, error: `${cfg.name} is longer than ${cfg.max_length} characters` };
  return { ok: true, value: row.raw };
}

export function NewPlanPage({ user }: { user: User }) {
  const [connectors, reload] = useResource<Page<ConnectorView>>("/connectors");
  const [connectorId, setConnectorId] = useState("");
  const [recordRef, setRecordRef] = useState("");
  const [expectedVersion, setExpectedVersion] = useState("");
  const [rows, setRows] = useState<Row[]>([{ field: "", raw: "", isNull: false }]);
  const [errors, setErrors] = useState<string[]>([]);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const touch = () => {
    key.current = crypto.randomUUID();
  };

  if (!canOperate(user)) {
    return (
      <>
        <h1>New plan</h1>
        <p className="state-note" role="status" data-testid="forbidden-note">
          Your role is viewer. Only operators and admins can create plans.
        </p>
      </>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>, all: ConnectorView[]) => {
    event.preventDefault();
    const connector = all.find((c) => c.id === connectorId);
    const problems: string[] = [];
    if (!connector) problems.push("Choose a connector.");
    if (!recordRef.trim()) problems.push("Enter the record reference.");
    if (!expectedVersion.trim()) problems.push("Enter the record version the plan is based on.");
    const patch: Record<string, Scalar> = {};
    if (connector) {
      for (const row of rows) {
        const cfg = connector.policy.allowed_fields.find((f) => f.name === row.field);
        if (!cfg) {
          problems.push("Choose an allowlisted field for every row.");
          continue;
        }
        if (row.field in patch) {
          problems.push(`${row.field} appears twice.`);
          continue;
        }
        const parsed = parseValue(cfg, row);
        if (parsed.ok) patch[row.field] = parsed.value;
        else problems.push(parsed.error);
      }
    }
    if (problems.length > 0) {
      setErrors(problems);
      setBlocker(null);
      return;
    }
    setBusy(true);
    setErrors([]);
    setBlocker(null);
    try {
      const plan = await mutate<PlanResponse>("/operations", { connector_id: connectorId, record_ref: recordRef.trim(), patch, expected_version: expectedVersion.trim() }, key.current);
      window.location.hash = `#/operations/${plan.id}`;
    } catch (e) {
      if (e instanceof ApiError && e.code === "UNRESOLVED_OPERATION") {
        // The server names the blocking operation; link to it so the operator can reconcile or resolve it.
        setBlocker(e.details?.map((d) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(d.message)?.[0]).find(Boolean) ?? null);
        setErrors([e.message]);
      } else if (e instanceof ApiError && e.details && e.details.length > 0) setErrors([e.message, ...e.details.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message))]);
      else setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>New plan</h1>
      <p className="muted">Planning records the before state and a plan hash. Nothing is written to the provider until a plan is approved.</p>
      <Async state={connectors} reload={reload} what="Loading connectors" isEmpty={(p) => p.items.filter((c) => !c.disabled).length === 0} empty="No connector is configured. An admin must add one before plans can be created.">
        {(page) => {
          const usable = page.items.filter((c) => !c.disabled);
          const connector = usable.find((c) => c.id === connectorId);
          return (
            <form onSubmit={(e) => void submit(e, usable)} aria-label="New plan" data-testid="plan-form">
              <label>
                Connector
                <select
                  name="connector"
                  value={connectorId}
                  onChange={(e) => {
                    touch();
                    setConnectorId(e.target.value);
                    setRows([{ field: "", raw: "", isNull: false }]);
                  }}
                  required
                >
                  <option value="">Select a connector</option>
                  {usable.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.read_only}>
                      {c.name} ({c.label}){c.read_only ? " - read-only" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {connector ? (
                <p data-testid="connector-label">
                  <Badge tone={connector.live ? "ok" : "info"}>{connector.live ? "Live provider" : "Simulator, not a live provider"}</Badge>{" "}
                  <span className="muted">Allowed fields: {connector.policy.allowed_fields.map((f) => f.name).join(", ")}. Record prefixes: {connector.policy.record_prefixes.join(", ")}.</span>
                </p>
              ) : null}
              <label>
                Record reference
                <input
                  name="record_ref"
                  value={recordRef}
                  onChange={(e) => {
                    touch();
                    setRecordRef(e.target.value);
                  }}
                  required
                  autoComplete="off"
                />
              </label>
              <label>
                Record version the plan is based on
                <input
                  name="expected_version"
                  value={expectedVersion}
                  onChange={(e) => {
                    touch();
                    setExpectedVersion(e.target.value);
                  }}
                  required
                  autoComplete="off"
                />
              </label>
              <fieldset>
                <legend>Field changes</legend>
                {rows.map((row, i) => {
                  const cfg = connector?.policy.allowed_fields.find((f) => f.name === row.field);
                  return (
                    <div className="form-inline" key={i} data-testid="patch-row">
                      <label>
                        Field
                        <select
                          value={row.field}
                          onChange={(e) => {
                            touch();
                            setRows((r) => r.map((x, j) => (j === i ? { field: e.target.value, raw: "", isNull: false } : x)));
                          }}
                          disabled={!connector}
                        >
                          <option value="">Select a field</option>
                          {connector?.policy.allowed_fields.map((f) => (
                            <option key={f.name} value={f.name}>
                              {f.name}
                              {f.sensitive ? " (sensitive)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        New value
                        {cfg?.type === "boolean" ? (
                          <select
                            value={row.raw}
                            onChange={(e) => {
                              touch();
                              setRows((r) => r.map((x, j) => (j === i ? { ...x, raw: e.target.value } : x)));
                            }}
                            disabled={row.isNull}
                          >
                            <option value="">Select</option>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : cfg?.enum ? (
                          <select
                            value={row.raw}
                            onChange={(e) => {
                              touch();
                              setRows((r) => r.map((x, j) => (j === i ? { ...x, raw: e.target.value } : x)));
                            }}
                            disabled={row.isNull}
                          >
                            <option value="">Select</option>
                            {cfg.enum.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={row.raw}
                            inputMode={cfg?.type === "number" ? "decimal" : undefined}
                            onChange={(e) => {
                              touch();
                              setRows((r) => r.map((x, j) => (j === i ? { ...x, raw: e.target.value } : x)));
                            }}
                            disabled={row.isNull || !cfg}
                          />
                        )}
                      </label>
                      {cfg?.nullable ? (
                        <label>
                          <input
                            type="checkbox"
                            checked={row.isNull}
                            onChange={(e) => {
                              touch();
                              setRows((r) => r.map((x, j) => (j === i ? { ...x, isNull: e.target.checked } : x)));
                            }}
                          />{" "}
                          Set to empty (null)
                        </label>
                      ) : null}
                      {rows.length > 1 ? (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            touch();
                            setRows((r) => r.filter((_, j) => j !== i));
                          }}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  );
                })}
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      touch();
                      setRows((r) => [...r, { field: "", raw: "", isNull: false }]);
                    }}
                  >
                    Add field
                  </button>
                </div>
              </fieldset>
              {errors.length > 0 ? (
                <div className="state-error" role="alert" data-testid="plan-errors">
                  <ul>
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                  Nothing was written to the provider.
                  {blocker ? (
                    <p data-testid="plan-blocker">
                      This record has an unresolved change. <a href={`#/operations/${blocker}`}>Open the blocking operation</a>, reconcile it (or, as an administrator, close it) and then plan again.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="actions">
                <button type="submit" disabled={busy} data-testid="plan-submit">
                  {busy ? "Planning…" : "Create plan"}
                </button>
                <a href="#/">Cancel</a>
              </div>
            </form>
          );
        }}
      </Async>
    </>
  );
}
