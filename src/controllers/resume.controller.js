const multer = require("multer");
const ResumeAnalysis = require("../models/ResumeAnalysis");
const { analyze } = require("../services/github.service");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("Only PDF resumes are supported"));
  },
});
exports.upload = upload.single("resume");

// Curated skill keywords for ATS matching
const SKILL_DICT = [
  "javascript","typescript","react","node","node.js","express","next.js","vue","angular","svelte",
  "python","django","flask","fastapi","java","spring","kotlin","go","golang","rust","c++","c#",".net",
  "ruby","rails","php","laravel","swift","objective-c","scala","elixir","r","matlab",
  "html","css","tailwind","sass","redux","graphql","rest","grpc","websocket",
  "mongodb","postgres","postgresql","mysql","redis","sqlite","dynamodb","cassandra","elasticsearch","firebase",
  "docker","kubernetes","k8s","terraform","ansible","aws","gcp","azure","cloudflare","vercel","netlify",
  "ci/cd","github actions","jenkins","gitlab","linux","bash",
  "jest","mocha","cypress","playwright","testing","tdd",
  "ml","machine learning","deep learning","pytorch","tensorflow","keras","scikit-learn","pandas","numpy",
  "agile","scrum","jira","figma","seo",
];

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSkills(text) {
  const clean = text.toLowerCase();
  const found = new Set();
  for (const s of SKILL_DICT) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    let pattern;
    if (trimmed === "c++") {
      pattern = /(?:^|[\s,;:(/])c\+\+(?:[\s,;:)/]|$)/i;
    } else if (trimmed === "c#") {
      pattern = /(?:^|[\s,;:(/])c#(?:[\s,;:)/]|$)/i;
    } else if (trimmed === ".net") {
      pattern = /(?:^|[\s,;:(/])\.net(?:[\s,;:)/]|$)/i;
    } else if (trimmed === "ci/cd") {
      pattern = /(?:^|[\s,;:(/])ci\/cd(?:[\s,;:)/]|$)/i;
    } else {
      pattern = new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "i");
    }
    if (pattern.test(clean)) {
      found.add(trimmed);
    }
  }
  return [...found];
}

const zlib = require("zlib");

/**
 * Robust Dual-Engine PDF Text Extraction
 * Engine 1: pdf-parse (pdf.js)
 * Engine 2: Fallback stream decompressor with ToUnicode CMap and TJ/Tj operator decoding
 * This handles modern PDFs from Canva, Word 365, Google Docs that trigger 'bad XRef entry'
 * or object streams in older pdf.js versions.
 */
function decodePdfString(raw) {
  return raw
    .replace(/\\([0-7]{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function parseCMap(str) {
  const cmap = new Map();
  const bfCharRegex = /beginbfchar([\s\S]*?)endbfchar/gi;
  let match;
  while ((match = bfCharRegex.exec(str)) !== null) {
    const lines = match[1].trim().split(/\r?\n/);
    for (const line of lines) {
      const parts = line.trim().match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (parts) {
        const src = parseInt(parts[1], 16);
        const dstCode = parseInt(parts[2], 16);
        cmap.set(src, String.fromCharCode(dstCode));
      }
    }
  }

  const bfRangeRegex = /beginbfrange([\s\S]*?)endbfrange/gi;
  while ((match = bfRangeRegex.exec(str)) !== null) {
    const lines = match[1].trim().split(/\r?\n/);
    for (const line of lines) {
      const parts = line.trim().match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (parts) {
        const start = parseInt(parts[1], 16);
        const end = parseInt(parts[2], 16);
        let dest = parseInt(parts[3], 16);
        for (let code = start; code <= end; code++) {
          cmap.set(code, String.fromCharCode(dest++));
        }
      }
    }
  }
  return cmap;
}

function decodeHex(hexStr, cMap) {
  hexStr = hexStr.replace(/\s+/g, "");
  if (hexStr.length % 2 !== 0) hexStr += "0";
  if (hexStr.length === 0) return "";

  // Attempt ToUnicode CMap lookup
  if (cMap && cMap.size > 0) {
    if (hexStr.length >= 4 && hexStr.length % 4 === 0) {
      let allMapped = true;
      let mapped = "";
      for (let i = 0; i < hexStr.length; i += 4) {
        const code = parseInt(hexStr.substring(i, i + 4), 16);
        if (cMap.has(code)) {
          mapped += cMap.get(code);
        } else {
          allMapped = false;
          break;
        }
      }
      if (allMapped && mapped.trim().length > 0) return mapped;
    }
    let all2Mapped = true;
    let mapped = "";
    for (let i = 0; i < hexStr.length; i += 2) {
      const code = parseInt(hexStr.substring(i, i + 2), 16);
      if (cMap.has(code)) {
        mapped += cMap.get(code);
      } else {
        all2Mapped = false;
        break;
      }
    }
    if (all2Mapped && mapped.trim().length > 0) return mapped;
  }

  // UTF-16BE detection
  if (hexStr.length >= 4 && hexStr.length % 4 === 0) {
    let isUtf16 = hexStr.toLowerCase().startsWith("feff");
    if (!isUtf16) {
      let nullCount = 0;
      for (let i = 0; i < hexStr.length; i += 4) {
        if (hexStr.substring(i, i + 2) === "00") nullCount++;
      }
      if (nullCount >= Math.floor(hexStr.length / 8)) isUtf16 = true;
    }
    if (isUtf16) {
      let result = "";
      const start = hexStr.toLowerCase().startsWith("feff") ? 4 : 0;
      for (let i = start; i < hexStr.length; i += 4) {
        const code = parseInt(hexStr.substring(i, i + 4), 16);
        if (code >= 32 && code <= 126) result += String.fromCharCode(code);
        else if (code === 10 || code === 13 || code === 9) result += " ";
      }
      if (result.trim().length > 0) return result;
    }
  }

  // Standard ASCII / Latin-1 hex
  let result = "";
  for (let i = 0; i < hexStr.length; i += 2) {
    const code = parseInt(hexStr.substring(i, i + 2), 16);
    if (code >= 32 && code <= 126) result += String.fromCharCode(code);
    else if (code === 10 || code === 13 || code === 9) result += " ";
  }
  return result;
}

function extractTextFromStream(streamStr, cMap) {
  const chunks = [];

  // Match TJ arrays: [ ... ] TJ
  const tjRegex = /\[([^\]]+)\]\s*TJ/gi;
  let match;
  while ((match = tjRegex.exec(streamStr)) !== null) {
    const arrayContent = match[1];
    let tjText = "";
    const tokenRegex = /\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>|(-?\d+(?:\.\d+)?)/g;
    let tokenMatch;
    while ((tokenMatch = tokenRegex.exec(arrayContent)) !== null) {
      const tok = tokenMatch[0];
      if (tok.startsWith("(") && tok.endsWith(")")) {
        tjText += decodePdfString(tok.slice(1, -1));
      } else if (tok.startsWith("<") && tok.endsWith(">")) {
        tjText += decodeHex(tok.slice(1, -1), cMap);
      } else {
        const num = parseFloat(tok);
        if (!isNaN(num) && num < -120) {
          tjText += " ";
        }
      }
    }
    if (tjText.trim()) chunks.push(tjText.trim());
  }

  // Match standalone strings: (text) Tj, <hex> Tj, ', "
  const tjSingleRegex = /(?:\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]+)>)\s*(?:Tj|'|")/gi;
  while ((match = tjSingleRegex.exec(streamStr)) !== null) {
    if (match[1] !== undefined) {
      const val = decodePdfString(match[1]).trim();
      if (val) chunks.push(val);
    } else if (match[2] !== undefined) {
      const val = decodeHex(match[2], cMap).trim();
      if (val) chunks.push(val);
    }
  }

  // Fallback: search for words in stream if no explicit operators matched
  if (chunks.length === 0) {
    const words = streamStr.match(/[A-Za-z0-9@+_.#/ -]{3,}/g) || [];
    if (words.length > 5) chunks.push(words.join(" "));
  }

  return chunks.join(" ");
}

function extractTextFallback(buffer) {
  const streamKeyword = Buffer.from("stream");
  const endStreamKeyword = Buffer.from("endstream");
  const decompressedStreams = [];

  let pos = 0;
  while (pos < buffer.length) {
    const startIdx = buffer.indexOf(streamKeyword, pos);
    if (startIdx === -1) break;

    let dataStart = startIdx + 6;
    if (dataStart < buffer.length && buffer[dataStart] === 13 && buffer[dataStart + 1] === 10) {
      dataStart += 2;
    } else if (dataStart < buffer.length && (buffer[dataStart] === 10 || buffer[dataStart] === 13)) {
      dataStart += 1;
    }

    const endIdx = buffer.indexOf(endStreamKeyword, dataStart);
    if (endIdx === -1) break;

    let dataEnd = endIdx;
    if (dataEnd > dataStart && buffer[dataEnd - 1] === 10) dataEnd--;
    if (dataEnd > dataStart && buffer[dataEnd - 1] === 13) dataEnd--;

    const streamData = buffer.subarray(dataStart, dataEnd);

    let decomp = null;
    try {
      decomp = zlib.inflateSync(streamData);
    } catch (_e1) {
      try {
        decomp = zlib.inflateRawSync(streamData);
      } catch (_e2) {
        try {
          decomp = zlib.unzipSync(streamData);
        } catch (_e3) {
          decomp = streamData;
        }
      }
    }

    if (decomp) {
      decompressedStreams.push(decomp.toString("binary"));
    }

    pos = endIdx + 9;
  }

  // Pre-scan for ToUnicode CMap
  const globalCMap = new Map();
  for (const s of decompressedStreams) {
    if (s.includes("begincmap") || s.includes("beginbfchar") || s.includes("beginbfrange")) {
      const parsed = parseCMap(s);
      for (const [k, v] of parsed.entries()) {
        globalCMap.set(k, v);
      }
    }
  }

  const chunks = [];
  for (const s of decompressedStreams) {
    if (s.includes("begincmap") && s.includes("endcmap")) continue;
    const text = extractTextFromStream(s, globalCMap);
    if (text.trim()) chunks.push(text.trim());
  }

  if (chunks.length === 0) {
    const raw = buffer.toString("utf8");
    const words = raw.match(/[A-Za-z0-9@+_.#/ -]{4,}/g) || [];
    return words.join(" ");
  }

  return chunks.join(" \n");
}

async function extractTextFromPdfBuffer(buffer) {
  // Engine 1: pdf-parse
  let text = "";
  try {
    const pdfParse = require("pdf-parse");
    const parsed = await pdfParse(buffer);
    text = (parsed.text || "").trim();
  } catch (_err) {
    text = "";
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 40) {
    return text;
  }

  // Engine 2: Fallback decompressed stream extractor (handles Canva, modern xref streams)
  try {
    const fallbackText = extractTextFallback(buffer);
    const fallbackWordCount = fallbackText.split(/\s+/).filter(Boolean).length;
    if (fallbackWordCount > wordCount) {
      return fallbackText.trim();
    }
  } catch (_err) {
    // fallback extraction failed
  }

  return text;
}

/**
 * Strict Resume/CV Validation
 * Validates that the uploaded PDF is genuinely a professional resume/CV
 * and strictly rejects invoices, receipts, homework assignments, legal contracts, or non-resume documents.
 */
function validateIsResume(text) {
  if (!text || typeof text !== "string") {
    return {
      isValid: false,
      error: "No readable text could be extracted from the uploaded document.",
    };
  }

  const clean = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // 1. Explicit Disqualifier Check (Invoices, Receipts, Homework, Legal contracts, Utility bills)
  const disqualifierRules = [
    { name: "invoice", regex: /\b(tax invoice|invoice\s*#|bill\s+to|billed\s+to|amount\s+due|balance\s+due|total\s+due|payment\s+terms|payment\s+due|subtotal|remit\s+to|purchase\s+order|po\s*#)\b/i },
    { name: "receipt", regex: /\b(receipt\s*#|transaction\s+id|total\s+paid|merchant\s+id|cashier\s*#|terminal\s*#|order\s+receipt)\b/i },
    { name: "homework", regex: /\b(homework\s*#|assignment\s*#|problem\s+set|lab\s+report|lab\s+manual|exam\s+paper|question\s+paper|midterm\s+exam|final\s+exam|grading\s+rubric)\b/i },
    { name: "legal", regex: /\b(rental\s+agreement|lease\s+agreement|tenancy\s+agreement|terms\s+of\s+service|privacy\s+policy|power\s+of\s+attorney|affidavit|non-disclosure\s+agreement)\b/i },
    { name: "utility_bill", regex: /\b(electric\s+bill|electricity\s+bill|water\s+bill|gas\s+bill|utility\s+statement|billing\s+period|meter\s+reading)\b/i }
  ];

  for (const dq of disqualifierRules) {
    if (dq.regex.test(clean)) {
      return {
        isValid: false,
        error: `Document rejected: The uploaded file appears to be a ${dq.name.replace("_", " ")} rather than a professional resume. Please upload a valid resume/CV.`,
      };
    }
  }

  if (wordCount < 40) {
    return {
      isValid: false,
      error: `The uploaded PDF has too little extractable text (${wordCount} words). Please upload a complete resume with readable text (not a scanned image without selectable text).`,
    };
  }

  if (wordCount > 4000) {
    return {
      isValid: false,
      error: "The uploaded document is too lengthy for a resume/CV (>4000 words). Resumes are typically 1-3 pages.",
    };
  }

  // 2. Candidate Contact Verification (Email, Phone, LinkedIn, GitHub)
  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(clean);
  const hasPhone = /(\+?\d[\d\s().-]{8,}\d)/.test(clean);
  const hasProfileLink = /(linkedin\.com\/|github\.com\/)/i.test(clean);
  const hasContactInfo = hasEmail || hasPhone || hasProfileLink;

  if (!hasContactInfo) {
    return {
      isValid: false,
      error: "The uploaded document does not contain candidate contact information (email address, phone number, or LinkedIn/GitHub profile). A valid resume must identify the candidate.",
    };
  }

  // 3. Core Resume Section Pillars
  const sectionPillars = [
    {
      name: "Experience",
      regex: /\b(experience|work\s+experience|professional\s+experience|employment\s+history|work\s+history|career\s+history|internships?|job\s+experience)\b/i
    },
    {
      name: "Education",
      regex: /\b(education|academic\s+background|qualifications|academic\s+history|b\.?tech|m\.?tech|b\.?e|b\.?s|m\.?s|degree|diploma|bachelor|master|university|college|cgpa|gpa)\b/i
    },
    {
      name: "Skills",
      regex: /\b(skills|technical\s+skills|core\s+competencies|technologies|tech\s+stack|programming\s+languages|tools\s+&\s+technologies|proficiencies)\b/i
    },
    {
      name: "Projects",
      regex: /\b(projects?|key\s+projects|academic\s+projects|personal\s+projects|technical\s+projects|open\s+source\s+contributions)\b/i
    },
    {
      name: "Summary",
      regex: /\b(professional\s+summary|career\s+objective|profile\s+summary|about\s+me|executive\s+summary|curriculum\s+vitae|resume)\b/i
    }
  ];

  let matchedSections = 0;
  const matchedSectionNames = [];
  for (const pillar of sectionPillars) {
    if (pillar.regex.test(clean)) {
      matchedSections++;
      matchedSectionNames.push(pillar.name);
    }
  }

  if (matchedSections < 2) {
    return {
      isValid: false,
      error: "The uploaded document lacks standard resume sections. A valid resume must contain at least 2 standard sections such as Experience, Education, Skills, or Projects.",
    };
  }

  // 4. Technical Skills Verification
  const skills = extractSkills(text);
  if (skills.length < 2) {
    return {
      isValid: false,
      error: "The uploaded document does not contain recognizable technical or software skills. The ATS Matcher requires developer resumes with technical skills.",
    };
  }

  return { isValid: true, skills, matchedSections: matchedSectionNames };
}

function atsScore(text, skills) {
  let score = 0;
  const issues = [];
  const suggestions = [];

  const wc = text.split(/\s+/).filter(Boolean).length;
  if (wc < 200) { issues.push("Resume seems too short (<200 words)"); } else { score += 15; }
  if (wc > 1200) { issues.push("Resume is very long (>1200 words)"); suggestions.push("Trim to 1 page if <8 yrs experience"); } else { score += 5; }

  const sections = ["experience","education","skills","projects"];
  for (const s of sections) {
    if (new RegExp(`\\b${s}\\b`, "i").test(text)) score += 10;
    else { issues.push(`Missing section: ${s}`); suggestions.push(`Add a clear "${s.charAt(0).toUpperCase() + s.slice(1)}" section`); }
  }

  if (/@/.test(text)) score += 5; else issues.push("No email detected");
  if (/(\+?\d[\d\s().-]{7,})/.test(text)) score += 5; else issues.push("No phone number detected");
  if (/(github\.com|linkedin\.com)/i.test(text)) score += 10; else suggestions.push("Add GitHub and LinkedIn URLs");
  if (/\b(\d{1,2}\s*(years?|yrs?))\b/i.test(text)) score += 5;
  if (skills.length >= 8) score += 15; else suggestions.push("List at least 8 concrete technical skills");
  if (/[•·▪▸]/.test(text) || /^\s*[-*]\s/m.test(text)) score += 5; else suggestions.push("Use bullet points for impact statements");

  return { score: Math.max(0, Math.min(100, score)), issues, suggestions };
}

function compareWithGithub(skills, github) {
  if (!github) return 0;
  const ghLangs = new Set((github.stats.languages || []).map((l) => l.name.toLowerCase()));
  const resumeLangs = new Set(skills.map((s) => s.toLowerCase()));
  const intersection = [...resumeLangs].filter((s) => ghLangs.has(s));
  const union = new Set([...resumeLangs, ...ghLangs]);
  return union.size ? Math.round((intersection.length / union.size) * 100) : 0;
}

exports.analyzeResume = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No resume file uploaded (field: 'resume')" });

    // Robust Dual-Engine PDF text extraction (pdf-parse + modern decompressed stream fallback)
    const text = (await extractTextFromPdfBuffer(req.file.buffer)).trim();

    // Strict validation: Reject non-resume documents
    const resumeCheck = validateIsResume(text);
    if (!resumeCheck.isValid) {
      return res.status(400).json({ error: resumeCheck.error, isNotResume: true });
    }

    const skills = extractSkills(text);
    const ats = atsScore(text, skills);

    let match = 0;
    let githubData = null;
    const githubUsername = (req.query.github || req.body?.github || "").trim();
    if (githubUsername) {
      try {
        githubData = await analyze(githubUsername);
        match = compareWithGithub(skills, githubData);
      } catch (e) {
        // continue without comparison
      }
    }

    const record = {
      user: req.user?.id,
      filename: req.file.originalname,
      text: text.slice(0, 8000),
      skills,
      atsScore: ats.score,
      issues: ats.issues,
      suggestions: ats.suggestions,
      githubUsername: githubUsername || undefined,
      matchScore: match,
    };
    if (req.user?.id) {
      ResumeAnalysis.create(record).catch(() => {});
    }

    res.json({
      filename: record.filename,
      atsScore: ats.score,
      skills,
      issues: ats.issues,
      suggestions: ats.suggestions,
      githubMatchScore: match,
      githubUsername: githubUsername || null,
      summary: {
        wordCount: text.split(/\s+/).filter(Boolean).length,
        skillsCount: skills.length,
      },
    });
  } catch (e) { next(e); }
};

exports.history = async (req, res, next) => {
  try {
    const rows = await ResumeAnalysis.find({ user: req.user.id }).sort("-createdAt").limit(50);
    res.json(rows);
  } catch (e) { next(e); }
};

exports.extractTextFromPdfBuffer = extractTextFromPdfBuffer;
exports.extractTextFallback = extractTextFallback;
exports.validateIsResume = validateIsResume;
exports.extractSkills = extractSkills;
exports.atsScore = atsScore;
