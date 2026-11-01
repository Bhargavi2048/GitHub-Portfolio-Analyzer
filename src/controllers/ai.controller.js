const { analyzeWithAI, evaluateDeepCodeQuality } = require("../services/ai.service");

exports.feedback = async (req, res, next) => {
  try {
    const analysis = req.body?.analysis;
    if (!analysis?.profile?.login) return res.status(400).json({ error: "Missing analysis payload" });
    const ai = await analyzeWithAI(analysis);
    res.json(ai);
  } catch (e) { next(e); }
};

exports.skillGap = async (req, res, next) => {
  try {
    const { username, role } = req.body || {};
    if (!username || !role) return res.status(400).json({ error: "username and role are required" });

    const { analyze } = require("../services/github.service");
    const data = await analyze(username);
    const languages = (data.stats?.languages || []).map(l => l.name);
    const topics = (data.stats?.topRepos || []).flatMap(r => r.topics || []);

    const prompt = `You are a senior engineering career advisor. A developer named ${username} wants to become a ${role}.
Their current GitHub languages: ${languages.slice(0,8).join(", ") || "None"}.
Their project topics: ${topics.slice(0,10).join(", ") || "None"}.
Their overall score: ${data.score.total}/100 (${data.score.rank}-rank).

Respond ONLY with valid JSON (no markdown) in this exact shape:
{
  "missingSkills": ["skill1","skill2","skill3"],
  "projectIdeas": [{"title":"Project Name","description":"One sentence description"},{"title":"Project Name 2","description":"..."}],
  "nextSteps": ["Step 1","Step 2","Step 3"]
}`;

    // Call OpenAI or Gemini or fall back to structured mock
    let result;
    try {
      if (process.env.GEMINI_API_KEY) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const gRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        });
        const gData = await gRes.json();
        const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        result = JSON.parse(text.replace(/```json|```/g, "").trim());
      } else if (process.env.OPENAI_API_KEY) {
        const openaiKey = process.env.OPENAI_API_KEY;
        const oRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 600,
            temperature: 0.7,
          }),
        });
        const oData = await oRes.json();
        const text = oData.choices?.[0]?.message?.content || "{}";
        result = JSON.parse(text.replace(/```json|```/g, "").trim());
      } else {
        throw new Error("No AI key");
      }
    } catch {
      // Fallback: role-based static suggestions
      const roleMap = {
        "Frontend Dev": { missingSkills: ["TypeScript", "Accessibility (a11y)", "WebGL"], projectIdeas: [{title:"Component Library",description:"Build a reusable UI kit with Storybook."},{title:"PWA Portfolio",description:"Convert your portfolio to a Progressive Web App."}], nextSteps: ["Add TypeScript to an existing project","Learn WCAG accessibility standards","Contribute to an open-source UI framework"] },
        "Backend Dev": { missingSkills: ["gRPC", "Message Queues", "Database Indexing"], projectIdeas: [{title:"Microservice Template",description:"Build a production-ready Node.js microservice boilerplate."},{title:"API Gateway",description:"Implement a rate-limited API gateway from scratch."}], nextSteps: ["Study system design patterns","Add gRPC endpoints to an existing service","Learn Kafka or RabbitMQ basics"] },
        "Full Stack": { missingSkills: ["CI/CD Pipelines", "Docker", "Testing (E2E)"], projectIdeas: [{title:"Full Stack SaaS",description:"Build a complete SaaS app with auth, billing, and dashboards."},{title:"Real-time Chat App",description:"Create a chat app using WebSockets and React."}], nextSteps: ["Set up GitHub Actions for your repos","Dockerize an existing project","Add Playwright E2E tests to a project"] },
      };
      result = roleMap[role] || { missingSkills: ["System Design", "Testing", "Documentation"], projectIdeas: [{title:"Open Source Contribution",description:"Contribute to a popular project in your focus area."},{title:"Technical Blog",description:"Document your learnings with detailed write-ups."}], nextSteps: ["Study system design concepts","Add unit tests to existing projects","Improve README documentation"] };
    }

    res.json(result);
  } catch (e) { next(e); }
};

/**
 * Deep AI Code Quality Review Endpoint
 * Evaluates commit message hygiene, architecture, code style, and PR collaboration.
 */
exports.deepCodeReview = async (req, res, next) => {
  try {
    const { username, repo } = req.body || {};
    if (!username) return res.status(400).json({ error: "Username is required" });

    const review = await evaluateDeepCodeQuality(username, repo);
    res.json(review);
  } catch (e) {
    next(e);
  }
};
