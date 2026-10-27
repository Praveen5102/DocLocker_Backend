// Fields of a student record that only staff decide. A save from the student
// portal (or from staff who don't own the field) can't set them: the stored
// value is kept, whatever the browser sends.

const LOAN_FIELDS = [
  'loanStatus', 'loanRemark', 'loanStatusUpdatedBy', 'loanStatusUpdatedAt', 'loanDisbursement',
  // Set by POST /api/students/:key/sanction-letter only
  'sanctionLetter',
];
const SHARING_FIELDS = ['sharedBankers'];

function keep(target, source, fields) {
  for (const f of fields) {
    if (source[f] === undefined) delete target[f];
    else target[f] = source[f];
  }
}

// who: 'student' | the signed-in staff account
function mergeStudentMeta(existing = {}, incoming = {}, who = 'student') {
  const next = { ...incoming };
  const role = who === 'student' ? 'student' : who.role;
  const isAdmin = role === 'superadmin' || role === 'admin';

  // Loan status and the sanction letter have their own endpoints (with
  // remarks and audit), for everyone.
  keep(next, existing, LOAN_FIELDS);
  // Sharing with lenders goes through banker-access (advisors need approval).
  keep(next, existing, SHARING_FIELDS);
  // Advisors are assigned by staff, never by the student; afterwards only
  // admins reassign.
  if (role === 'student') next.advisor = existing.advisor || '';
  else if (existing.advisor && !isAdmin) next.advisor = existing.advisor;
  // Application ID never changes once issued.
  if (existing.applicationId) next.applicationId = existing.applicationId;
  // Set once, by POST /api/applicant/submit (audited) — never by a save.
  if (existing.applicationSubmittedAt) next.applicationSubmittedAt = existing.applicationSubmittedAt;
  else delete next.applicationSubmittedAt;
  return next;
}

module.exports = { mergeStudentMeta };
