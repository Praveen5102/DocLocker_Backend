const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const {
  ROOT_FOLDER_ID, sanitize, buildFolderKey, findFolderByName, findFilesByName, readFileBuffer,
} = require('../services/drive');
const { readStudentMeta, writeStudentMeta } = require('../services/studentMeta');
const { extractTextViaOcr } = require('../services/pdf');
const { verifyJWT, requireStaff } = require('../middleware/auth');
const { studentsCache } = require('../services/cache');

const router = express.Router();

function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in environment');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const RECOVERY_SYSTEM_PROMPT = `You are a precise data extraction assistant.
You will receive OCR text extracted from a student loan application summary PDF.
Extract every field value and return ONLY a single valid JSON object — no explanation, no markdown fences, no trailing text.

Rules:
- Use null for any field that has no value (shown as "—" in the PDF).
- "Married" → marital: "Yes", "Unmarried" → marital: "No"
- loanAmount: strip "₹" and commas, return the raw number string (e.g. "1500000")
- annualIncome: same — strip "₹" and commas
- Score rows like "87 Marks — 2019": return score as string "87", type as "marks", year as "2019"
- Score rows like "8.5 CGPA — 2022": return score as "8.5", type as "cgpa", year as "2022"
- "Yes — 2 backlog(s)": hasBacklogs: "Yes", backlogCount: "2"
- "Yes — [details]": return hasJobDetails/priorBankApplied as "Yes" and extract the rest
- For co-applicant annual income, same numeric stripping applies
- coApplicants: count of co-applicant sections found (integer)
- Co-applicant data goes under personalInfo.co_info_0, co_info_1, etc.
- If a reference address is combined (house, street, city, state, pincode as comma-separated parts), split them into ref1_house_number, ref1_street_name, ref1_city, ref1_state, ref1_pincode
- Do not invent values. If a field is not present in the text, use null.`;

const RECOVERY_SCHEMA_HINT = `
Return JSON with this exact structure (include only non-null fields, but keep all keys):
{
  "name": "display name",
  "email": "...",
  "phone": "...",
  "advisor": "...",
  "coApplicants": 1,
  "personalInfo": {
    "fullName": "...",
    "firstName": "...",
    "lastName": "...",
    "email": "...",
    "phone": "...",
    "marital": "Yes|No",
    "loanTrack": "...",
    "loanAmount": "...",
    "studentCibil": "...",
    "currentAddress": "...",
    "permanentAddress": "...",
    "pct10Score": "...", "pct10Type": "marks|percentage|points", "pct10Year": "...",
    "pct12Score": "...", "pct12Type": "marks|percentage|points", "pct12Year": "...",
    "pctGradScore": "...", "pctGradType": "percentage|cgpa", "pctGradYear": "...",
    "qualName": "...", "qualYear": "...", "qualPassedYear": "...", "qualInstitution": "...",
    "hasBacklogs": "Yes|No", "backlogCount": "...",
    "greScore": "...", "ieltsScore": "...", "toeflScore": "...",
    "gmatScore": "...", "pteScore": "...", "duolingoScore": "...",
    "destinationCountry": "...", "targetUniversity": "...", "courseNameUniversity": "...",
    "i20Received": "...", "visaBooked": "...", "visaSlotDate": "...",
    "fatherName": "...", "fatherContact": "...", "fatherCibil": "...",
    "motherName": "...", "motherContact": "...", "motherCibil": "...",
    "maternalGrandma": "...", "paternalGrandma": "...", "ownHouseStatus": "...",
    "guarantorName": "...", "guarantorRelation": "...", "guarantorMobile": "...",
    "guarantorCibil": "...", "guarantorSector": "...", "guarantorDocsAvailable": "...",
    "hasJobDetails": "Yes|No", "jobSpecs": "...",
    "priorBankApplied": "Yes|No", "priorBankName": "...", "priorBankNameCustom": "...",
    "consultantNameLoc": "...", "consultantContact": "...",
    "ref1_name": "...", "ref1_mobile": "...", "ref1_occupation": "...",
    "ref1_relation": "...", "ref1_custom_relation": "...",
    "ref1_house_number": "...", "ref1_street_name": "...", "ref1_city": "...", "ref1_state": "...", "ref1_pincode": "...",
    "ref2_name": "...", "ref2_mobile": "...", "ref2_occupation": "...",
    "ref2_relation": "...", "ref2_custom_relation": "...",
    "ref2_house_number": "...", "ref2_street_name": "...", "ref2_city": "...", "ref2_state": "...", "ref2_pincode": "...",
    "co_info_0": {
      "firstName": "...", "lastName": "...", "name": "...",
      "relation": "...", "mobile": "...", "email": "...",
      "occupation": "...", "annualIncome": "...",
      "financialStatus": "financial|non-financial",
      "empType": "...", "qualifications": "...", "dependants": "...",
      "yearsAddress": "...", "currentAddress": "...", "permanentAddress": "...", "officeAddress": "..."
    }
  }
}`;

// POST /api/students/:studentKey/recover-meta
// Reads the student's Summary PDF, OCRs it, asks Claude to reconstruct the meta JSON.
// Returns { success: true, recovered: {...}, warning: "..." } — does NOT write yet.
router.post('/:studentKey/recover-meta', verifyJWT, requireStaff, async (req, res) => {
  try {
    const folderKey = sanitize(buildFolderKey(req.params.studentKey, ''));
    const stuDir = await findFolderByName(ROOT_FOLDER_ID(), folderKey);
    if (!stuDir) {
      return res.status(404).json({ success: false, error: `Student folder "${folderKey}" not found` });
    }

    // Locate Student_Summary.pdf — prefer Others/, fall back to root
    const othersDir = await findFolderByName(stuDir.id, 'Others');
    const candidates = othersDir
      ? await findFilesByName(othersDir.id, 'Student_Summary.pdf')
      : [];
    const summaryFiles = candidates.length > 0
      ? candidates
      : await findFilesByName(stuDir.id, 'Student_Summary.pdf');

    if (summaryFiles.length === 0) {
      return res.status(404).json({ success: false, error: 'Student_Summary.pdf not found in student folder' });
    }

    const pdfBuf = await readFileBuffer(summaryFiles[0].id);

    // OCR via Google Drive — upload PDF as Google Doc, export as text
    const extractedText = await extractTextViaOcr(pdfBuf, 'application/pdf', `Recovery_${folderKey}`);
    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(422).json({ success: false, error: 'OCR extracted no usable text from the PDF' });
    }

    const client = getAnthropicClient();
    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: RECOVERY_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${RECOVERY_SCHEMA_HINT}\n\n--- OCR TEXT START ---\n${extractedText}\n--- OCR TEXT END ---`,
        },
      ],
    });

    const rawText = message.content?.[0]?.text || '';
    // Strip markdown fences if Claude wrapped it
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let recovered;
    try {
      recovered = JSON.parse(jsonText);
    } catch {
      return res.status(422).json({
        success: false,
        error: 'Claude returned non-JSON output',
        rawOutput: rawText.slice(0, 500),
      });
    }

    // Warn if meta already has substantial data (accidental overwrite guard)
    const { meta: existing } = await readStudentMeta(stuDir.id).catch(() => ({ meta: {} }));
    const existingFieldCount = Object.keys(existing).length;
    const warning = existingFieldCount > 5
      ? `Existing meta has ${existingFieldCount} fields — confirm before overwriting`
      : null;

    res.json({ success: true, recovered, warning, existingFieldCount });
  } catch (err) {
    console.error('recover-meta error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/students/:studentKey/restore-meta
// Body: { metaJson: "..." } — writes confirmed recovered JSON as student_meta.json
router.post('/:studentKey/restore-meta', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { metaJson } = req.body;
    if (!metaJson) return res.status(400).json({ success: false, error: 'Missing metaJson' });

    let meta;
    try { meta = typeof metaJson === 'string' ? JSON.parse(metaJson) : metaJson; }
    catch { return res.status(400).json({ success: false, error: 'Invalid JSON in metaJson' }); }

    const folderKey = sanitize(buildFolderKey(req.params.studentKey, ''));
    const stuDir = await findFolderByName(ROOT_FOLDER_ID(), folderKey);
    if (!stuDir) {
      return res.status(404).json({ success: false, error: `Student folder "${folderKey}" not found` });
    }

    await writeStudentMeta(stuDir.id, meta);
    studentsCache.clear();

    res.json({ success: true });
  } catch (err) {
    console.error('restore-meta error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
