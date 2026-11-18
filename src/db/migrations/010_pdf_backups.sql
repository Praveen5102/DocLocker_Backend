-- Readable PDF backups (services/pdfBackup.js): one PDF per student with
-- every detail and every document, kept in the owner's Google Drive only.
-- A second, human-readable safety copy beside the encrypted nightly backup.

-- The last good PDF of each student, so unchanged students are skipped.
CREATE TABLE pdf_backups (
  org_id        uuid NOT NULL REFERENCES organizations(id),
  student_key   text NOT NULL,
  fingerprint   text,
  folder_id     text,
  file_id       text,
  file_name     text,
  documents     integer,
  bytes         bigint,
  backed_up_at  timestamptz,
  last_error    text,
  last_error_at timestamptz,
  PRIMARY KEY (org_id, student_key)
);

-- One row per weekly (or manual) run over every student.
CREATE TABLE pdf_backup_runs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('weekly', 'manual')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  details     jsonb
);
