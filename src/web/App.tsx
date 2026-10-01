import { type FormEvent, useEffect, useState } from "react";
import { loadSession, signIn, signOut, isAdmin, type User } from "./api";
import { useHashPath } from "./hooks";
import { ConnectorsPage, MembersPage } from "./pages/admin";
import { NewPlanPage } from "./pages/new-plan";
import { OperationPage } from "./pages/operation-detail";
import { OperationsPage } from "./pages/operations";

export function Login({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signIn(String(form.get("email")), String(form.get("password"))));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form onSubmit={(e) => void submit(e)} aria-label="Sign in" data-testid="login-form">
        <h1>UndoKit</h1>
        <p className="muted">Recover an approved CRM field change without overwriting later work. Accounts are created by an administrator with the bootstrap command; there is no open registration and no default password.</p>
        <label>
          Email <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit" disabled={busy} data-testid="login-submit">
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error ? (
          <p className="state-error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}

function Routes({ user }: { user: User }) {
  const path = useHashPath();
  const parts = path.split("?")[0]?.split("/").filter(Boolean) ?? [];
  if (parts.length === 0) return <OperationsPage user={user} />;
  if (parts[0] === "operations") {
    if (parts[1] === "new") return <NewPlanPage user={user} />;
    if (parts[1] && parts.length === 2) return <OperationPage key={parts[1]} id={parts[1]} user={user} />;
    return <OperationsPage user={user} />;
  }
  if (parts[0] === "connectors") return <ConnectorsPage user={user} />;
  if (parts[0] === "members") return <MembersPage user={user} />;
  return (
    <p className="state-note" data-testid="not-found">
      Page not found. <a href="#/">Back to operations</a>
    </p>
  );
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadSession().then(setUser, (e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <p className="state-error center" role="alert" data-testid="app-error">
        UndoKit is unreachable: {error}
      </p>
    );
  }
  if (user === undefined) {
    return (
      <p className="state-note center" role="status" data-testid="app-loading">
        Loading…
      </p>
    );
  }
  if (user === null) return <Login onSignedIn={setUser} />;
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          UndoKit
        </a>
        <nav aria-label="Main">
          <a href="#/">Operations</a>
          <a href="#/connectors">Connectors</a>
          {isAdmin(user) ? <a href="#/members">Members</a> : null}
        </nav>
        <div className="who" data-testid="whoami">
          <span>
            {user.workspace_name} · {user.email} ({user.role})
          </span>
          <button
            type="button"
            className="link"
            data-testid="sign-out"
            onClick={() =>
              signOut().then(
                () => setUser(null),
                (e: Error) => setError(e.message),
              )
            }
          >
            Sign out
          </button>
        </div>
      </header>
      <main>
        <Routes user={user} />
      </main>
    </>
  );
}
