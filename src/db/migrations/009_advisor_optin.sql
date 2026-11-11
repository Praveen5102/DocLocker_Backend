-- A superadmin can also work as an advisor: when acts_as_advisor is on,
-- their name is offered in the advisor pickers and gets an advisor card,
-- like any staff account. Off by default; staff (advisor) accounts are
-- advisors already and ignore it.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS acts_as_advisor boolean NOT NULL DEFAULT false;
