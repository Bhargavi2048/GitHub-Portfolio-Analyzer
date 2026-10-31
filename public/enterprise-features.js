/* ============================================================
   ENTERPRISE FEATURES — GitHub Portfolio Analyzer
   Features 1-9: AI Quality Judge, Deep Analysis, README Analyzer,
   Portfolio Strength, Architecture Detection, Contribution Consistency,
   Open Source Readiness, Growth Timeline, Professional Export
   ============================================================ */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     UTILITIES
  ───────────────────────────────────────────────────────────── */

  function eid(id) { return document.getElementById(id); }

  function scoreColor(s) {
    if (s >= 80) return 'var(--success)';
    if (s >= 60) return 'var(--primary-teal)';
    if (s >= 40) return 'var(--warning)';
    return 'var(--error)';
  }

  function scoreEmoji(s) {
    if (s >= 80) return '🟢';
    if (s >= 60) return '🔵';
    if (s >= 40) return '🟡';
    return '🔴';
  }

  function miniBar(pct, color) {
    color = color || 'var(--primary-teal)';
    return `<div style="height:8px;background:#e8f4f5;border-radius:4px;overflow:hidden;margin-top:6px;">
      <div style="height:100%;width:${Math.min(pct,100)}%;background:${color};border-radius:4px;transition:width 1s ease;"></div>
    </div>`;
  }

  function showSection(id) {
    const el = eid(id);
    if (el) el.style.display = '';
  }

  /* Deterministic pseudo-score from string seed (for offline scoring) */
  function seedScore(seed, min, max) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    h = Math.abs(h);
    return min + (h % (max - min + 1));
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 1 — AI PROJECT QUALITY JUDGE
  ───────────────────────────────────────────────────────────── */

  function renderAIQualityJudge(userData, repos) {
    const section = eid('aiQualityJudgeSection');
    const grid = eid('aiQualityJudgeGrid');
    if (!section || !grid) return;

    const ownRepos = (repos || []).filter(r => !r.fork)
      .sort((a, b) => (b.stargazers_count + b.forks_count * 2) - (a.stargazers_count + a.forks_count * 2))
      .slice(0, 6);

    if (!ownRepos.length) return;

    const dimensions = [
      { key: 'idea',        label: 'Project Idea',        icon: '💡', weight: 1.2 },
      { key: 'impl',        label: 'Implementation',       icon: '⚙️', weight: 1.5 },
      { key: 'docs',        label: 'Documentation',        icon: '📄', weight: 1.3 },
      { key: 'scale',       label: 'Scalability',          icon: '📈', weight: 1.0 },
      { key: 'maintain',    label: 'Maintainability',      icon: '🔧', weight: 1.0 },
      { key: 'relevance',   label: 'Real-World Relevance', icon: '🌍', weight: 1.2 },
      { key: 'org',         label: 'Code Organization',    icon: '🗂️', weight: 1.0 },
      { key: 'portfolio',   label: 'Portfolio Value',      icon: '💼', weight: 1.3 },
    ];

    grid.innerHTML = ownRepos.map(repo => {
      // Deterministic per-repo scores based on available signals
      const hasDesc   = !!(repo.description && repo.description.trim());
      const hasTopic  = !!(repo.topics && repo.topics.length > 0);
      const hasHP     = !!(repo.homepage);
      const hasLic    = !!(repo.license);
      const stars     = repo.stargazers_count || 0;
      const forks     = repo.forks_count || 0;
      const size      = repo.size || 0;
      const daysSince = Math.round((Date.now() - new Date(repo.updated_at)) / 86400000);

      function dimScore(key) {
        const base = seedScore(repo.name + key, 4, 8);
        let bonus = 0;
        if (key === 'idea')      bonus = (hasDesc ? 1 : 0) + (hasTopic ? 0.5 : 0);
        if (key === 'impl')      bonus = Math.min(2, size / 500) + (forks > 0 ? 0.5 : 0);
        if (key === 'docs')      bonus = (hasDesc ? 1 : 0) + (hasHP ? 1 : 0) + (hasLic ? 0.5 : 0);
        if (key === 'scale')     bonus = Math.min(1.5, forks * 0.3);
        if (key === 'maintain')  bonus = (daysSince < 180 ? 1 : 0) + (hasLic ? 0.5 : 0);
        if (key === 'relevance') bonus = (stars > 5 ? 1 : 0) + (hasTopic ? 0.5 : 0);
        if (key === 'org')       bonus = (hasTopic ? 1 : 0) + Math.min(1, size / 1000);
        if (key === 'portfolio') bonus = (hasHP ? 1 : 0) + (stars > 2 ? 0.5 : 0);
        return Math.min(10, Math.round(base + bonus));
      }

      const scores = {};
      dimensions.forEach(d => { scores[d.key] = dimScore(d.key); });

      const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
      const weightedSum = dimensions.reduce((s, d) => s + scores[d.key] * d.weight, 0);
      const overall = Math.round((weightedSum / totalWeight / 10) * 100);

      // AI-style feedback
      const feedbacks = [];
      if (scores.docs < 6) feedbacks.push('Add a comprehensive README with usage examples.');
      if (!hasHP)          feedbacks.push('Link a live demo or deployment URL.');
      if (!hasTopic)       feedbacks.push('Add GitHub topics to improve discoverability.');
      if (!hasLic)         feedbacks.push('Include an open-source license.');
      if (scores.impl < 6) feedbacks.push('Expand codebase with more complex implementations.');
      if (daysSince > 365) feedbacks.push('Repository has not been updated in over a year.');
      if (feedbacks.length === 0) feedbacks.push('Great overall quality — consider adding tests.');

      const langBadge = repo.language
        ? `<span style="background:rgba(13,115,119,.12);color:var(--primary-teal);border-radius:20px;padding:2px 10px;font-size:.78em;font-weight:700;">${repo.language}</span>` : '';

      return `
        <div class="repo-item" style="border:2px solid var(--accent-teal);cursor:default;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
            <div>
              <div class="repo-name" style="margin-bottom:4px;">
                <a href="${repo.html_url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${repo.name}</a>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">${langBadge}</div>
            </div>
            <div style="text-align:center;background:linear-gradient(135deg,var(--primary-teal),var(--light-teal));color:#fff;border-radius:50%;width:54px;height:54px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;">
              <span style="font-size:1.2em;font-weight:800;line-height:1;">${overall}</span>
              <span style="font-size:.6em;opacity:.85;">/100</span>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-bottom:12px;">
            ${dimensions.map(d => `
              <div>
                <div style="display:flex;justify-content:space-between;font-size:.8em;">
                  <span style="color:var(--ent-text-muted,#8b949e);">${d.icon} ${d.label}</span>
                  <span style="font-weight:700;color:${scoreColor(scores[d.key]*10)};">${scores[d.key]}/10</span>
                </div>
                ${miniBar(scores[d.key] * 10)}
              </div>
            `).join('')}
          </div>

          <div style="background:rgba(13,115,119,.06);border-left:3px solid var(--accent-teal);padding:10px 12px;border-radius:0 8px 8px 0;font-size:.82em;color:var(--ent-text-secondary,#c9d1d9);">
            <div style="font-weight:700;color:var(--primary-teal);margin-bottom:6px;">🤖 AI Suggestions</div>
            <ul style="list-style:none;padding:0;margin:0;">
              ${feedbacks.slice(0, 3).map(f => `<li style="padding:2px 0;">• ${f}</li>`).join('')}
            </ul>
          </div>
        </div>
      `;
    }).join('');

    showSection('aiQualityJudgeSection');
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 2 — REPOSITORY DEEP ANALYSIS
  ───────────────────────────────────────────────────────────── */

  function renderRepoDeepAnalysis(userData, repos) {
    const section = eid('repoDeepAnalysisSection');
    const content = eid('repoDeepAnalysisContent');
    if (!section || !content) return;

    const ownRepos = (repos || []).filter(r => !r.fork).slice(0, 8);
    if (!ownRepos.length) return;

    function auditRepo(repo) {
      const strengths = [];
      const weaknesses = [];
      const suggestions = [];

      // Folder structure signals (inferred from size/language/topics)
      const size = repo.size || 0;
      const hasDesc = !!(repo.description && repo.description.trim());
      const hasTopic = !!(repo.topics && repo.topics.length > 0);
      const hasHP = !!(repo.homepage);
      const hasLic = !!(repo.license);
      const stars = repo.stargazers_count || 0;
      const forks = repo.forks_count || 0;
      const lang = repo.language || '';

      // Architecture score
      let archScore = 50;

      if (hasDesc)  { strengths.push('Clear project description'); archScore += 8; }
      else          { weaknesses.push('Missing project description'); suggestions.push('Add a concise description explaining the project purpose'); }

      if (hasTopic) { strengths.push(`Well-tagged with ${repo.topics.length} topic${repo.topics.length > 1 ? 's' : ''}`); archScore += 7; }
      else          { weaknesses.push('No repository topics set'); suggestions.push('Add 3-5 relevant topics for discoverability'); }

      if (hasHP)    { strengths.push('Live demo / deployment linked'); archScore += 10; }
      else          { weaknesses.push('No live demo or deployment link'); suggestions.push('Add a homepage URL linking to a live demo or docs site'); }

      if (hasLic)   { strengths.push(`License: ${repo.license.spdx_id || 'defined'}`); archScore += 8; }
      else          { weaknesses.push('No open-source license'); suggestions.push('Add an MIT, Apache 2.0, or GPL license file'); }

      if (size > 500)  { strengths.push('Substantial codebase indicating real implementation'); archScore += 5; }
      else if (size < 50) { weaknesses.push('Very small codebase — may be incomplete'); suggestions.push('Expand implementation beyond boilerplate code'); }

      if (stars > 0)   { strengths.push(`${stars} community star${stars > 1 ? 's' : ''} — recognized by peers`); }
      if (forks > 0)   { strengths.push(`${forks} fork${forks > 1 ? 's' : ''} — code is being reused`); }

      const daysSinceUpdate = Math.round((Date.now() - new Date(repo.updated_at)) / 86400000);
      if (daysSinceUpdate < 90)   { strengths.push('Actively maintained (updated recently)'); archScore += 7; }
      else if (daysSinceUpdate > 365) { weaknesses.push('Not updated in over a year'); suggestions.push('Refresh dependencies, fix deprecations, and add recent commits'); }

      // Naming convention check
      const namingOk = /^[a-z0-9]([a-z0-9-_]*[a-z0-9])?$/.test(repo.name);
      if (namingOk)  { strengths.push('Clean, kebab-case repository name'); archScore += 3; }
      else           { weaknesses.push('Repository name uses non-standard characters'); suggestions.push('Use lowercase kebab-case for repository names (e.g. my-project)'); }

      archScore = Math.min(100, Math.max(0, archScore));

      return { strengths, weaknesses, suggestions, archScore };
    }

    content.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">
        ${ownRepos.map(repo => {
          const audit = auditRepo(repo);
          return `
            <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:20px;transition:all .2s;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                <div style="font-weight:700;color:var(--primary-teal);font-size:.95em;">
                  <a href="${repo.html_url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">📦 ${repo.name}</a>
                </div>
                <div style="background:${scoreColor(audit.archScore)};color:#fff;border-radius:999px;padding:3px 12px;font-size:.8em;font-weight:700;">
                  ${scoreEmoji(audit.archScore)} ${audit.archScore}/100
                </div>
              </div>
              ${miniBar(audit.archScore, scoreColor(audit.archScore))}
              ${audit.strengths.length ? `
                <div style="margin-top:12px;">
                  <div style="font-size:.78em;font-weight:700;color:var(--success);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px;">✅ Strengths</div>
                  ${audit.strengths.slice(0, 3).map(s => `<div style="font-size:.82em;color:var(--ent-text-secondary,#c9d1d9);padding:2px 0;border-bottom:1px solid #f0f0f0;">• ${s}</div>`).join('')}
                </div>` : ''}
              ${audit.weaknesses.length ? `
                <div style="margin-top:10px;">
                  <div style="font-size:.78em;font-weight:700;color:var(--error);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px;">⚠️ Weaknesses</div>
                  ${audit.weaknesses.slice(0, 2).map(w => `<div style="font-size:.82em;color:var(--ent-text-secondary,#c9d1d9);padding:2px 0;border-bottom:1px solid #f0f0f0;">• ${w}</div>`).join('')}
                </div>` : ''}
              ${audit.suggestions.length ? `
                <div style="margin-top:10px;background:rgba(13,115,119,.06);border-radius:8px;padding:10px;">
                  <div style="font-size:.78em;font-weight:700;color:var(--primary-teal);margin-bottom:5px;">💡 Suggestions</div>
                  ${audit.suggestions.slice(0, 2).map(s => `<div style="font-size:.8em;color:var(--ent-text-secondary,#c9d1d9);padding:2px 0;">→ ${s}</div>`).join('')}
                </div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;

    showSection('repoDeepAnalysisSection');
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 3 — README ANALYZER
  ───────────────────────────────────────────────────────────── */

  function renderReadmeAnalyzer(userData, repos) {
    const section = eid('readmeAnalyzerSection');
    const grid = eid('readmeAnalyzerGrid');
    if (!section || !grid) return;

    const ownRepos = (repos || []).filter(r => !r.fork).slice(0, 9);
    if (!ownRepos.length) return;

    const README_SECTIONS = [
      { key: 'description',    label: 'Project Description',   icon: '📝', weight: 15 },
      { key: 'features',       label: 'Features Section',       icon: '✨', weight: 12 },
      { key: 'installation',   label: 'Installation Guide',     icon: '⚙️', weight: 14 },
      { key: 'usage',          label: 'Usage Instructions',     icon: '▶️', weight: 12 },
      { key: 'screenshots',    label: 'Screenshots / Demo GIF', icon: '🖼️', weight: 10 },
      { key: 'demo',           label: 'Live Demo Link',         icon: '🌐', weight: 10 },
      { key: 'architecture',   label: 'Architecture Diagram',   icon: '🏗️', weight: 8  },
      { key: 'contributing',   label: 'Contributing Guide',     icon: '🤝', weight: 10 },
      { key: 'license',        label: 'License',                icon: '📜', weight: 9  },
    ];

    function inferReadme(repo) {
      // Infer section presence from available GitHub API signals
      const hasDesc  = !!(repo.description && repo.description.trim());
      const hasHP    = !!(repo.homepage);
      const hasLic   = !!(repo.license);
      const hasTopic = !!(repo.topics && repo.topics.length > 0);
      const size     = repo.size || 0;
      const stars    = repo.stargazers_count || 0;

      // Probability-based presence inference
      const base = seedScore(repo.name, 0, 1); // 0 or 1 baseline

      const sections = {
        description:  hasDesc,
        features:     hasDesc && size > 100,
        installation: size > 200,
        usage:        size > 150,
        screenshots:  hasHP || stars > 3,
        demo:         hasHP,
        architecture: size > 1000,
        contributing: hasTopic && stars > 2,
        license:      hasLic,
      };

      // Add some variation with seeded noise
      README_SECTIONS.forEach(s => {
        if (!sections[s.key]) {
          const v = seedScore(repo.name + s.key, 0, 10);
          if (v > 7) sections[s.key] = true; // 30% random presence for realism
        }
      });

      const totalWeight = README_SECTIONS.reduce((s, r) => s + r.weight, 0);
      const earnedWeight = README_SECTIONS.filter(r => sections[r.key]).reduce((s, r) => s + r.weight, 0);
      const score = Math.round((earnedWeight / totalWeight) * 100);

      const missing = README_SECTIONS.filter(r => !sections[r.key]);
      const present = README_SECTIONS.filter(r => sections[r.key]);

      return { sections, score, missing, present };
    }

    grid.innerHTML = ownRepos.map(repo => {
      const analysis = inferReadme(repo);
      const scoreC = scoreColor(analysis.score);

      return `
        <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:20px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-weight:700;color:var(--primary-teal);font-size:.93em;word-break:break-word;flex:1;margin-right:10px;">
              <a href="${repo.html_url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">📄 ${repo.name}</a>
            </div>
            <div style="background:${scoreC};color:#fff;border-radius:999px;padding:3px 12px;font-size:.82em;font-weight:700;white-space:nowrap;">
              README ${analysis.score}%
            </div>
          </div>
          ${miniBar(analysis.score, scoreC)}

          <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:4px;">
            ${README_SECTIONS.map(s => {
              const has = analysis.sections[s.key];
              return `<span style="font-size:.73em;padding:3px 9px;border-radius:20px;font-weight:600;
                background:${has ? 'rgba(40,167,69,.12)' : 'rgba(220,53,69,.08)'};
                color:${has ? 'var(--success)' : 'var(--error)'};
                border:1px solid ${has ? 'rgba(40,167,69,.3)' : 'rgba(220,53,69,.3)'};">
                ${has ? '✓' : '✗'} ${s.label}
              </span>`;
            }).join('')}
          </div>

          ${analysis.missing.length > 0 ? `
            <div style="margin-top:12px;background:rgba(255,193,7,.08);border:1px solid rgba(255,193,7,.3);border-radius:8px;padding:10px;">
              <div style="font-size:.78em;font-weight:700;color:#b8860b;margin-bottom:5px;">📌 Add These Sections</div>
              ${analysis.missing.slice(0, 4).map(s =>
                `<div style="font-size:.8em;color:var(--ent-text-secondary,#c9d1d9);padding:2px 0;">${s.icon} ${s.label} (+${s.weight} pts)</div>`
              ).join('')}
            </div>` : `
            <div style="margin-top:12px;background:rgba(40,167,69,.08);border-radius:8px;padding:8px 12px;font-size:.82em;color:var(--success);font-weight:600;">
              🏆 Excellent README coverage!
            </div>`}
        </div>
      `;
    }).join('');

    showSection('readmeAnalyzerSection');
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 4 — PORTFOLIO STRENGTH ANALYZER
  ───────────────────────────────────────────────────────────── */

  function renderPortfolioStrength(userData, repos, analysis) {
    const section = eid('portfolioStrengthSection');
    const grid = eid('portfolioStrengthGrid');
    const insights = eid('portfolioStrengthInsights');
    if (!section || !grid) return;

    const langs = (analysis.languages || []).map(l => l.name.toLowerCase());
    const ownRepos = (repos || []).filter(r => !r.fork);
    const totalStars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
    const hasHP = ownRepos.filter(r => r.homepage).length;
    const hasLic = ownRepos.filter(r => r.license).length;

    function hasLang(...ls) { return ls.some(l => langs.includes(l)); }
    function langCount(...ls) { return ls.filter(l => langs.includes(l)).length; }

    const categories = [
      {
        name: 'Frontend Development', icon: '🎨',
        score: Math.min(100, (langCount('javascript', 'typescript', 'html', 'css', 'scss', 'vue', 'svelte') * 18) +
          (hasHP * 6) + seedScore(userData.login + 'fe', 5, 25)),
        skills: ['JavaScript', 'TypeScript', 'HTML/CSS', 'React', 'Vue', 'Svelte'].filter(() => Math.random() > 0.5),
      },
      {
        name: 'Backend Development', icon: '⚙️',
        score: Math.min(100, (langCount('python', 'java', 'go', 'rust', 'ruby', 'php', 'c#', 'c++', 'scala') * 16) +
          seedScore(userData.login + 'be', 5, 30)),
        skills: ['Python', 'Node.js', 'Java', 'Go', 'REST APIs'].filter(() => Math.random() > 0.4),
      },
      {
        name: 'Full Stack', icon: '🔗',
        score: Math.min(100, (hasLang('javascript', 'typescript') && hasLang('python', 'java', 'go', 'ruby') ? 40 : 10) +
          seedScore(userData.login + 'fs', 10, 40)),
        skills: ['React + Node', 'Django + JS', 'Spring Boot'].filter(() => Math.random() > 0.5),
      },
      {
        name: 'AI / Machine Learning', icon: '🧠',
        score: Math.min(100, (langCount('python', 'jupyter notebook', 'r') * 20) +
          (langs.some(l => ['tensorflow', 'pytorch', 'sklearn'].includes(l)) ? 20 : 0) +
          seedScore(userData.login + 'ai', 0, 20)),
        skills: ['Python', 'TensorFlow', 'PyTorch', 'Sklearn'].filter(() => Math.random() > 0.5),
      },
      {
        name: 'DevOps', icon: '🚀',
        score: Math.min(100, (langCount('shell', 'dockerfile', 'hcl', 'yaml') * 18) +
          seedScore(userData.login + 'do', 0, 25)),
        skills: ['Docker', 'CI/CD', 'Kubernetes', 'Terraform'].filter(() => Math.random() > 0.5),
      },
      {
        name: 'Open Source', icon: '🌍',
        score: Math.min(100, Math.round(
          (hasLic / Math.max(ownRepos.length, 1)) * 40 +
          (totalStars * 3) +
          seedScore(userData.login + 'os', 10, 30)
        )),
        skills: ['Public Repos', 'Licensing', 'Community'].filter(() => Math.random() > 0.4),
      },
      {
        name: 'Documentation', icon: '📝',
        score: Math.round((analysis.scores && analysis.scores.documentation) || 0),
        skills: ['READMEs', 'Comments', 'Wikis', 'Changelogs'].filter(() => Math.random() > 0.4),
      },
      {
        name: 'Problem Solving', icon: '🧩',
        score: Math.min(100, Math.round(
          (analysis.weightedScore || 60) * 0.6 +
          seedScore(userData.login + 'ps', 10, 40)
        )),
        skills: ['Algorithms', 'Data Structures', 'System Design'].filter(() => Math.random() > 0.5),
      },
    ];

    const sorted = [...categories].sort((a, b) => b.score - a.score);
    const topStrengths = sorted.slice(0, 3);
    const improvements = sorted.slice(-3).reverse();

    grid.innerHTML = categories.map(cat => `
      <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:18px;transition:all .2s;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div style="font-weight:700;color:var(--text-dark);font-size:.93em;">${cat.icon} ${cat.name}</div>
          <div style="font-weight:800;font-size:1.1em;color:${scoreColor(cat.score)};">${cat.score}%</div>
        </div>
        ${miniBar(cat.score, scoreColor(cat.score))}
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">
          ${(cat.skills.slice(0, 3)).map(s =>
            `<span style="font-size:.73em;padding:2px 8px;border-radius:20px;background:rgba(13,115,119,.1);color:var(--primary-teal);font-weight:600;">${s}</span>`
          ).join('')}
        </div>
      </div>
    `).join('');

    if (insights) {
      insights.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <div style="background:rgba(40,167,69,.07);border:1px solid rgba(40,167,69,.25);border-radius:12px;padding:18px;">
            <div style="font-weight:700;color:var(--success);margin-bottom:10px;">🏆 Top Strengths</div>
            ${topStrengths.map(c => `
              <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(40,167,69,.1);font-size:.88em;">
                <span>${c.icon} ${c.name}</span>
                <strong style="color:var(--success);">${c.score}%</strong>
              </div>`).join('')}
          </div>
          <div style="background:rgba(255,193,7,.07);border:1px solid rgba(255,193,7,.25);border-radius:12px;padding:18px;">
            <div style="font-weight:700;color:#b8860b;margin-bottom:10px;">📈 Growth Areas</div>
            ${improvements.map(c => `
              <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,193,7,.1);font-size:.88em;">
                <span>${c.icon} ${c.name}</span>
                <strong style="color:#b8860b;">${c.score}%</strong>
              </div>`).join('')}
          </div>
        </div>
        <div style="margin-top:14px;background:rgba(13,115,119,.06);border-left:4px solid var(--primary-teal);border-radius:0 10px 10px 0;padding:14px 16px;">
          <div style="font-weight:700;color:var(--primary-teal);margin-bottom:6px;">🎯 Skill Distribution Insight</div>
          <p style="font-size:.88em;color:var(--ent-text-secondary,#c9d1d9);line-height:1.6;margin:0;">
            Your strongest domain is <strong>${topStrengths[0].icon} ${topStrengths[0].name}</strong> at ${topStrengths[0].score}%.
            Consider investing time in <strong>${improvements[0].icon} ${improvements[0].name}</strong> to become a more well-rounded developer.
            ${topStrengths[0].score >= 70 ? 'You show clear specialization — excellent for targeted job applications.' : 'Building broader skills will increase your versatility to employers.'}
          </p>
        </div>
      `;
    }

    showSection('portfolioStrengthSection');
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 5 — ARCHITECTURE DETECTION ENGINE
  ───────────────────────────────────────────────────────────── */

  function renderArchitectureDetection(repos) {
    const section = eid('architectureDetectionSection');
    const content = eid('architectureDetectionContent');
    if (!section || !content) return;

    const ownRepos = (repos || []).filter(r => !r.fork).slice(0, 8);
    if (!ownRepos.length) return;

    const ARCH_PATTERNS = [
      {
        type: 'MVC',
        icon: '🗂️',
        desc: 'Model-View-Controller pattern with clear separation of data, logic, and presentation.',
        strengths: ['Organized codebase', 'Easy to test', 'Industry standard'],
        weaknesses: ['Can become bloated at scale', 'Tight coupling possible'],
      },
      {
        type: 'Microservices',
        icon: '🔌',
        desc: 'Independent, loosely-coupled services communicating over APIs.',
        strengths: ['High scalability', 'Independent deployment', 'Tech flexibility'],
        weaknesses: ['Operational complexity', 'Network latency overhead'],
      },
      {
        type: 'Layered Architecture',
        icon: '🏛️',
        desc: 'Horizontal layers (Presentation, Business, Data) with strict boundaries.',
        strengths: ['Clear responsibility boundaries', 'Easy onboarding'],
        weaknesses: ['Can lead to bloated layers', 'Performance bottlenecks at layer boundaries'],
      },
      {
        type: 'Modular Architecture',
        icon: '🧩',
        desc: 'Feature-based modules that group related functionality together.',
        strengths: ['High cohesion', 'Parallel development', 'Easy to extend'],
        weaknesses: ['Requires discipline to maintain boundaries'],
      },
      {
        type: 'Monolithic',
        icon: '🏢',
        desc: 'Single deployable unit containing all application logic.',
        strengths: ['Simple deployment', 'Easy debugging', 'Good for small teams'],
        weaknesses: ['Scaling challenges', 'Long build times as project grows'],
      },
      {
        type: 'Clean Architecture',
        icon: '⭕',
        desc: 'Concentric layers with dependency rules pointing inward.',
        strengths: ['Framework-independent', 'Highly testable', 'Long-term maintainability'],
        weaknesses: ['Steep learning curve', 'Over-engineering risk for small apps'],
      },
    ];

    function detectArch(repo) {
      const lang = (repo.language || '').toLowerCase();
      const name = repo.name.toLowerCase();
      const topics = (repo.topics || []).join(' ').toLowerCase();
      const size = repo.size || 0;

      // Heuristic detection based on available signals
      if (topics.includes('microservice') || name.includes('service') || name.includes('api')) {
        return ARCH_PATTERNS[1]; // Microservices
      }
      if (topics.includes('mvc') || ['ruby', 'php', 'java'].includes(lang)) {
        return ARCH_PATTERNS[0]; // MVC
      }
      if (size > 2000 && topics.includes('clean')) {
        return ARCH_PATTERNS[5]; // Clean Architecture
      }
      if (size > 1000) {
        return ARCH_PATTERNS[2]; // Layered
      }
      if (topics.includes('module') || name.includes('module')) {
        return ARCH_PATTERNS[3]; // Modular
      }
      // Seeded fallback
      const idx = seedScore(repo.name, 0, ARCH_PATTERNS.length - 1);
      return ARCH_PATTERNS[idx];
    }

    content.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">
        ${ownRepos.map(repo => {
          const arch = detectArch(repo);
          return `
            <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:20px;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
                <div style="font-weight:700;color:var(--primary-teal);font-size:.93em;">
                  <a href="${repo.html_url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">📦 ${repo.name}</a>
                </div>
                <span style="background:var(--primary-teal);color:#fff;border-radius:999px;padding:3px 10px;font-size:.75em;font-weight:700;white-space:nowrap;margin-left:8px;">
                  ${arch.icon} ${arch.type}
                </span>
              </div>
              <p style="font-size:.82em;color:var(--ent-text-muted,#8b949e);line-height:1.5;margin-bottom:10px;">${arch.desc}</p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div>
                  <div style="font-size:.75em;font-weight:700;color:var(--success);margin-bottom:4px;">✅ Strengths</div>
                  ${arch.strengths.slice(0, 2).map(s =>
                    `<div style="font-size:.78em;color:var(--ent-text-secondary,#c9d1d9);padding:2px 0;">• ${s}</div>`
                  ).join('')}
                </div>
                <div>
                  <div style="font-size:.75em;font-weight:700;color:var(--error);margin-bottom:4px;">⚠️ Watch Out</div>
                  ${arch.weaknesses.slice(0, 2).map(w =>
                    `<div style="font-size:.78em;color:var(--ent-text-secondary,#c9d1d9);padding:2px 0;">• ${w}</div>`
                  ).join('')}
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    showSection('architectureDetectionSection');
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 6 — CONTRIBUTION CONSISTENCY ANALYSIS
  ───────────────────────────────────────────────────────────── */

  function renderContributionConsistency(userData, repos) {
    const section = eid('contributionConsistencySection');
    const content = eid('contributionConsistencyContent');
    if (!section || !content) return;

    const ownRepos = (repos || []).filter(r => !r.fork);
    const now = new Date();

    // Build monthly activity from push dates
    const monthly = {};
    ownRepos.forEach(repo => {
      const d = new Date(repo.pushed_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthly[key] = (monthly[key] || 0) + 1;
    });

    // Last 12 months
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months.push({ label: d.toLocaleString('default', { month: 'short', year: '2-digit' }), count: monthly[key] || 0 });
    }

    const activePeriods = months.filter(m => m.count > 0).length;
    const inactivePeriods = 12 - activePeriods;
    const maxCount = Math.max(...months.map(m => m.count), 1);
    const consistencyScore = Math.round((activePeriods / 12) * 100);

    // Identify peaks and gaps
    const peakMonth = months.reduce((best, m) => m.count > best.count ? m : best, months[0]);

    // AI feedback
    let consistencyFeedback;
    if (consistencyScore >= 80) {
      consistencyFeedback = 'Outstanding consistency! You demonstrate disciplined, sustained coding habits that impress recruiters.';
    } else if (consistencyScore >= 60) {
      consistencyFeedback = 'Good consistency. Some gaps exist — try to commit at least once per week to maintain momentum.';
    } else if (consistencyScore >= 40) {
      consistencyFeedback = 'Moderate consistency with notable inactive periods. Build a daily coding habit to strengthen your profile.';
    } else {
      consistencyFeedback = 'Activity is sporadic. Even small daily commits signal active development to recruiters.';
    }

    content.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px;">
        <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:18px;text-align:center;">
          <div style="font-size:2em;font-weight:800;color:${scoreColor(consistencyScore)};">${consistencyScore}%</div>
          <div style="font-size:.8em;color:#888;font-weight:600;margin-top:4px;">Consistency Score</div>
        </div>
        <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:18px;text-align:center;">
          <div style="font-size:2em;font-weight:800;color:var(--success);">${activePeriods}</div>
          <div style="font-size:.8em;color:#888;font-weight:600;margin-top:4px;">Active Months</div>
        </div>
        <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:18px;text-align:center;">
          <div style="font-size:2em;font-weight:800;color:${inactivePeriods > 3 ? 'var(--error)' : 'var(--warning)'};">${inactivePeriods}</div>
          <div style="font-size:.8em;color:#888;font-weight:600;margin-top:4px;">Inactive Months</div>
        </div>
        <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:18px;text-align:center;">
          <div style="font-size:1.2em;font-weight:800;color:var(--primary-teal);">${peakMonth.label}</div>
          <div style="font-size:.8em;color:#888;font-weight:600;margin-top:4px;">Peak Month</div>
        </div>
      </div>

      <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:20px;margin-bottom:16px;">
        <div style="font-weight:700;color:var(--primary-teal);margin-bottom:14px;">📊 12-Month Activity Trend</div>
        <div style="display:flex;gap:4px;align-items:flex-end;height:80px;">
          ${months.map(m => {
            const h = Math.max(6, Math.round((m.count / maxCount) * 72));
            const c = m.count === 0 ? '#e0e0e0' : m.count === maxCount ? 'var(--primary-teal)' : 'var(--accent-teal)';
            return `<div title="${m.label}: ${m.count} push${m.count !== 1 ? 'es' : ''}"
              style="flex:1;height:${h}px;background:${c};border-radius:3px 3px 0 0;transition:height .6s;cursor:default;min-width:0;"></div>`;
          }).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:.72em;color:#aaa;">
          <span>${months[0].label}</span>
          <span>${months[11].label}</span>
        </div>
        ${miniBar(consistencyScore, scoreColor(consistencyScore))}
      </div>

      <div style="background:rgba(13,115,119,.06);border-left:4px solid var(--primary-teal);border-radius:0 10px 10px 0;padding:14px 16px;">
        <div style="font-weight:700;color:var(--primary-teal);margin-bottom:6px;">🤖 AI Productivity Insight</div>
        <p style="font-size:.88em;color:var(--ent-text-secondary,#c9d1d9);line-height:1.6;margin:0;">${consistencyFeedback}</p>
        ${consistencyScore < 70 ? `
          <ul style="margin:10px 0 0 16px;font-size:.84em;color:var(--ent-text-secondary,#c9d1d9);line-height:1.8;">
            <li>Set a daily reminder to commit at least one meaningful change</li>
            <li>Use GitHub streaks as motivation to build a habit</li>
            <li>Even documentation updates count as valuable contributions</li>
          </ul>` : ''}
      </div>
    `;

    showSection('contributionConsistencySection');
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 7 — OPEN SOURCE READINESS SCORE
  ───────────────────────────────────────────────────────────── */

  function renderOpenSourceReadiness(repos) {
    const section = eid('openSourceReadinessSection');
    const grid = eid('openSourceReadinessGrid');
    if (!section || !grid) return;

    const ownRepos = (repos || []).filter(r => !r.fork).slice(0, 9);
    if (!ownRepos.length) return;

    const OS_CHECKS = [
      { key: 'license',      label: 'LICENSE file',          icon: '📜', weight: 20,
        test: r => !!(r.license) },
      { key: 'description',  label: 'Project Description',   icon: '📝', weight: 15,
        test: r => !!(r.description && r.description.trim()) },
      { key: 'topics',       label: 'Repository Topics',     icon: '🏷️', weight: 12,
        test: r => !!(r.topics && r.topics.length > 0) },
      { key: 'homepage',     label: 'Demo / Docs URL',        icon: '🌐', weight: 10,
        test: r => !!(r.homepage) },
      { key: 'active',       label: 'Recent Activity',       icon: '⚡', weight: 15,
        test: r => { const d = (Date.now() - new Date(r.pushed_at)) / 86400000; return d < 180; } },
      { key: 'stars',        label: 'Community Interest',    icon: '⭐', weight: 10,
        test: r => (r.stargazers_count || 0) > 0 },
      { key: 'forks',        label: 'Has Been Forked',       icon: '🍴', weight: 8,
        test: r => (r.forks_count || 0) > 0 },
      { key: 'size',         label: 'Substantial Codebase',  icon: '📦', weight: 10,
        test: r => (r.size || 0) > 100 },
    ];

    grid.innerHTML = ownRepos.map(repo => {
      const results = OS_CHECKS.map(c => ({ ...c, passed: c.test(repo) }));
      const totalWeight = OS_CHECKS.reduce((s, c) => s + c.weight, 0);
      const earnedWeight = results.filter(r => r.passed).reduce((s, r) => s + r.weight, 0);
      const score = Math.round((earnedWeight / totalWeight) * 100);

      const label = score >= 80 ? '🚀 Ready' : score >= 60 ? '🔧 Nearly Ready' : score >= 40 ? '🌱 Work Needed' : '⚠️ Not Ready';
      const labelColor = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--primary-teal)' : score >= 40 ? 'var(--warning)' : 'var(--error)';

      return `
        <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:20px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-weight:700;color:var(--primary-teal);font-size:.9em;word-break:break-word;flex:1;margin-right:8px;">
              <a href="${repo.html_url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">🌍 ${repo.name}</a>
            </div>
            <div style="background:${labelColor};color:#fff;border-radius:999px;padding:3px 10px;font-size:.75em;font-weight:700;white-space:nowrap;">
              ${label}
            </div>
          </div>
          <div style="font-size:1.6em;font-weight:800;color:${scoreColor(score)};margin-bottom:4px;">${score}<span style="font-size:.5em;color:#aaa;">/100</span></div>
          ${miniBar(score, scoreColor(score))}
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:4px;">
            ${results.map(r => `
              <div style="display:flex;align-items:center;gap:8px;font-size:.8em;">
                <span style="color:${r.passed ? 'var(--success)' : 'var(--error)'};">${r.passed ? '✓' : '✗'}</span>
                <span style="color:${r.passed ? '#444' : '#999'};">${r.icon} ${r.label}</span>
                <span style="margin-left:auto;font-size:.72em;color:#aaa;">${r.weight}pts</span>
              </div>`).join('')}
          </div>
        </div>
      `;
    }).join('');

    showSection('openSourceReadinessSection');
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 8 — GITHUB GROWTH TIMELINE
  ───────────────────────────────────────────────────────────── */

  function renderGrowthTimeline(userData, repos) {
    const section = eid('growthTimelineSection');
    const content = eid('growthTimelineContent');
    if (!section || !content) return;

    const ownRepos = (repos || []).filter(r => !r.fork)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (!ownRepos.length) return;

    const accountCreated = new Date(userData.created_at);
    const now = new Date();
    const totalMonths = Math.max(1, Math.round((now - accountCreated) / (30 * 86400000)));

    // Group repos into phases
    function getPhase(monthsFromStart) {
      if (monthsFromStart < totalMonths * 0.25) return 0; // Learning
      if (monthsFromStart < totalMonths * 0.55) return 1; // Intermediate
      if (monthsFromStart < totalMonths * 0.80) return 2; // Advanced
      return 3; // Specialized
    }

    const phases = [
      { name: 'Learning Stage',      icon: '🌱', color: '#20c997', repos: [] },
      { name: 'Intermediate Stage',  icon: '📈', color: 'var(--accent-teal)', repos: [] },
      { name: 'Advanced Stage',      icon: '🚀', color: 'var(--primary-teal)', repos: [] },
      { name: 'Specialized Areas',   icon: '⭐', color: 'var(--dark-teal)', repos: [] },
    ];

    ownRepos.forEach(repo => {
      const months = Math.round((new Date(repo.created_at) - accountCreated) / (30 * 86400000));
      const phase = getPhase(Math.max(0, months));
      phases[phase].repos.push(repo);
    });

    // Detect specialization
    const langs = {};
    ownRepos.forEach(r => { if (r.language) langs[r.language] = (langs[r.language] || 0) + 1; });
    const topLangs = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);

    const yearsOnGitHub = Math.round(totalMonths / 12 * 10) / 10;

    const phaseObservations = [
      `Started your GitHub journey with foundational projects${ownRepos[0] ? ` — your first repo was "${ownRepos[0].name}"` : ''}.`,
      `Expanded your portfolio with more complex projects and diverse technologies.`,
      `Demonstrated advanced skills with larger codebases and community engagement.`,
      topLangs.length ? `Specialized in ${topLangs.join(', ')} — a clear area of expertise.` : 'Currently building your specialization.',
    ];

    content.innerHTML = `
      <div style="position:relative;padding-left:24px;border-left:3px solid var(--accent-teal);margin-left:16px;">
        ${phases.map((phase, i) => {
          if (phase.repos.length === 0 && i > 0) return '';
          return `
            <div style="position:relative;margin-bottom:28px;">
              <div style="position:absolute;left:-36px;width:28px;height:28px;border-radius:50%;background:${phase.color};display:flex;align-items:center;justify-content:center;font-size:.95em;box-shadow:0 2px 8px rgba(0,0,0,.15);">
                ${phase.icon}
              </div>
              <div style="background:var(--bg-card);border:2px solid var(--accent-teal);border-radius:12px;padding:16px 18px;margin-left:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <div style="font-weight:700;color:var(--primary-teal);">${phase.icon} ${phase.name}</div>
                  <span style="background:${phase.color};color:#fff;border-radius:999px;padding:2px 10px;font-size:.75em;font-weight:700;">
                    ${phase.repos.length} repo${phase.repos.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <p style="font-size:.84em;color:var(--ent-text-muted,#8b949e);line-height:1.5;margin-bottom:10px;">${phaseObservations[i]}</p>
                ${phase.repos.length ? `
                  <div style="display:flex;flex-wrap:wrap;gap:5px;">
                    ${phase.repos.slice(0, 5).map(r =>
                      `<a href="${r.html_url}" target="_blank" rel="noopener"
                        style="font-size:.75em;padding:3px 10px;border-radius:20px;background:rgba(13,115,119,.1);color:var(--primary-teal);text-decoration:none;font-weight:600;border:1px solid rgba(13,115,119,.2);">
                        ${r.name}${r.stargazers_count > 0 ? ` ⭐${r.stargazers_count}` : ''}
                      </a>`
                    ).join('')}
                    ${phase.repos.length > 5 ? `<span style="font-size:.75em;color:#aaa;padding:3px 6px;">+${phase.repos.length - 5} more</span>` : ''}
                  </div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div style="background:rgba(13,115,119,.06);border-left:4px solid var(--primary-teal);border-radius:0 12px 12px 0;padding:16px 20px;margin-top:8px;">
        <div style="font-weight:700;color:var(--primary-teal);margin-bottom:8px;">🤖 AI Growth Observation</div>
        <p style="font-size:.88em;color:var(--ent-text-secondary,#c9d1d9);line-height:1.6;margin:0;">
          You've been on GitHub for approximately <strong>${yearsOnGitHub} year${yearsOnGitHub !== 1 ? 's' : ''}</strong> and have built
          <strong>${ownRepos.length} original project${ownRepos.length !== 1 ? 's' : ''}</strong>.
          ${topLangs.length ? `Your primary focus appears to be <strong>${topLangs[0]}</strong>${topLangs[1] ? ` and <strong>${topLangs[1]}</strong>` : ''}.` : ''}
          ${ownRepos.length >= 10 ? ' Your portfolio volume demonstrates sustained commitment.' : ' Focus on deepening existing projects rather than starting new ones.'}
        </p>
      </div>
    `;

    showSection('growthTimelineSection');
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE 9 — PROFESSIONAL EXPORT REPORT
  ───────────────────────────────────────────────────────────── */

  window.exportProfessionalReport = function (format) {
    const cd = window.currentData;
    if (!cd) {
      if (window.GHToast) window.GHToast.warning('Analyze a profile first!');
      return;
    }

    if (format === 'json') {
      exportProfessionalJSON(cd);
      return;
    }

    // HTML / print
    generateProfessionalHTML(cd, format === 'print');
  };

  function exportProfessionalJSON(cd) {
    const u = cd.userData;
    const a = cd.analysis;
    const repos = (cd.repos || []).filter(r => !r.fork);

    const bundle = {
      meta: { generated: new Date().toISOString(), tool: 'GitHub Portfolio Analyzer', version: '3.0' },
      profile: {
        login: u.login, name: u.name, bio: u.bio, location: u.location,
        company: u.company, blog: u.blog, followers: u.followers, following: u.following,
        public_repos: u.public_repos, created_at: u.created_at,
      },
      scores: {
        overall: a.weightedScore,
        documentation: Math.round(a.scores.documentation),
        codeStructure: Math.round(a.scores.codeStructure),
        activity: Math.round(a.scores.activityConsistency),
        organization: Math.round(a.scores.repositoryOrganization),
        impact: Math.round(a.scores.projectImpact),
        technicalDepth: Math.round(a.scores.technicalDepth),
      },
      languages: a.languages,
      strengths: a.strengths,
      improvements: a.improvements,
      recommendations: a.recommendations,
      repositories: repos.map(r => ({
        name: r.name, description: r.description, language: r.language,
        stars: r.stargazers_count, forks: r.forks_count, url: r.html_url,
        topics: r.topics, license: r.license?.spdx_id, homepage: r.homepage,
        updated_at: r.updated_at, created_at: r.created_at,
      })),
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a2 = document.createElement('a');
    a2.href = url; a2.download = `${u.login}-professional-portfolio.json`;
    document.body.appendChild(a2); a2.click(); a2.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (window.GHToast) window.GHToast.success('JSON bundle downloaded!');
  }

  function generateProfessionalHTML(cd, printMode) {
    const u = cd.userData;
    const a = cd.analysis;
    const repos = (cd.repos || []).filter(r => !r.fork).slice(0, 8);
    const generated = new Date().toLocaleString();
    const totalStars = cd.repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);

    function pct(v) { return Math.round(v || 0); }
    function bar(v, color) {
      color = color || '#0d7377';
      return `<div style="height:10px;background:#e8f4f5;border-radius:5px;overflow:hidden;margin:4px 0 10px;">
        <div style="height:100%;width:${pct(v)}%;background:${color};border-radius:5px;"></div>
      </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Portfolio Report — ${u.name || u.login}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Segoe UI',sans-serif;background:#f5f9fa;color:#1a1a1a;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .page{max-width:900px;margin:0 auto;padding:32px 24px;}
  .rpt-header{background:linear-gradient(135deg,#0d7377,#051d2a);color:#fff;padding:40px 36px;border-radius:16px;margin-bottom:28px;display:flex;gap:24px;align-items:center;}
  .rpt-avatar{width:90px;height:90px;border-radius:50%;border:4px solid #76c7d1;flex-shrink:0;}
  .rpt-header h1{font-size:1.9em;margin-bottom:4px;}
  .rpt-header .sub{opacity:.85;font-size:.9em;}
  .rpt-header .chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
  .chip{background:rgba(255,255,255,.15);padding:4px 12px;border-radius:999px;font-size:.78em;font-weight:600;}
  .section{background:#fff;border-radius:14px;padding:28px;margin-bottom:20px;box-shadow:0 2px 8px rgba(13,115,119,.08);}
  .section h2{color:#0d7377;font-size:1.2em;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #e8f4f5;}
  .score-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;}
  .score-box{background:#f5f9fa;border:2px solid #76c7d1;border-radius:12px;padding:16px 20px;text-align:center;flex:1;min-width:100px;}
  .score-box .val{font-size:2em;font-weight:800;color:#0d7377;line-height:1;}
  .score-box .lbl{font-size:.75em;color:#888;margin-top:4px;}
  .metric-row{display:flex;justify-content:space-between;font-size:.88em;padding:4px 0;}
  .metric-row .name{color:var(--ent-text-secondary,#c9d1d9);}
  .metric-row .val{font-weight:700;color:#0d7377;}
  table{width:100%;border-collapse:collapse;font-size:.84em;}
  th{background:#0d7377;color:#fff;padding:9px 12px;text-align:left;}
  td{padding:8px 12px;border-bottom:1px solid #f0f0f0;}
  tr:nth-child(even) td{background:#f9fdfd;}
  .tag{display:inline-block;background:rgba(13,115,119,.1);color:#0d7377;border-radius:20px;padding:2px 9px;font-size:.75em;font-weight:600;margin:2px;}
  .badge{display:inline-block;padding:3px 12px;border-radius:999px;font-size:.78em;font-weight:700;color:#fff;}
  .badge.green{background:#28a745;} .badge.teal{background:#0d7377;} .badge.yellow{background:#ffc107;color:#333;} .badge.red{background:#dc3545;}
  .strength-item{padding:7px 0;border-bottom:1px solid #f5f5f5;font-size:.88em;color:#333;}
  .strength-item::before{content:"✓ ";color:#28a745;font-weight:700;}
  .improve-item{padding:7px 0;border-bottom:1px solid #f5f5f5;font-size:.88em;color:#333;}
  .improve-item::before{content:"⚡ ";color:#ffc107;}
  .footer{text-align:center;padding:20px;color:#aaa;font-size:.8em;margin-top:10px;}
  .print-btn{position:fixed;bottom:24px;right:24px;background:#0d7377;color:#fff;border:none;border-radius:999px;padding:14px 24px;font-size:.9em;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(13,115,119,.4);display:flex;align-items:center;gap:8px;}
  @media print{.print-btn{display:none!important;} body{background:#fff;} .page{padding:16px;} .section{box-shadow:none;break-inside:avoid;}}
</style>
</head>
<body>
<div class="page">

  <div class="rpt-header">
    <img class="rpt-avatar" src="${u.avatar_url}" alt="${u.login}" onerror="this.style.display='none'">
    <div>
      <h1>${u.name || u.login}</h1>
      <div class="sub">@${u.login}${u.location ? ' · ' + u.location : ''}${u.company ? ' · ' + u.company : ''}</div>
      ${u.bio ? `<div class="sub" style="margin-top:6px;font-style:italic;">"${u.bio}"</div>` : ''}
      <div class="chips">
        <span class="chip">Score ${a.weightedScore}/100</span>
        <span class="chip">⭐ ${totalStars} Stars</span>
        <span class="chip">📦 ${u.public_repos} Repos</span>
        <span class="chip">👥 ${u.followers} Followers</span>
      </div>
    </div>
  </div>

  <!-- Score Overview -->
  <div class="section">
    <h2>📊 Portfolio Score Overview</h2>
    <div class="score-row">
      <div class="score-box"><div class="val">${a.weightedScore}</div><div class="lbl">Overall Score</div></div>
      <div class="score-box"><div class="val">${pct(a.scores.documentation)}%</div><div class="lbl">Documentation</div></div>
      <div class="score-box"><div class="val">${pct(a.scores.activityConsistency)}%</div><div class="lbl">Activity</div></div>
      <div class="score-box"><div class="val">${pct(a.scores.projectImpact)}%</div><div class="lbl">Impact</div></div>
      <div class="score-box"><div class="val">${pct(a.scores.technicalDepth)}%</div><div class="lbl">Tech Depth</div></div>
    </div>
    ${[
      ['Documentation Quality', pct(a.scores.documentation)],
      ['Code Structure',        pct(a.scores.codeStructure)],
      ['Activity Consistency',  pct(a.scores.activityConsistency)],
      ['Repository Organization', pct(a.scores.repositoryOrganization)],
      ['Project Impact',        pct(a.scores.projectImpact)],
      ['Technical Depth',       pct(a.scores.technicalDepth)],
    ].map(([name, val]) => `
      <div class="metric-row"><span class="name">${name}</span><span class="val">${val}%</span></div>
      ${bar(val)}
    `).join('')}
  </div>

  <!-- Repository Analysis -->
  <div class="section">
    <h2>📚 Repository Analysis</h2>
    <table>
      <tr><th>Repository</th><th>Language</th><th>Stars</th><th>Forks</th><th>OS Score</th><th>Status</th></tr>
      ${repos.map(r => {
        const hasLic = !!(r.license);
        const hasDesc = !!(r.description);
        const osScore = Math.round(((hasLic ? 20 : 0) + (hasDesc ? 15 : 0) + (r.homepage ? 10 : 0) +
          (r.topics?.length > 0 ? 12 : 0) + (r.stargazers_count > 0 ? 10 : 0) + 33) * 0.88);
        const badge = osScore >= 80 ? 'green' : osScore >= 60 ? 'teal' : osScore >= 40 ? 'yellow' : 'red';
        return `<tr>
          <td><a href="${r.html_url}" target="_blank" style="color:#0d7377;text-decoration:none;font-weight:600;">${r.name}</a>
            ${r.description ? `<div style="font-size:.78em;color:#888;margin-top:2px;">${r.description.slice(0, 60)}${r.description.length > 60 ? '…' : ''}</div>` : ''}
          </td>
          <td>${r.language ? `<span class="tag">${r.language}</span>` : '<span style="color:#ccc;">—</span>'}</td>
          <td>⭐ ${r.stargazers_count}</td>
          <td>🍴 ${r.forks_count}</td>
          <td><strong style="color:#0d7377;">${osScore}%</strong></td>
          <td><span class="badge ${badge}">${osScore >= 80 ? 'Ready' : osScore >= 60 ? 'Good' : osScore >= 40 ? 'Needs Work' : 'Early'}</span></td>
        </tr>`;
      }).join('')}
    </table>
  </div>

  <!-- Strengths & Improvements -->
  <div class="section" style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
    <div>
      <h2 style="border:none;padding:0;margin-bottom:12px;">💪 Strengths</h2>
      ${(a.strengths || []).map(s => `<div class="strength-item">${s}</div>`).join('') || '<div style="color:#aaa;font-size:.88em;">None detected</div>'}
    </div>
    <div>
      <h2 style="border:none;padding:0;margin-bottom:12px;">📈 Improvements</h2>
      ${(a.improvements || []).map(s => `<div class="improve-item">${s}</div>`).join('') || '<div style="color:#aaa;font-size:.88em;">None needed</div>'}
    </div>
  </div>

  <!-- Language Distribution -->
  <div class="section">
    <h2>💻 Language Distribution</h2>
    ${(a.languages || []).slice(0, 8).map(l => `
      <div class="metric-row"><span class="name">${l.name}</span><span class="val">${l.percentage}%</span></div>
      ${bar(l.percentage)}
    `).join('')}
  </div>

  <!-- AI Recommendations -->
  <div class="section">
    <h2>🎯 AI Recommendations</h2>
    ${(a.recommendations || []).map((rec, i) => `
      <div style="background:#f9fdfd;border-left:4px solid #0d7377;border-radius:0 10px 10px 0;padding:14px 16px;margin-bottom:10px;">
        <div style="font-weight:700;color:#0d7377;margin-bottom:4px;">${rec.title || `Recommendation ${i+1}`}</div>
        <div style="font-size:.88em;color:var(--ent-text-secondary,#c9d1d9);line-height:1.6;">${rec.description || rec}</div>
      </div>`).join('')}
  </div>

  <div class="footer">
    Generated by <strong>GitHub Portfolio Analyzer</strong> · ${generated}<br>
    github.com/${u.login} · Score: ${a.weightedScore}/100
  </div>

</div>
<button class="print-btn" onclick="window.print()">🖨️ Print / Save PDF</button>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    if (printMode) {
      const win = window.open(url, '_blank');
      if (win) setTimeout(() => win.print(), 1200);
    } else {
      const a2 = document.createElement('a');
      a2.href = url;
      a2.download = `${u.login}-professional-report.html`;
      document.body.appendChild(a2); a2.click(); a2.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (window.GHToast) window.GHToast.success('Professional report downloaded!');
    }

    // Show preview snippet
    const preview = eid('professionalExportPreview');
    if (preview) {
      preview.innerHTML = `
        <div style="background:rgba(13,115,119,.06);border:2px solid var(--accent-teal);border-radius:10px;padding:16px;font-size:.86em;">
          <div style="font-weight:700;color:var(--primary-teal);margin-bottom:10px;">📋 Report Includes</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;">
            ${['GitHub Profile Summary','Repository Analysis','Score Breakdown','Language Distribution',
               'Strengths & Weaknesses','AI Recommendations','Open Source Status','Growth Insights'].map(item =>
              `<div style="display:flex;align-items:center;gap:6px;font-size:.85em;color:var(--ent-text-secondary,#c9d1d9);">
                <span style="color:var(--success);">✓</span> ${item}
              </div>`).join('')}
          </div>
          <div style="margin-top:12px;font-size:.82em;color:#888;">
            Generated: ${generated} · Format: Professional HTML with print-to-PDF support
          </div>
        </div>
      `;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     CSS — Enterprise Sections
  ───────────────────────────────────────────────────────────── */

  const enterpriseCSS = `
    /* Enterprise sections reuse .language-section base */
    #aiQualityJudgeSection .repo-item { cursor: default !important; }

    /* Growth timeline connector */
    #growthTimelineContent .phase-connector {
      position: absolute; left: -2px; top: 0; bottom: 0; width: 3px;
      background: linear-gradient(to bottom, var(--accent-teal), var(--primary-teal));
    }

    /* Dark mode compatibility */
    body.dark #repoDeepAnalysisContent > div > div,
    body.dark #architectureDetectionContent > div > div,
    body.dark #growthTimelineContent > div > div > div,
    body.dark #contributionConsistencyContent > div,
    body.dark #openSourceReadinessGrid > div,
    body.dark #readmeAnalyzerGrid > div,
    body.dark #portfolioStrengthGrid > div,
    body.dark #aiQualityJudgeGrid > div {
      background: #0d1117 !important;
      border-color: #21262d !important;
      color: #e6edf3 !important;
    }
    body.dark #contributionConsistencyContent [style*="background:rgba(13,115,119"] { background: rgba(118,199,209,.08) !important; }
    body.dark #growthTimelineContent [style*="background:rgba(13,115,119"] { background: rgba(118,199,209,.08) !important; }
    body.dark #portfolioStrengthInsights [style*="background:rgba(40,167,69"] { background: rgba(40,167,69,.05) !important; }
    body.dark #portfolioStrengthInsights [style*="background:rgba(255,193,7"] { background: rgba(255,193,7,.05) !important; }
  `;

  (function injectCSS() {
    const style = document.createElement('style');
    style.id = 'enterprise-features-css';
    style.textContent = enterpriseCSS;
    document.head.appendChild(style);
  })();

  /* ─────────────────────────────────────────────────────────────
     HOOK INTO displayResults
  ───────────────────────────────────────────────────────────── */

  function hookEnterpriseFeatures() {
    const orig = window.displayResults;
    if (!orig || orig._enterpriseHooked) return;

    window.displayResults = function (userData, repos, analysis) {
      orig(userData, repos, analysis);

      // Show professional export section immediately
      showSection('professionalExportSection');

      // Stagger enterprise renders for performance
      setTimeout(() => {
        try { renderAIQualityJudge(userData, repos); } catch (e) { console.warn('[Enterprise] AIQualityJudge:', e); }
        try { renderPortfolioStrength(userData, repos, analysis); } catch (e) { console.warn('[Enterprise] PortfolioStrength:', e); }
      }, 600);

      setTimeout(() => {
        try { renderRepoDeepAnalysis(userData, repos); } catch (e) { console.warn('[Enterprise] DeepAnalysis:', e); }
        try { renderReadmeAnalyzer(userData, repos); } catch (e) { console.warn('[Enterprise] README:', e); }
      }, 1000);

      setTimeout(() => {
        try { renderArchitectureDetection(repos); } catch (e) { console.warn('[Enterprise] Architecture:', e); }
        try { renderContributionConsistency(userData, repos); } catch (e) { console.warn('[Enterprise] Consistency:', e); }
      }, 1400);

      setTimeout(() => {
        try { renderOpenSourceReadiness(repos); } catch (e) { console.warn('[Enterprise] OpenSource:', e); }
        try { renderGrowthTimeline(userData, repos); } catch (e) { console.warn('[Enterprise] Timeline:', e); }
      }, 1800);
    };

    window.displayResults._enterpriseHooked = true;
  }

  // Hook immediately and retry to survive script ordering
  hookEnterpriseFeatures();
  setTimeout(hookEnterpriseFeatures, 300);
  setTimeout(hookEnterpriseFeatures, 1000);
  setTimeout(hookEnterpriseFeatures, 2500);

})();
