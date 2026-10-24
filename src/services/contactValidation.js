// Contact details for India — the server-side twin of
// Frontend/src/utils/validation.js. The signup API is public, so the rules
// are enforced here too, not just in the form.

function normalizeIndianMobile(input) {
  let digits = String(input || '').replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function isValidIndianMobile(input) {
  const digits = normalizeIndianMobile(input);
  return /^[6-9]\d{9}$/.test(digits) && !/^(\d)\1{9}$/.test(digits);
}

function isValidStudentEmail(input) {
  const email = String(input || '').trim();
  if (!email || /\s/.test(email) || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || email.indexOf('@') !== at) return false;
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).toLowerCase().split('.');
  if (local.length > 64 || !/^[A-Za-z0-9._%+-]+$/.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  return /^[a-z]{2,24}$/.test(labels[labels.length - 1]);
}

module.exports = { normalizeIndianMobile, isValidIndianMobile, isValidStudentEmail };
