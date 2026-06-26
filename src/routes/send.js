const express = require('express');
const {
  ROOT_FOLDER_ID, sanitize, buildFolderKey, findFolderByName,
  findFilesByName, listAllFilesRecursive, shareFilePublicly, readJsonFile,
} = require('../services/drive');
const { verifyJWT } = require('../middleware/auth');

const router = express.Router();

// Files that live alongside the student's documents but should never be sent
// to a bank — internal app data and the eligibility report (banks only get
// the raw documents + the summary PDF, per product decision).
const EXCLUDED_FILENAMES = new Set(['student_meta.json', 'eligibility_report.pdf']);

async function readStudentMeta(stuDirId) {
  const othersDir = await findFolderByName(stuDirId, 'Others');
  const candidates = othersDir ? await findFilesByName(othersDir.id, 'student_meta.json') : [];
  const files = candidates.length > 0 ? candidates : await findFilesByName(stuDirId, 'student_meta.json');
  if (files.length === 0) return {};
  try { return await readJsonFile(files[0].id); } catch { return {}; }
}

function buildEmailBody({ studentName, meta, groupedFiles }) {
  const p = meta.personalInfo || {};
  const fullName = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.fullName || studentName;

  const lines = [];
  lines.push('Hello,');
  lines.push('');
  lines.push(`Please find below the documents for ${fullName}'s education loan application.`);
  lines.push('');
  if (p.loanAmount) lines.push(`Loan Amount: ₹${Number(p.loanAmount).toLocaleString('en-IN')}`);
  if (p.destinationCountry) lines.push(`Destination Country: ${p.destinationCountry}`);
  if (p.targetUniversity) lines.push(`Target University: ${p.targetUniversity}`);
  if (p.courseNameUniversity) lines.push(`Course: ${p.courseNameUniversity}`);
  lines.push('');
  lines.push('Documents:');
  for (const [group, files] of Object.entries(groupedFiles)) {
    lines.push('');
    lines.push(`${group}:`);
    for (const f of files) lines.push(`- ${f.name}: ${f.webViewLink}`);
  }
  lines.push('');
  lines.push('Regards,');
  lines.push(meta.advisor || 'DocLocker');

  return lines.join('\n');
}

// POST /api/send-to-bank — admin only
// Body: { studentName, studentIdentifier, banks: [{ name, email }, ...] }
// Shares each document (excluding internal meta + eligibility report) as
// "anyone with the link" and returns a composed subject/body for the
// frontend to open in a Gmail compose redirect — this endpoint never sends
// email itself, since the admin reviews and sends from their own Gmail.
router.post('/', verifyJWT, async (req, res) => {
  try {
    const { studentName, studentIdentifier, banks } = req.body;
    if (!studentName) return res.status(400).json({ success: false, error: 'Missing studentName' });
    if (!Array.isArray(banks) || banks.length === 0) {
      return res.status(400).json({ success: false, error: 'Select at least one bank' });
    }

    const folderKey = sanitize(buildFolderKey(studentName, studentIdentifier || ''));
    const stuDir = await findFolderByName(ROOT_FOLDER_ID(), folderKey);
    if (!stuDir) {
      return res.json({ success: false, error: `Student folder "${folderKey}" not found in Drive` });
    }

    const meta = await readStudentMeta(stuDir.id);
    const allFiles = await listAllFilesRecursive(stuDir.id);
    const sendable = allFiles.filter((f) => !EXCLUDED_FILENAMES.has(f.name.toLowerCase()));

    if (sendable.length === 0) {
      return res.json({ success: false, error: 'No documents found to send for this student' });
    }

    // Grant link access to every sendable file (not the folder, so the
    // excluded files stay private).
    await Promise.all(sendable.map((f) => shareFilePublicly(f.id).catch(() => {})));

    const groupedFiles = {};
    for (const f of sendable) {
      const group = f.relativePath || 'Other';
      if (!groupedFiles[group]) groupedFiles[group] = [];
      groupedFiles[group].push(f);
    }

    const p = meta.personalInfo || {};
    const fullName = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.fullName || studentName;
    const subject = `Loan Application Documents — ${fullName}`;
    const body = buildEmailBody({ studentName, meta, groupedFiles });

    res.json({ success: true, subject, body, banks });
  } catch (err) {
    console.error('sendToBank error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
