-- Audit entries belong to the company of whoever acted. Early builds filed
-- some Flyurdream superadmin actions (creating a partner, its accounts,
-- resets) under the partner company; move them back to Flyurdream so a
-- partner's log only holds its own people's actions.
UPDATE audit_log a
   SET org_id = (SELECT id FROM organizations WHERE slug = 'flyurdream')
 WHERE a.role = 'superadmin'
   AND a.org_id IS DISTINCT FROM (SELECT id FROM organizations WHERE slug = 'flyurdream');
