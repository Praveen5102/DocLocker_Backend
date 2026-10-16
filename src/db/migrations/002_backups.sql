-- Offsite backup bookkeeping (see services/backup.js).

-- Each stored object is copied to the backup location once; these record
-- where, so the nightly run only copies what's new.
ALTER TABLE documents ADD COLUMN backed_up_at timestamptz;
ALTER TABLE documents ADD COLUMN backup_file_id text;

CREATE INDEX documents_not_backed_up_idx ON documents (created_at)
  WHERE storage = 'bucket' AND backed_up_at IS NULL;

-- One row per backup run, so failures are visible instead of silent.
CREATE TABLE backup_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  details     jsonb
);
