function detectDocumentType(subFolder, fileName) {
  const text = (subFolder + ' ' + fileName).toLowerCase();
  if (/adh?a+r|uid/.test(text)) return 'aadhaar';
  if (/\bpan\b/.test(text)) return 'pan';
  if (/passport/.test(text)) return 'passport';
  if (/10th|ssc|matric|secondary/.test(text)) return '10th';
  if (/12th|hsc|inter|plus.?two|higher.?sec/.test(text)) return '12th';
  if (/provisional|p\.?c\b/.test(text)) return 'pc';
  if (/diploma/.test(text)) return 'diploma';
  if (/degree|graduation|b\.?tech|b\.?e|b\.?sc|b\.?com|b\.?a\b|mba|m\.?tech/.test(text)) return 'degree';
  return 'other';
}

// ── Name extractor (used by all academic doc types) ────────────────────────────
function extractNameFromText(text) {
  const patterns = [
    /(?:Student[\s]*Name|Name\s*of\s*(?:the\s*)?(?:Student|Candidate|Examinee))[:\s]+([A-Z][A-Za-z\s\.]+)/i,
    /(?:^|\n)\s*Name[:\s]+([A-Z][A-Za-z\s\.]+)/im,
    /(?:Certified\s+that|This\s+is\s+to\s+certify)[^A-Z]*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      if (name.length > 2 && name.length < 80 &&
          !/board|university|school|college|institute|department|government/i.test(name)) {
        return name;
      }
    }
  }
  return null;
}

// ── Score parser — handles %, CGPA (multiple scales), marks, letter grades ─────
function parseScore(text) {
  // 1. Explicit percentage
  const pctMatch =
    text.match(/(?:Percentage|Marks\s*Percentage)[:\s]+(\d{1,3}(?:\.\d{1,2})?)\s*%?/i) ||
    text.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%(?!\s*\/)/);
  if (pctMatch) {
    const val = parseFloat(pctMatch[1]);
    if (val > 0 && val <= 100) {
      return { scoreType: 'Percentage', displayScore: val.toFixed(2) + '%', percentage: val };
    }
  }

  // 2. CGPA — 10-point scale
  const cgpa10 = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)\s*\/\s*10(?:\.0)?/i) ||
                 text.match(/(\d+(?:\.\d+)?)\s*\/\s*10(?:\.0)?\b(?!\d)/);
  if (cgpa10) {
    const val = parseFloat(cgpa10[1]);
    if (val >= 0 && val <= 10) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 10', percentage: val * 9.5 };
    }
  }

  // 3. CGPA — 4-point scale
  const cgpa4 = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)\s*\/\s*4(?:\.0)?/i) ||
                text.match(/(\d+(?:\.\d+)?)\s*\/\s*4(?:\.0)?\b(?!\d)/);
  if (cgpa4) {
    const val = parseFloat(cgpa4[1]);
    if (val >= 0 && val <= 4) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 4.0', percentage: (val / 4.0) * 100 };
    }
  }

  // 4. CGPA — 5-point scale
  const cgpa5 = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)\s*\/\s*5(?:\.0)?/i);
  if (cgpa5) {
    const val = parseFloat(cgpa5[1]);
    if (val >= 0 && val <= 5) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 5.0', percentage: (val / 5.0) * 100 };
    }
  }

  // 5. CGPA — 7-point scale
  const cgpa7 = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)\s*\/\s*7(?:\.0)?/i);
  if (cgpa7) {
    const val = parseFloat(cgpa7[1]);
    if (val >= 0 && val <= 7) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 7.0', percentage: (val / 7.0) * 100 };
    }
  }

  // 6. CGPA — bare (assume 10-point)
  const cgpaRaw = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)/i);
  if (cgpaRaw) {
    const val = parseFloat(cgpaRaw[1]);
    if (val >= 0 && val <= 10) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 10', percentage: val * 9.5 };
    }
  }

  // 7. Raw marks (e.g. "450/500", "Total Marks Obtained: 450 out of 600")
  const marksMatch =
    text.match(/(?:Total\s+Marks?\s*(?:Obtained)?|Marks?\s*Obtained|Score\s*Obtained)[:\s]+(\d+)\s*(?:out\s*of\s*|\/)\s*(\d+)/i) ||
    text.match(/\b(\d{3,4})\s*\/\s*(\d{3,4})\b/);
  if (marksMatch) {
    const obtained = parseInt(marksMatch[1]);
    const total    = parseInt(marksMatch[2]);
    if (total > 0 && obtained <= total && total >= 100) {
      return { scoreType: 'Marks', displayScore: obtained + ' / ' + total, percentage: (obtained / total) * 100 };
    }
  }

  // 8. Letter grades (O, A+, A, B+, B, C, D, F …)
  const gradeMap = { O: 92, S: 87, 'A+': 87, A: 80, 'B+': 73, B: 65, 'C+': 58, C: 52, D: 45, E: 40, F: 0 };
  const gradeMatch =
    text.match(/(?:Grade|Result|Class|Division)[:\s]+([A-Fa-f][+\-]?)\b/i) ||
    text.match(/\b(O|S|A\+|A|B\+|B|C\+|C|D|E|F)\s*(?:Grade|Class|Division)\b/i);
  if (gradeMatch) {
    const grade = gradeMatch[1].toUpperCase();
    if (gradeMap[grade] !== undefined) {
      return { scoreType: 'Grade', displayScore: grade, percentage: gradeMap[grade] };
    }
  }

  return null;
}

// ── Govt ID extractors ─────────────────────────────────────────────────────────

function extractAadhaar(text) {
  const fields = {};
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);

  const numMatch = text.match(/\b(\d{4}[\s]?\d{4}[\s]?\d{4})\b/);
  if (numMatch) fields['Aadhaar Number'] = numMatch[1];

  const dobMatch =
    text.match(/(?:DOB|Date of Birth|Year of Birth)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i) ||
    text.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
  if (dobMatch) fields['Date of Birth'] = dobMatch[1];

  const genderMatch = text.match(/\b(MALE|FEMALE)\b/i);
  if (genderMatch) fields['Gender'] = genderMatch[1];

  for (const line of lines.slice(0, 10)) {
    if (
      /^[A-Z][a-z]+(\s[A-Z][a-z]+)+$/.test(line) &&
      !/male|female|india|government|unique|authority/i.test(line)
    ) {
      fields['Name'] = line;
      break;
    }
  }

  return fields;
}

function extractPAN(text) {
  const fields = {};
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);

  const panMatch = text.match(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/);
  if (panMatch) fields['PAN Number'] = panMatch[1];

  const dobMatch = text.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
  if (dobMatch) fields['Date of Birth'] = dobMatch[1];

  let nameCount = 0;
  for (const line of lines) {
    if (
      /^[A-Z][A-Z\s]+$/.test(line) &&
      line.length > 3 && line.length < 60 &&
      !/INCOME|TAX|DEPARTMENT|INDIA|GOVT|PERMANENT|ACCOUNT|CARD/.test(line)
    ) {
      if (nameCount === 0) fields['Name'] = line;
      else if (nameCount === 1) fields["Father's Name"] = line;
      nameCount++;
      if (nameCount >= 2) break;
    }
  }

  return fields;
}

function extractPassport(text) {
  const fields = {};

  const ppMatch = text.match(/\b([A-Z][0-9]{7})\b/);
  if (ppMatch) fields['Passport Number'] = ppMatch[1];

  const dates = text.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  if (dates[0]) fields['Date of Birth'] = dates[0];
  if (dates[1]) fields['Date of Issue']  = dates[1];
  if (dates[2]) fields['Date of Expiry'] = dates[2];

  const mrzMatch = text.match(/P<IND([A-Z]+)<<([A-Z<]+)/);
  if (mrzMatch) {
    fields['Surname']    = mrzMatch[1];
    fields['Given Name'] = mrzMatch[2].replace(/</g, ' ').trim();
    fields['Name']       = (mrzMatch[1] + ' ' + fields['Given Name']).trim();
  }

  if (/\bINDIA\b|\bIndian\b/i.test(text)) fields['Nationality'] = 'Indian';

  const sexMatch = text.match(/Sex[:\s]+([MF])/i) || text.match(/\b(MALE|FEMALE)\b/i);
  if (sexMatch) {
    const v = sexMatch[1].toUpperCase();
    fields['Gender'] = v === 'M' ? 'Male' : v === 'F' ? 'Female' : v;
  }

  return fields;
}

// ── Academic extractors (shared logic via parseScore + extractNameFromText) ────

function buildAcademicFields(text) {
  const fields = {};

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  const score = parseScore(text);
  if (score) {
    fields['Score Type']    = score.scoreType;
    fields['Display Score'] = score.displayScore;
    fields['Percentage']    = score.percentage.toFixed(2) + '%';
    if (score.scoreType === 'CGPA')  fields['CGPA']  = score.displayScore;
    if (score.scoreType === 'Marks') fields['Marks'] = score.displayScore;
    if (score.scoreType === 'Grade') fields['Grade'] = score.displayScore;
  }

  const yearMatch =
    text.match(/(?:Year of Passing|Passing Year|Year)[:\s]*(20\d{2})/i) ||
    text.match(/\b(20\d{2})\b/);
  if (yearMatch) fields['Year of Passing'] = yearMatch[1];

  const boardPatterns = ['CBSE','ICSE','ISC','BSEAP','BSEM','HPBOSE','MPBSE','RBSE','WBBSE','Maharashtra State Board'];
  let foundBoard = false;
  for (const b of boardPatterns) {
    if (text.includes(b)) { fields['Board / University'] = b; foundBoard = true; break; }
  }
  if (!foundBoard) {
    const boardMatch = text.match(/(?:Board|University)[:\s]+([A-Z][^\n]{3,60})/i);
    if (boardMatch) fields['Board / University'] = boardMatch[1].trim();
  }

  const divMatch = text.match(/(?:Division|Class)[:\s]+(First|Second|Third|Distinction|Pass)/i);
  if (divMatch) fields['Division'] = divMatch[1];

  return fields;
}

function extractAcademic(text) {
  return buildAcademicFields(text);
}

function extractPC(text) {
  const fields = buildAcademicFields(text);

  const uniMatch = text.match(/(?:University|Institute|College)[:\s]+([A-Z][^\n]{3,60})/i);
  if (uniMatch && !fields['Board / University']) fields['University'] = uniMatch[1].trim();

  const degreeMatch = text.match(/(?:Bachelor|Master|B\.Tech|M\.Tech|B\.E|M\.E|B\.Sc|M\.Sc|B\.Com|MBA)[^\n]*/i);
  if (degreeMatch) fields['Degree'] = degreeMatch[0].trim().substring(0, 60);

  return fields;
}

function extractOther(text) {
  const fields = {};

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  const dateMatch =
    text.match(/(?:Date|Issued|Valid)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i) ||
    text.match(/\b(\d{2}[\/\-]\d{2}[\/\-]\d{4})\b/);
  if (dateMatch) fields['Date'] = dateMatch[1];

  const refMatch = text.match(/(?:No\.|Number|Ref|ID|Roll|Reg|Registration)[:\s.#]+([A-Z0-9\/\-]{5,20})/i);
  if (refMatch) fields['Reference No.'] = refMatch[1].trim();

  return fields;
}

// ── Main dispatcher ────────────────────────────────────────────────────────────

function parseDocument(extraction) {
  const { subFolder = '', sourceFile = '', extractedText = '' } = extraction;
  const type = detectDocumentType(subFolder, sourceFile);
  let fields = {};

  switch (type) {
    case 'aadhaar':  fields = extractAadhaar(extractedText);  break;
    case 'pan':      fields = extractPAN(extractedText);      break;
    case 'passport': fields = extractPassport(extractedText); break;
    case 'pc':       fields = extractPC(extractedText);       break;
    case '10th':
    case '12th':
    case 'degree':
    case 'diploma':  fields = extractAcademic(extractedText); break;
    default:         fields = extractOther(extractedText);    break;
  }

  return { type, subFolder, sourceFile, fields };
}

const ACADEMIC_TYPES = new Set(['10th', '12th', 'degree', 'diploma', 'pc']);

function getPercentageInfo(pctStr) {
  if (!pctStr) return null;
  const val = parseFloat(pctStr);
  if (isNaN(val)) return null;
  if (val >= 75) return { val, color: '#14532d', bg: '#dcfce7', border: '#16a34a', label: 'Excellent',      eligibility: 'HIGH',        badge: '#16a34a' };
  if (val >= 60) return { val, color: '#1e3a8a', bg: '#dbeafe', border: '#2563eb', label: 'Good',           eligibility: 'ELIGIBLE',    badge: '#2563eb' };
  if (val >= 50) return { val, color: '#78350f', bg: '#fef9c3', border: '#d97706', label: 'Average',        eligibility: 'CONDITIONAL', badge: '#d97706' };
  return            { val, color: '#7f1d1d', bg: '#fee2e2', border: '#dc2626', label: 'Below Average', eligibility: 'LOW',         badge: '#dc2626' };
}

module.exports = { parseDocument, getPercentageInfo, ACADEMIC_TYPES };
