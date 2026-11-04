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
  "ruby","rails","php","laravel","swift","objective-c","scala","elixir","r ","matlab",
  "html","css","tailwind","sass","redux","graphql","rest","grpc","websocket",
  "mongodb","postgres","postgresql","mysql","redis","sqlite","dynamodb","cassandra","elasticsearch","firebase",
  "docker","kubernetes","k8s","terraform","ansible","aws","gcp","azure","cloudflare","vercel","netlify",
  "ci/cd","github actions","jenkins","gitlab","linux","bash",
  "jest","mocha","cypress","playwright","testing","tdd",
  "ml","machine learning","deep learning","pytorch","tensorflow","keras","scikit-learn","pandas","numpy",
  "agile","scrum","jira","figma","seo",
];

function extractSkills(text) {
  const lower = text.toLowerCase();
  const found = new Set();
  for (const s of SKILL_DICT) {
    const needle = s.endsWith(" ") ? s : s + (s.length <= 2 ? " " : "");
    if (lower.includes(s)) found.add(s.trim());
  }
  return [...found];
}

/**
 * Strict Resume/CV Validation
 * Validates that the uploaded PDF is genuinely a professional resume/CV
 * and rejects invoices, homework assignments, code snippets, receipts, or non-resume documents.
 */
function validateIsResume(text) {
  const clean = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  if (wordCount < 40) {
    return {
      isValid: false,
      error: "The uploaded PDF has too little extractable text (" + wordCount + " words). Please upload a complete resume with readable text (not a scanned image without selectable text).",
    };
  }

  // Resume section indicators
  const indicators = [
    { name: "experience", regex: /\b(experience|work history|employment|employment history|work experience|professional experience|internship|job experience|responsibilities)\b/i },
    { name: "education", regex: /\b(education|academic|university|college|bachelor|master|b\.?tech|m\.?tech|b\.?e|m\.?s|b\.?s|degree|diploma|cgpa|gpa|high school|coursework)\b/i },
    { name: "skills", regex: /\b(skills|technical skills|technologies|proficiencies|competencies|programming languages|tech stack|tools & technologies)\b/i },
    { name: "projects", regex: /\b(projects|key projects|academic projects|personal projects|portfolio|open source|achievements)\b/i },
    { name: "contact", regex: /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\+?\d[\d\s().-]{8,}|\blinkedin\.com\b|\bgithub\.com\b)\b/i },
    { name: "summary", regex: /\b(summary|professional summary|executive summary|career objective|about me|profile|curriculum vitae|resume)\b/i },
  ];

  let matchedCategories = 0;
  for (const ind of indicators) {
    if (ind.regex.test(clean)) {
      matchedCategories++;
    }
  }

  // A genuine resume/CV must match at least 2 distinct resume sections or indicators
  if (matchedCategories < 2) {
    return {
      isValid: false,
      error: "The uploaded document does not appear to be a resume or CV. The ATS matcher only accepts resumes containing standard sections such as Experience, Education, Skills, and Projects.",
    };
  }

  return { isValid: true };
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

    // Lazy-require so missing dep at install doesn't crash boot
    const pdfParse = require("pdf-parse");
    const parsed = await pdfParse(req.file.buffer).catch((e) => ({ text: "", error: e.message }));
    const text = (parsed.text || "").trim();

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
