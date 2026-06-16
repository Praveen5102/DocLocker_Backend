function detectDocumentType(subFolder, fileName) {
  const text = (subFolder + ' ' + fileName).toLowerCase();
  if (/adh?a+r|uid/.test(text))                               return 'aadhaar';
  if (/\bpan\b/.test(text))                                   return 'pan';
  if (/passport/.test(text))                                  return 'passport';
  if (/cibil|credit[_\s]report|credit[_\s]score/.test(text)) return 'cibil';
  if (/10th|ssc|matric|secondary/.test(text))                 return '10th';
  if (/12th|hsc|inter|plus.?two|higher.?sec/.test(text))      return '12th';
  if (/provisional|p\.?c\b/.test(text))                       return 'pc';
  if (/diploma/.test(text))                                   return 'diploma';
  if (/degree|graduation|b\.?tech|b\.?e|b\.?sc|b\.?com|b\.?a\b|mba|m\.?tech/.test(text)) return 'degree';
  if (/\bgre\b/.test(text))                                   return 'gre';
  if (/ielts/.test(text))                                     return 'ielts';
  if (/toefl/.test(text))                                     return 'toefl';
  if (/\bgmat\b/.test(text))                                  return 'gmat';
  if (/\bpte\b/.test(text))                                   return 'pte';
  if (/duolingo/.test(text))                                  return 'duolingo';
  if (/i.?20|admission.letter/.test(text))                    return 'i20';
  if (/visa.appoint|visa.slot|ds.?160/.test(text))            return 'visa_letter';
  return 'other';
}

// ── Name extractor ─────────────────────────────────────────────────────────────
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

// ── Score parser ───────────────────────────────────────────────────────────────
function parseScore(text) {
  const pctMatch =
    text.match(/(?:Percentage|Marks\s*Percentage)[:\s]+(\d{1,3}(?:\.\d{1,2})?)\s*%?/i) ||
    text.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%(?!\s*\/)/);
  if (pctMatch) {
    const val = parseFloat(pctMatch[1]);
    if (val > 0 && val <= 100) {
      return { scoreType: 'Percentage', displayScore: val.toFixed(2) + '%', percentage: val };
    }
  }

  const cgpa10 = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)\s*\/\s*10(?:\.0)?/i) ||
                 text.match(/(\d+(?:\.\d+)?)\s*\/\s*10(?:\.0)?\b(?!\d)/);
  if (cgpa10) {
    const val = parseFloat(cgpa10[1]);
    if (val >= 0 && val <= 10) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 10', percentage: val * 9.5 };
    }
  }

  const cgpa4 = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)\s*\/\s*4(?:\.0)?/i) ||
                text.match(/(\d+(?:\.\d+)?)\s*\/\s*4(?:\.0)?\b(?!\d)/);
  if (cgpa4) {
    const val = parseFloat(cgpa4[1]);
    if (val >= 0 && val <= 4) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 4.0', percentage: (val / 4.0) * 100 };
    }
  }

  const cgpa5 = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)\s*\/\s*5(?:\.0)?/i);
  if (cgpa5) {
    const val = parseFloat(cgpa5[1]);
    if (val >= 0 && val <= 5) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 5.0', percentage: (val / 5.0) * 100 };
    }
  }

  const cgpa7 = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)\s*\/\s*7(?:\.0)?/i);
  if (cgpa7) {
    const val = parseFloat(cgpa7[1]);
    if (val >= 0 && val <= 7) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 7.0', percentage: (val / 7.0) * 100 };
    }
  }

  const cgpaRaw = text.match(/CGPA[:\s]+(\d+(?:\.\d+)?)/i);
  if (cgpaRaw) {
    const val = parseFloat(cgpaRaw[1]);
    if (val >= 0 && val <= 10) {
      return { scoreType: 'CGPA', displayScore: val.toFixed(2) + ' / 10', percentage: val * 9.5 };
    }
  }

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

  // Address extraction — look for explicit "Address:" label first
  const addrLabelMatch = text.match(/(?:Address|Addr)[:\s]+([^\n]{10,}(?:\n[^\n]{3,}){0,4})/i);
  if (addrLabelMatch) {
    fields['Address'] = addrLabelMatch[1].trim().replace(/\s+/g, ' ').slice(0, 250);
  }

  // Fallback: look for S/O or D/O + subsequent lines + PIN code pattern
  if (!fields['Address']) {
    const soMatch = text.match(/(?:[SDW]\/O|C\/O)[:\s]+[^\n]+(\n[^\n]+){1,4}/i);
    if (soMatch) {
      const chunk = soMatch[0].trim().replace(/\s+/g, ' ');
      if (chunk.length > 15 && chunk.length < 300) fields['Address'] = chunk;
    }
  }

  // Fallback: capture the block preceding a 6-digit PIN
  if (!fields['Address']) {
    const pinMatch = text.match(/\b(\d{6})\b/);
    if (pinMatch) {
      const pinIdx = text.indexOf(pinMatch[0]);
      const before = text.substring(Math.max(0, pinIdx - 200), pinIdx + 6);
      const addrLines = before.split('\n').map(l => l.trim()).filter(l => l.length > 3);
      if (addrLines.length >= 2) {
        fields['Address'] = addrLines.slice(-4).join(', ');
      }
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

// ── Academic extractors ────────────────────────────────────────────────────────

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

// ── Test score extractors ──────────────────────────────────────────────────────

function extractGRE(text) {
  const fields = {};

  const totalMatch =
    text.match(/(?:Total|Combined)\s*Score[:\s]+(\d{3})\b/i) ||
    text.match(/\b(2[6-9]\d|3[0-3]\d|340)\b/);
  if (totalMatch) {
    const val = parseInt(totalMatch[1]);
    if (val >= 260 && val <= 340) fields['Score'] = val;
  }

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  return fields;
}

function extractIELTS(text) {
  const fields = {};

  const overallMatch =
    text.match(/Overall\s*(?:Band\s*)?Score[:\s]+(\d+(?:\.\d)?)/i) ||
    text.match(/Overall[:\s]+(\d+(?:\.\d)?)/i) ||
    text.match(/\b([5-9](?:\.[05])?)\b/);
  if (overallMatch) {
    const val = parseFloat(overallMatch[1]);
    if (val >= 1 && val <= 9) fields['Overall Band Score'] = val;
  }

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  return fields;
}

function extractTOEFL(text) {
  const fields = {};

  const scoreMatch =
    text.match(/Total\s*Score[:\s]+(\d+)/i) ||
    text.match(/Score[:\s]+(\d{2,3})/i);
  if (scoreMatch) {
    const val = parseInt(scoreMatch[1]);
    if (val >= 0 && val <= 120) fields['Score'] = val;
  }

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  return fields;
}

function extractGMAT(text) {
  const fields = {};

  const totalMatch =
    text.match(/Total\s*Score[:\s]+(\d{3})\b/i) ||
    text.match(/\b([2-7]\d{2})\b/);
  if (totalMatch) {
    const val = parseInt(totalMatch[1]);
    if (val >= 200 && val <= 800) fields['Score'] = val;
  }

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  return fields;
}

function extractPTE(text) {
  const fields = {};

  const scoreMatch =
    text.match(/Overall\s*Score[:\s]+(\d{2})/i) ||
    text.match(/Score[:\s]+(\d{2})/i);
  if (scoreMatch) {
    const val = parseInt(scoreMatch[1]);
    if (val >= 10 && val <= 90) fields['Score'] = val;
  }

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  return fields;
}

function extractDuolingo(text) {
  const fields = {};

  const scoreMatch =
    text.match(/(?:Overall|Score)[:\s]+(\d{2,3})/i) ||
    text.match(/(\d{2,3})\s*\/\s*160/);
  if (scoreMatch) {
    const val = parseInt(scoreMatch[1]);
    if (val >= 10 && val <= 160) fields['Score'] = val;
  }

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  return fields;
}

function extractI20(text) {
  const fields = {};

  const uniMatch =
    text.match(/(?:School|Institution|University|College|Institute)[:\s]+([A-Z][^\n]{3,80})/i);
  if (uniMatch) fields['University'] = uniMatch[1].trim().slice(0, 80);

  const programMatch =
    text.match(/(?:Program|Degree|Course|Major|Field of Study)[:\s]+([^\n]{3,80})/i);
  if (programMatch) fields['Program'] = programMatch[1].trim().slice(0, 80);

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  return fields;
}

function extractVisaLetter(text) {
  const fields = {};

  const dateMatch =
    text.match(/(?:Appointment|Interview)\s*(?:Date|Time)[:\s]+([^\n]{3,30})/i) ||
    text.match(/\b(\d{2}[\/\-]\d{2}[\/\-]\d{4})\b/);
  if (dateMatch) fields['Appointment Date'] = dateMatch[1].trim();

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

  return fields;
}

function extractCIBIL(text) {
  const fields = {};

  const scoreMatch =
    text.match(/(?:CIBIL\s+Score|Credit\s+Score|TransUnion\s+Score)[:\s]+(\d{3})/i) ||
    text.match(/\b([3-9]\d{2})\b/);
  if (scoreMatch) {
    const val = parseInt(scoreMatch[1]);
    if (val >= 300 && val <= 900) fields['Score'] = val;
  }

  const name = extractNameFromText(text);
  if (name) fields['Name'] = name;

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
    case 'aadhaar':    fields = extractAadhaar(extractedText);    break;
    case 'pan':        fields = extractPAN(extractedText);        break;
    case 'passport':   fields = extractPassport(extractedText);   break;
    case 'pc':         fields = extractPC(extractedText);         break;
    case '10th':
    case '12th':
    case 'degree':
    case 'diploma':    fields = extractAcademic(extractedText);   break;
    case 'gre':        fields = extractGRE(extractedText);        break;
    case 'ielts':      fields = extractIELTS(extractedText);      break;
    case 'toefl':      fields = extractTOEFL(extractedText);      break;
    case 'gmat':       fields = extractGMAT(extractedText);       break;
    case 'pte':        fields = extractPTE(extractedText);        break;
    case 'duolingo':   fields = extractDuolingo(extractedText);   break;
    case 'i20':        fields = extractI20(extractedText);        break;
    case 'visa_letter':fields = extractVisaLetter(extractedText); break;
    case 'cibil':      fields = extractCIBIL(extractedText);      break;
    default:           fields = extractOther(extractedText);      break;
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
