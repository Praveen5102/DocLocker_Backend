-- Moving everything that still lives on Google Drive into Railway
-- (scripts/migrate-drive-to-railway.js). The tables below record what has
-- been copied, so the move can be re-run or resumed without ever copying
-- the same student, file or log entry twice.

-- One row per Drive student folder taken over. Rows outlive the student
-- (student_id goes NULL): a student deleted after the move must not come
-- back from their Drive folder on a later run.
CREATE TABLE drive_migration_students (
  drive_folder_id   text PRIMARY KEY,
  folder_key        text NOT NULL,
  student_id        uuid REFERENCES students(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'copying' CHECK (status IN ('copying', 'done')),
  files_found       integer NOT NULL DEFAULT 0,
  files_copied      integer NOT NULL DEFAULT 0,
  files_skipped     integer NOT NULL DEFAULT 0,
  meta_drive_file_id text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

-- One row per Drive file copied into the bucket.
CREATE TABLE drive_migration_files (
  drive_file_id   text PRIMARY KEY,
  drive_folder_id text NOT NULL REFERENCES drive_migration_students(drive_folder_id) ON DELETE CASCADE,
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  drive_md5       text,
  sha256          text NOT NULL,
  copied_at       timestamptz NOT NULL DEFAULT now()
);

-- Lender access requests (were banker_access_requests.json on Drive).
CREATE TABLE banker_access_requests (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES organizations(id),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  student_key        text NOT NULL,
  student_name       text NOT NULL DEFAULT '',
  student_identifier text NOT NULL DEFAULT '',
  banker_name        text NOT NULL,
  requested_by       text NOT NULL,
  requested_by_role  text NOT NULL DEFAULT 'advisor',
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         text,
  decided_at         timestamptz,
  note               text
);
CREATE INDEX banker_access_requests_org_idx ON banker_access_requests (org_id, status, requested_at DESC);
-- At most one pending request per student + lender.
CREATE UNIQUE INDEX banker_access_requests_pending_idx
  ON banker_access_requests (org_id, student_key, banker_name) WHERE status = 'pending';

-- Audit entries imported from audit_log.json keep their original id here,
-- so an entry can never be imported twice.
ALTER TABLE audit_log ADD COLUMN legacy_id text;
CREATE UNIQUE INDEX audit_log_legacy_id_idx ON audit_log (legacy_id) WHERE legacy_id IS NOT NULL;

-- Small switches the app checks, e.g. "the Drive audit log has been imported".
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
