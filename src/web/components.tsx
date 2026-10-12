import type { ReactNode } from "react";
import { compensationGuide, fieldOutcome, operationGuide, type Tone } from "../report/guide";
import type { Loadable } from "./hooks";

/** All text below is rendered through React text nodes: provider and user strings are never injected as HTML. */

export function Badge({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <span className={`badge tone-${tone}`} data-testid={testId}>
      {children}
    </span>
  );
}

export function StateBadge({ state, failureCode }: { state: string; failureCode?: string | null }) {
  const guide = operationGuide(state, failureCode);
  return (
    <Badge tone={guide.tone} testId="state-badge">
      {guide.label}
    </Badge>
  );
}

export function FieldStatusBadge({ status }: { status: string }) {
  const s = fieldOutcome(status);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Why the operation is in this state and what to do next; always visible for attention states. */
export function StateExplainer({ state, extra, failureCode }: { state: string; extra?: string; failureCode?: string | null }) {
  const guide = operationGuide(state, failureCode);
  return (
    <div className={`callout tone-${guide.tone}`} role={guide.needsAttention ? "alert" : "note"} data-testid="state-explainer" data-state={state}>
      <strong>{guide.label}.</strong> <span data-testid="state-reason">{guide.reason}</span>
      {extra ? <div data-testid="state-detail">Recorded reason: {extra}</div> : null}
      <div data-testid="state-next-step">
        <strong>Next step:</strong> {guide.nextStep}
      </div>
    </div>
  );
}

export function CompensationExplainer({ state, extra, failureCode }: { state: string; extra?: string; failureCode?: string | null }) {
  const guide = compensationGuide(state, failureCode);
  return (
    <div className={`callout tone-${guide.tone}`} role={guide.needsAttention ? "alert" : "note"} data-testid="compensation-explainer" data-state={state}>
      <strong>{guide.label}.</strong> <span>{guide.reason}</span>
      {extra ? <div>Recorded reason: {extra}</div> : null}
      <div data-testid="compensation-next-step">
        <strong>Next step:</strong> {guide.nextStep}
      </div>
    </div>
  );
}

/** Short value display: strings quoted so "null" and null differ; long values truncated. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = "[unserialisable value]";
  }
  return text.length > 400 ? `${text.slice(0, 400)}… (${text.length - 400} more characters)` : text;
}

export function Value({ value }: { value: unknown }) {
  return <code>{formatValue(value)}</code>;
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <p className="state-note" role="status" data-testid="state-loading">
      {what}…
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="state-empty" data-testid="state-empty">
      {children}
    </p>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-error" role="alert" data-testid="state-error">
      <strong>Could not load this.</strong> {message}
      {onRetry ? (
        <>
          {" "}
          <button type="button" className="link" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Render loading / failure / data for any Loadable; the caller supplies the empty check and the ready view. */
export function Async<T>({
  state,
  reload,
  what,
  isEmpty,
  empty,
  children,
}: {
  state: Loadable<T>;
  reload?: () => void;
  what?: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.status === "loading") return <Loading {...(what ? { what } : {})} />;
  if (state.status === "error") return <ErrorState message={state.message} {...(reload ? { onRetry: reload } : {})} />;
  if (isEmpty?.(state.data)) return <EmptyState>{empty}</EmptyState>;
  return <>{children(state.data)}</>;
}
