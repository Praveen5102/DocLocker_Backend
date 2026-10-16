-- DocLocker on Railway — initial schema.
--
-- Organisation scoping from day one: Flyurdream is the owner, partner
-- agencies are separate organisations, and every student/document row
-- belongs to exactly one. Queries must always filter by org_id.
--
-- Student records are stored ENCRYPTED (record_enc, AES-256-GCM, see
-- src/services/dataCrypto.js). Only the columns needed to sign in, search,
-- filter and scope are kept readable.

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('owner', 'partner')),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organizations (slug, name, kind) VALUES ('flyurdream', 'Flyurdream', 'owner');

CREATE TABLE students (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  -- The "{name}__{identifier}" key the app already uses everywhere; for
  -- students imported from Drive it matches their Drive folder name.
  folder_key  text NOT NULL,
  name        text NOT NULL,
  identifier  text NOT NULL,            -- the email or phone the student signs in with
  email       text,
  phone       text,
  advisor     text,
  consultancy text,
  loan_status text NOT NULL DEFAULT 'pending',
  record_enc  bytea NOT NULL,           -- the full student record, encrypted
  source      text NOT NULL DEFAULT 'railway' CHECK (source IN ('railway', 'drive_import')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, folder_key)
);

CREATE INDEX students_org_identifier_idx ON students (org_id, lower(identifier));
CREATE INDEX students_org_advisor_idx ON students (org_id, advisor);
CREATE INDEX students_org_updated_idx ON students (org_id, updated_at DESC);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section     text NOT NULL,            -- e.g. 'GOVT ID', 'Academics', 'Loan/Co_Applicant_1'
  file_name   text NOT NULL,            -- e.g. 'Passport.pdf'
  mime_type   text NOT NULL,
  size_bytes  bigint NOT NULL,
  storage     text NOT NULL CHECK (storage IN ('bucket', 'drive')),
  storage_key text NOT NULL,            -- bucket object key, or Drive file id for imported students
  encryption  text,                     -- 'aes-256-gcm-v1' for bucket files; NULL for Drive files
  sha256      text,                     -- of the plaintext, to verify integrity on read
  uploaded_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX documents_student_idx ON documents (student_id) WHERE deleted_at IS NULL;
-- One live file per slot; replacing a document soft-deletes the old row.
CREATE UNIQUE INDEX documents_slot_idx ON documents (student_id, section, file_name) WHERE deleted_at IS NULL;

CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  org_id  uuid REFERENCES organizations(id),
  ts      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  role    text,
  action  text NOT NULL,
  target  text,
  details jsonb
);

CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX audit_log_org_ts_idx ON audit_log (org_id, ts DESC);

-- Keep students.updated_at honest on every change.
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER students_touch_updated_at
  BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
