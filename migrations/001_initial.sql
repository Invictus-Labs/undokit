-- UndoKit migration 001: initial schema (PostgreSQL semantics; runs on PGlite and PostgreSQL).
-- Rules: UUID primary keys, UTC timestamptz, workspace-scoped foreign keys, content hashes as text
-- 'sha256:<hex>', encrypted envelopes (jsonb) for field snapshots and connector credentials.
-- attempts, evidence_events, approvals and evidence_imports are append-only (enforced by trigger).

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships (workspace_id, user_id)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_workspace_idx ON sessions (workspace_id, expires_at);

CREATE TABLE connectors (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('simulator', 'couchdb')),
  policy jsonb NOT NULL,
  config jsonb NOT NULL,
  credentials_enc jsonb,
  supports_atomic_conditional_write boolean NOT NULL,
  disabled_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);

CREATE TABLE operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connector_id uuid NOT NULL,
  record_ref text NOT NULL,
  intent_hash text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('planned', 'approved', 'applying', 'applied', 'failed', 'unknown', 'conflict')),
  expected_version text NOT NULL,
  observed_version text,
  plan_hash text NOT NULL,
  failure_code text,
  failure_message text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, connector_id) REFERENCES connectors (workspace_id, id)
);
CREATE INDEX operations_ws_created_idx ON operations (workspace_id, created_at DESC, id DESC);
CREATE INDEX operations_ws_state_idx ON operations (workspace_id, state);
CREATE INDEX operations_connector_idx ON operations (connector_id);

CREATE TABLE field_snapshots (
  operation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  field text NOT NULL,
  sensitive boolean NOT NULL,
  before jsonb NOT NULL,
  intended jsonb NOT NULL,
  observed_after jsonb,
  before_hash text NOT NULL,
  intended_hash text NOT NULL,
  observed_after_hash text,
  provider_version text NOT NULL,
  apply_outcome text NOT NULL DEFAULT 'pending'
    CHECK (apply_outcome IN ('pending', 'applied', 'not_applied', 'changed_other', 'mismatch')),
  compensation_outcome text NOT NULL DEFAULT 'pending'
    CHECK (compensation_outcome IN ('pending', 'restored', 'not_restored', 'changed_other', 'mismatch')),
  PRIMARY KEY (operation_id, field),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations (workspace_id, id)
);

CREATE TABLE compensations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('planned', 'approved', 'compensating', 'compensated', 'conflict', 'failed', 'unknown')),
  plan_hash text NOT NULL,
  expected_version text NOT NULL,
  conflicts_enc jsonb NOT NULL,
  failure_code text,
  failure_message text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations (workspace_id, id)
);
CREATE INDEX compensations_operation_idx ON compensations (operation_id, created_at);
CREATE INDEX compensations_state_idx ON compensations (workspace_id, state);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  compensation_id uuid,
  phase text NOT NULL CHECK (phase IN ('apply', 'compensate')),
  plan_hash text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations (workspace_id, id),
  FOREIGN KEY (workspace_id, compensation_id) REFERENCES compensations (workspace_id, id),
  CHECK ((phase = 'compensate') = (compensation_id IS NOT NULL))
);
CREATE INDEX approvals_operation_idx ON approvals (operation_id, created_at);

CREATE TABLE attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  compensation_id uuid,
  phase text NOT NULL CHECK (phase IN ('apply', 'compensate', 'reconcile')),
  outcome text NOT NULL CHECK (outcome IN ('started', 'succeeded', 'conflict', 'failed', 'unknown',
    'reconciled_applied', 'reconciled_not_applied', 'reconciled_indeterminate')),
  started_attempt_id uuid REFERENCES attempts(id),
  provider_request_id text,
  observed_version text,
  error_code text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations (workspace_id, id),
  FOREIGN KEY (workspace_id, compensation_id) REFERENCES compensations (workspace_id, id)
);
CREATE INDEX attempts_operation_idx ON attempts (operation_id, created_at);
CREATE INDEX attempts_started_idx ON attempts (started_attempt_id);

CREATE TABLE evidence_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  seq integer NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  prev_hash text NOT NULL,
  event_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (operation_id, seq),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations (workspace_id, id)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  compensation_id uuid,
  kind text NOT NULL CHECK (kind IN ('apply', 'compensate', 'reconcile')),
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'done', 'failed')),
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts_count integer NOT NULL DEFAULT 0,
  last_error text,
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations (workspace_id, id),
  FOREIGN KEY (workspace_id, compensation_id) REFERENCES compensations (workspace_id, id)
);
CREATE INDEX jobs_claim_idx ON jobs (state, available_at);
CREATE INDEX jobs_lease_idx ON jobs (state, lease_expires_at);
CREATE INDEX jobs_operation_idx ON jobs (operation_id);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  resource_id uuid NOT NULL,
  revision integer NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending_idx ON outbox (published_at, occurred_at);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  route text NOT NULL,
  key text NOT NULL,
  intent_hash text NOT NULL,
  operation_id uuid,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, route, key),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations (workspace_id, id)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE evidence_imports (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  bundle_id uuid NOT NULL,
  bundle_hash text NOT NULL,
  schema_version integer NOT NULL,
  file_count integer NOT NULL,
  total_bytes integer NOT NULL,
  content jsonb NOT NULL,
  imported_by uuid NOT NULL REFERENCES users(id),
  imported_at timestamptz NOT NULL,
  UNIQUE (workspace_id, bundle_id)
);

CREATE FUNCTION undokit_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'undokit: % is append-only (% blocked)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attempts_append_only BEFORE UPDATE OR DELETE ON attempts
  FOR EACH ROW EXECUTE FUNCTION undokit_forbid_mutation();
CREATE TRIGGER evidence_events_append_only BEFORE UPDATE OR DELETE ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION undokit_forbid_mutation();
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION undokit_forbid_mutation();
CREATE TRIGGER evidence_imports_append_only BEFORE UPDATE OR DELETE ON evidence_imports
  FOR EACH ROW EXECUTE FUNCTION undokit_forbid_mutation();
