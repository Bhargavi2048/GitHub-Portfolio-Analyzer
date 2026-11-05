const request = require("supertest");
const PDFDocument = require("pdfkit");
const app = require("../src/server");
const {
  extractTextFromPdfBuffer,
  extractTextFallback,
  validateIsResume,
  extractSkills,
  atsScore,
} = require("../src/controllers/resume.controller");

function createPdfBuffer(textLines) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    for (const line of textLines) {
      doc.fontSize(12).text(line);
    }
    doc.end();
  });
}

describe("Resume Extraction and Strict ATS Validation", () => {
  describe("Dual-Engine Text Extraction", () => {
    test("extracts readable text from generated PDF via extractTextFromPdfBuffer", async () => {
      const pdf = await createPdfBuffer([
        "Bhargavi - Senior Software Engineer",
        "Email: bhargavi@example.com | Phone: +1 555 123 4567 | GitHub: github.com/bhargavi",
        "Professional Summary: Dedicated full stack engineer with 5 years experience.",
        "Work Experience: Built scalable microservices in Node.js, TypeScript, and Express at Tech Inc.",
        "Education: Bachelor of Technology in Computer Science, GPA: 3.9/4.0",
        "Technical Skills: JavaScript, TypeScript, React, Node.js, Express, Docker, MongoDB, PostgreSQL, Git",
      ]);

      const extracted = await extractTextFromPdfBuffer(pdf);
      expect(extracted).toContain("Bhargavi");
      expect(extracted).toContain("Senior Software Engineer");
      expect(extracted).toContain("Node.js");
      expect(extracted).toContain("Education");
    });

    test("fallback extractor successfully recovers text from raw PDF streams", async () => {
      const pdf = await createPdfBuffer([
        "Bhargavi Developer Portfolio",
        "Contact: bhargavi@test.com",
        "Experience: Leading engineering teams in React and Node.js",
        "Education: Degree in Computer Engineering",
        "Skills: React, Node, Express, MongoDB, Python, Docker",
      ]);

      const fallbackText = extractTextFallback(pdf);
      expect(fallbackText).toContain("Bhargavi Developer Portfolio");
      expect(fallbackText).toContain("React");
      expect(fallbackText).toContain("Education");
    });
  });

  describe("validateIsResume Strict Filtering", () => {
    test("accepts a genuine developer resume with experience, education, skills, and contact info", () => {
      const genuineResume = `
        Alex Mercer - Full Stack Software Engineer
        alex.mercer@gmail.com | +1 (555) 019-2834 | linkedin.com/in/alexmercer | github.com/alexmercer
        
        SUMMARY
        Passionate software engineer with 4+ years of experience designing and deploying high-traffic web applications.
        
        WORK EXPERIENCE
        Senior Full Stack Developer — InnoTech Labs (2022 - Present)
        • Spearheaded migration of legacy monolith to Node.js and TypeScript microservices.
        • Developed real-time user interfaces using React, Redux, and Tailwind CSS.
        • Optimized PostgreSQL database queries, reducing latency by 45%.
        
        Software Engineer — CloudScale Systems (2020 - 2022)
        • Implemented RESTful APIs and GraphQL endpoints using Express and MongoDB.
        • Configured CI/CD deployment pipelines using GitHub Actions and Docker.
        
        EDUCATION
        B.Tech in Computer Science and Engineering
        State University — Graduated Magna Cum Laude, GPA: 3.85 / 4.0
        
        TECHNICAL SKILLS
        Languages: JavaScript, TypeScript, Python, SQL
        Frameworks & Libraries: React, Node.js, Express, Next.js, Redux
        Databases & Cloud: MongoDB, PostgreSQL, Redis, Docker, AWS
      `;

      const result = validateIsResume(genuineResume);
      expect(result.isValid).toBe(true);
      expect(result.skills.length).toBeGreaterThanOrEqual(4);
      expect(result.matchedSections).toContain("Experience");
      expect(result.matchedSections).toContain("Education");
      expect(result.matchedSections).toContain("Skills");
    });

    test("strictly rejects invoices and financial documents", () => {
      const invoice = `
        TAX INVOICE #INV-88902
        Acme Solutions Inc.
        Bill To: Tech Corp Ltd.
        Email: billing@acme.com | Phone: +1 800 555 0199
        Invoice Date: October 24, 2024
        Due Date: November 24, 2024
        
        Description: Cloud Infrastructure Consulting Services
        Hours: 40 hrs @ $150/hr
        Subtotal: $6,000.00
        Tax (8.25%): $495.00
        Amount Due: $6,495.00
        Total Due: $6,495.00
        
        Payment Terms: Net 30. Please remit to payments@acme.com.
      `;

      const result = validateIsResume(invoice);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("invoice");
    });

    test("strictly rejects homework assignments and lab reports", () => {
      const homework = `
        Department of Computer Science
        Course: CS 312 - Algorithms and Data Structures
        Homework #4: Binary Search Trees and Graph Traversals
        Student: David Chen (dchen@university.edu)
        Date: November 2, 2024
        
        Problem Set 1:
        Prove that AVL tree rotations maintain the balanced height property.
        Problem Set 2:
        Implement Breadth-First Search (BFS) algorithm in Python.
        Grading Rubric: Clarity (30%), Correctness (50%), Tests (20%).
      `;

      const result = validateIsResume(homework);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("homework");
    });

    test("strictly rejects legal contracts and rental agreements", () => {
      const agreement = `
        RESIDENTIAL LEASE AGREEMENT
        This Agreement is made on November 1, 2024 between Landlord Properties LLC
        and Tenant John Smith (john.smith@example.com, phone: 555-432-1234).
        
        1. Rental Property: 456 Elm Street, Apt 3B.
        2. Lease Agreement Term: 12 months commencing December 1, 2024.
        3. Monthly Rent: $2,200 payable on the first day of each month.
        4. Security Deposit: $2,200 held in escrow.
        Terms of Service and Conditions apply.
      `;

      const result = validateIsResume(agreement);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("legal");
    });

    test("strictly rejects documents with no candidate contact info", () => {
      const noContactDoc = `
        Software Engineer Professional Overview
        Summary: Experienced coder with knowledge in front-end and back-end development across modern cloud infrastructures.
        Experience: Developed web applications in React, Node, and TypeScript at Tech Corp for over 4 continuous years.
        Education: University degree in software engineering with high honors and exemplary academic performance.
        Skills: JavaScript, React, Node.js, Express, Docker, Python, MongoDB, PostgreSQL, Git.
      `;

      const result = validateIsResume(noContactDoc);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("contact information");
    });

    test("strictly rejects documents with too few words (e.g. scanned image)", () => {
      const shortText = "Scan 001.pdf\nPage 1 of 1";
      const result = validateIsResume(shortText);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("too little extractable text");
    });

    test("strictly rejects documents without recognizable technical skills", () => {
      const nonTechResume = `
        Jane Doe — Hospitality & Catering Manager
        Email: jane.doe@hospitality.com | Phone: +1 555 987 6543
        
        Professional Summary:
        Dedicated restaurant and banquet manager with 8 years in food service and event planning.
        
        Work Experience:
        General Manager at Grand Bistro. Managed staff of 25 servers and cooks.
        Event Coordinator at Plaza Hotel. Planned weddings and business banquets.
        
        Education:
        Associate Degree in Hospitality Management, City College.
      `;

      const result = validateIsResume(nonTechResume);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("technical or software skills");
    });
  });

  describe("POST /api/resume HTTP Integration Endpoint", () => {
    test("rejects request if no file is uploaded", async () => {
      const res = await request(app).post("/api/resume");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No resume file uploaded");
    });

    test("analyzes a genuine resume PDF successfully", async () => {
      const resumePdf = await createPdfBuffer([
        "Bhargavi - Full Stack Software Engineer",
        "Email: bhargavi.dev@example.com | Phone: +1 555 333 4444 | github.com/bhargavi",
        "Professional Summary: Software engineer specializing in cloud-native JavaScript and Python applications.",
        "Work Experience: Senior Developer at CloudTech. Built microservices with Node.js, Express, and React.",
        "Education: Bachelor of Engineering in Computer Science, GPA: 3.8",
        "Technical Skills: JavaScript, TypeScript, React, Node.js, Express, MongoDB, Docker, Python, PostgreSQL",
      ]);

      const res = await request(app)
        .post("/api/resume")
        .attach("resume", resumePdf, "bhargavi_resume.pdf");

      expect(res.status).toBe(200);
      expect(res.body.filename).toBe("bhargavi_resume.pdf");
      expect(res.body.atsScore).toBeGreaterThan(50);
      expect(res.body.skills).toEqual(
        expect.arrayContaining(["javascript", "typescript", "react", "node.js"])
      );
    });

    test("rejects an invoice PDF with HTTP 400 and isNotResume flag", async () => {
      const invoicePdf = await createPdfBuffer([
        "TAX INVOICE #INV-9901",
        "Billing Company: MegaCorp",
        "Bill To: Customer Name",
        "Email: billing@megacorp.com | Phone: +1 800 123 4567",
        "Invoice Date: 2024-11-01",
        "Due Date: 2024-12-01",
        "Subtotal: $4,000.00",
        "Amount Due: $4,320.00",
        "Payment Terms: Net 30 days",
      ]);

      const res = await request(app)
        .post("/api/resume")
        .attach("resume", invoicePdf, "invoice.pdf");

      expect(res.status).toBe(400);
      expect(res.body.isNotResume).toBe(true);
      expect(res.body.error).toContain("invoice");
    });
  });
});
