import { type FormEvent, useState } from "react";
import { type User, isAdmin, mutate } from "../api";
import { Async, Badge } from "../components";
import { useResource } from "../hooks";
import type { ConnectorView, MemberView, Page, Role } from "../model";

export function ConnectorsPage({ user }: { user: User }) {
  const [connectors, reload] = useResource<Page<ConnectorView>>("/connectors");
  return (
    <>
      <h1>Connectors</h1>
      <p className="muted">A connector without atomic compare-and-set is read-only: UndoKit will not write through it. The simulator is never labelled live.{isAdmin(user) ? "" : " Only admins can change connectors."}</p>
      <Async state={connectors} reload={reload} what="Loading connectors" isEmpty={(p) => p.items.length === 0} empty="No connector is configured yet. An admin adds one with the API; see the operations guide.">
        {(p) => (
          <div className="table-wrap">
            <table data-testid="connectors-table">
              <caption>Connectors</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Atomic conditional write</th>
                  <th scope="col">Allowed fields</th>
                  <th scope="col">Record prefixes</th>
                </tr>
              </thead>
              <tbody>
                {p.items.map((c) => (
                  <tr key={c.id} data-testid="connector-row" data-kind={c.kind}>
                    <th scope="row">
                      {c.name} {c.disabled ? <Badge tone="warn">Disabled</Badge> : null}
                    </th>
                    <td>
                      {c.label} <Badge tone={c.live ? "ok" : "info"}>{c.live ? "Live" : "Not live (simulator)"}</Badge>
                    </td>
                    <td>{c.read_only ? <Badge tone="warn">Read-only</Badge> : <Badge tone="ok">Writable</Badge>}</td>
                    <td>{c.supports_atomic_conditional_write ? "Yes" : "No"}</td>
                    <td>{c.policy.allowed_fields.map((f) => `${f.name}${f.sensitive ? " (sensitive)" : ""}`).join(", ")}</td>
                    <td>{c.policy.record_prefixes.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </>
  );
}

export function MembersPage({ user }: { user: User }) {
  const [members, reload] = useResource<Page<MemberView>>(isAdmin(user) ? "/members" : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isAdmin(user)) {
    return (
      <>
        <h1>Members</h1>
        <p className="state-note" role="status" data-testid="forbidden-note">
          Only admins can manage members.
        </p>
      </>
    );
  }

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await mutate("/members", { email: String(data.get("email")), password: String(data.get("password")), role: String(data.get("role")) as Role });
      setNotice(`Added ${String(data.get("email"))}.`);
      form.reset();
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Members</h1>
      <Async state={members} reload={reload} what="Loading members" isEmpty={(p) => p.items.length === 0} empty="No members.">
        {(p) => (
          <div className="table-wrap">
            <table data-testid="members-table">
              <caption>Workspace members</caption>
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Added (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {p.items.map((m) => (
                  <tr key={m.user_id} data-testid="member-row">
                    <th scope="row">{m.email}</th>
                    <td>{m.display_name ?? ""}</td>
                    <td>{m.role}</td>
                    <td>{m.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
      <h2>Add member</h2>
      <form onSubmit={(e) => void add(e)} aria-label="Add member" data-testid="member-form">
        <label>
          Email <input name="email" type="email" autoComplete="off" required />
        </label>
        <label>
          Initial password (at least 12 characters) <input name="password" type="password" autoComplete="new-password" minLength={12} required />
        </label>
        <label>
          Role
          <select name="role" defaultValue="viewer">
            <option value="viewer">viewer (read redacted evidence)</option>
            <option value="operator">operator (plan, approve, compensate)</option>
            <option value="admin">admin (manage members and connectors)</option>
          </select>
        </label>
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add member"}
          </button>
        </div>
        {error ? (
          <p className="state-error" role="alert" data-testid="member-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="callout tone-ok" role="status">
            {notice}
          </p>
        ) : null}
      </form>
    </>
  );
}
