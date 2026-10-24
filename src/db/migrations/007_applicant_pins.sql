-- Applicant sign-in: each student protects their application with a
-- 6-digit PIN. Only a bcrypt hash is kept. Keyed by company + student key
-- (the folder key), so it covers students on Railway and the older ones
-- still on Drive alike.
--   pin_hash NULL  -> no PIN yet (an older student, or one reset by staff):
--                     the student chooses one on their next visit.
--   pin_version    -> bumped whenever the PIN is set or reset; applicant
--                     sessions carry it, so a reset signs every device out.
CREATE TABLE IF NOT EXISTS applicant_pins (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  student_key   text NOT NULL,
  pin_hash      text,
  pin_version   integer NOT NULL DEFAULT 1,
  failed_count  integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  set_at        timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, student_key)
);
