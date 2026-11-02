-- Consultancies: the education consultants students come through. Before
-- this, a consultancy was only free text on each student, so the same one
-- was typed many ways. Each company keeps its own list.
--   name_key -> the name lower-cased with punctuation removed; one per company
--   aliases  -> other spellings merged into this one, so they match it later
CREATE TABLE IF NOT EXISTS consultancies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name           text NOT NULL,
  name_key       text NOT NULL,
  aliases        text[] NOT NULL DEFAULT '{}',
  city           text,
  contact_person text,
  phone          text,
  email          text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name_key)
);

-- Staff (advisors) can pick a listed consultancy freely; a name that isn't
-- listed waits here for an admin.
--   status: pending | approved (added as new) | mapped (matched to an
--   existing one) | rejected
CREATE TABLE IF NOT EXISTS consultancy_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  student_key     text,
  student_name    text,
  requested_by    text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  consultancy_id  uuid REFERENCES consultancies(id) ON DELETE SET NULL,
  note            text,
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consultancy_requests_pending_idx ON consultancy_requests (org_id, status, created_at DESC);
