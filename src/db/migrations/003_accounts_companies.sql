-- Staff accounts move from admins.json (Drive) into Postgres, and partner
-- companies become real tenants.
--
-- Hierarchy:
--   superadmin            - Flyurdream (the owner organisation) only; sees every company
--   admin                 - runs one company: its students, staff, lenders and settings
--   advisor               - staff of one company; sees the students assigned to them
--   banker (lender)       - loan officer of one company; sees only students shared with them
--
-- Every account belongs to exactly one organisation. Sign-in is by email.

ALTER TABLE organizations
  ADD COLUMN status        text  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  ADD COLUMN contact_email text,
  -- White-label settings shown on the company's signup link and portal
  -- (display name, logo URL, accent colour). Never holds secrets.
  ADD COLUMN branding      jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  -- Shown in the UI and stored on student records (advisor, sharedBankers),
  -- so it stays unique across the whole platform.
  name           text NOT NULL,
  email          text,                  -- sign-in id; NULL only for accounts imported before emails existed
  role           text NOT NULL CHECK (role IN ('superadmin', 'admin', 'advisor', 'banker')),
  bank           text,                  -- lenders only
  password_hash  text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Bumped on password change, disable or role change: every token issued
  -- before that stops working on its next request.
  token_version  integer NOT NULL DEFAULT 0,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX accounts_email_idx ON accounts (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX accounts_name_idx ON accounts (lower(name));
CREATE INDEX accounts_org_role_idx ON accounts (org_id, role);

CREATE TRIGGER accounts_touch_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Company of a student: also readable for audit rows written by students.
CREATE INDEX audit_log_org_action_idx ON audit_log (org_id, action);
