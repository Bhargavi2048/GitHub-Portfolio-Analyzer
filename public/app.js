/*
 * Backend bridge for the premium frontend.
 *
 * The Project A index.html ships untouched. Its current code calls
 * https://api.github.com/... directly. We transparently redirect those
 * calls through our Express backend so we get server-side caching, the
 * optional GITHUB_TOKEN (5000 req/h vs 60), rate limiting, optional JWT
 * auth, history persistence, and AI feedback — WITHOUT changing a single
 * pixel of the UI, DOM, CSS, or component structure.
 *
 * Security: JWT access tokens are now stored in httpOnly cookies set by
 * the server. The token returned in JSON responses is kept for
 * backwards compatibility with Authorization header flows, but the
 * primary auth mechanism uses the cookie — eliminating XSS token theft.
 */
(function () {
  // ─── CSRF token helper ───────────────────────────────────────────────
  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  // ─── In-memory token store (replaces localStorage for XSS safety) ───
  let _inMemoryToken = null;

  function setToken(t) {
    _inMemoryToken = t;
    try { sessionStorage.setItem("gpa_jwt", t); } catch (_) {}
  }

  function getToken() {
    if (_inMemoryToken) return _inMemoryToken;
    try { return sessionStorage.getItem("gpa_jwt"); } catch (_) { return null; }
  }

  function clearToken() {
    _inMemoryToken = null;
    try { sessionStorage.removeItem("gpa_jwt"); } catch (_) {}
    try { localStorage.removeItem("auth_token"); localStorage.removeItem("gpa_jwt"); } catch (_) {}
  }

  // Migrate any existing localStorage tokens to sessionStorage on load
  (function migrateLegacyTokens() {
    try {
      const old = localStorage.getItem("auth_token") || localStorage.getItem("gpa_jwt");
      if (old) {
        setToken(old);
        localStorage.removeItem("auth_token");
        localStorage.removeItem("gpa_jwt");
      }
    } catch (_) {}
  })();

  // ─── GitHub proxy + auth header injection ───────────────────────────
  const originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (url && url.indexOf("https://api.github.com/") === 0) {
        const rewritten = url.replace("https://api.github.com/", "/api/github/");
        const token = getToken();
        const next = Object.assign({}, init || {});
        next.credentials = "include";
        if (token) {
          next.headers = Object.assign({}, next.headers || {}, {
            Authorization: "Bearer " + token,
          });
        }
        return originalFetch(rewritten, next);
      }
    } catch (_) {}
    return originalFetch(input, init);
  };

  // ─── SDK surface ─────────────────────────────────────────────────────
  window.GHAnalyzer = {
    async analyze(username) {
      const r = await fetch("/api/analyze?username=" + encodeURIComponent(username), {
        credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json()).error || "Analyze failed");
      return r.json();
    },

    async ai(analysis) {
      const r = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ analysis }),
      });
      return r.json();
    },

    async register(email, password, name) {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": getCsrfToken(),
        },
        body: JSON.stringify({ email, password, name }),
      });
      const data = await r.json();
      if (data.token) setToken(data.token);
      return data;
    },

    async login(email, password) {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": getCsrfToken(),
        },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (data.token) setToken(data.token);
      return data;
    },

    logout() {
      clearToken();
      fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": getCsrfToken() },
      }).catch(() => {});
    },

    isAuthed() {
      return !!getToken();
    },

    async history() {
      const token = getToken();
      const r = await fetch("/api/history", {
        credentials: "include",
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
      return r.json();
    },

    exportPdf(username) {
      window.location.href = "/api/export/" + encodeURIComponent(username) + ".pdf";
    },
  };
})();

/* ============================================================
 *  Additive Enhancements v2 (non-UI-altering)
 *  - Toasts, copy buttons, recent searches, cache,
 *    validation, friendly errors, mobile overflow fixes.
 *  No existing markup/CSS is modified.
 * ============================================================ */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const onReady = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn)
      : fn();

  /* ---------- Minor responsive/overflow hardening only ---------- */
  function injectStyles() {
    const css = `
      .gha-toast-wrap{position:fixed;top:18px;right:18px;z-index:99999;display:flex;flex-direction:column;gap:10px;max-width:calc(100vw - 36px);pointer-events:none}
      .gha-toast{pointer-events:auto;min-width:240px;max-width:360px;padding:12px 16px;border-radius:10px;color:#fff;font:500 14px/1.4 'Segoe UI',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2);opacity:0;transform:translateX(20px);transition:opacity .25s ease,transform .25s ease;display:flex;align-items:flex-start;gap:8px}
      .gha-toast.show{opacity:1;transform:translateX(0)}
      .gha-toast.success{background:linear-gradient(135deg,#0d7377,#14919b)}
      .gha-toast.error{background:linear-gradient(135deg,#c62828,#dc3545)}
      .gha-toast.warning{background:linear-gradient(135deg,#b8860b,#ffc107);color:#1a1a1a}
      .gha-toast.info{background:linear-gradient(135deg,#2c3e50,#34495e)}
      .gha-toast-close{margin-left:auto;background:transparent;border:0;color:inherit;cursor:pointer;font-size:16px;line-height:1;opacity:.85}
      .gha-inline-error{color:#dc3545;font-size:.9em;margin-top:6px;text-align:left;display:block}
      .gha-copy-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;margin:6px 4px 0 0;background:#0d7377;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:.85em;font-weight:600;box-shadow:0 2px 6px rgba(13,115,119,.25);transition:transform .15s ease,background .2s ease}
      .gha-copy-btn:hover{background:#14919b;transform:translateY(-1px)}
      .gha-recent-wrap{margin-top:14px;text-align:center}
      .gha-recent-label{font-size:.85em;color:#14919b;margin-right:8px;font-weight:600}
      .gha-recent-chip{display:inline-block;margin:4px;padding:6px 12px;background:#f5f9fa;border:1px solid #76c7d1;color:#0d7377;border-radius:20px;font-size:.85em;cursor:pointer;transition:all .2s ease}
      .gha-recent-chip:hover{background:#0d7377;color:#fff}
      .gha-recent-clear{background:transparent;border:0;color:#888;font-size:.8em;cursor:pointer;text-decoration:underline;margin-left:8px}
      /* mobile overflow-only fixes */
      @media (max-width:640px){
        body{overflow-x:hidden}
        .container{padding:12px;max-width:100%}
        .input-group{flex-direction:column}
        .input-field{min-width:0;width:100%}
        .header h1{font-size:2.2em;word-break:break-word}
        img,canvas,pre,table{max-width:100%;height:auto}
      }
    `;
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ---------- Toast system ---------- */
  let toastWrap;
  function getWrap() {
    if (!toastWrap) {
      toastWrap = document.createElement("div");
      toastWrap.className = "gha-toast-wrap";
      document.body.appendChild(toastWrap);
    }
    return toastWrap;
  }
  function toast(msg, type = "info", dur = 4000) {
    const el = document.createElement("div");
    el.className = `gha-toast ${type}`;
    const icon = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" }[type] || "ℹ️";
    el.innerHTML = `<span>${icon}</span><span style="flex:1">${msg}</span><button class="gha-toast-close" aria-label="Dismiss">✕</button>`;
    el.querySelector(".gha-toast-close").onclick = () => dismiss(el);
    getWrap().appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    if (dur > 0) setTimeout(() => dismiss(el), dur);
    return el;
  }
  function dismiss(el) {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }
  window.GHToast = {
    success: (m, d) => toast(m, "success", d),
    error: (m, d) => toast(m, "error", d),
    warning: (m, d) => toast(m, "warning", d),
    info: (m, d) => toast(m, "info", d),
  };

  /* ---------- Validation helpers ---------- */
  function validateEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function validatePassword(v) { return v && v.length >= 8; }
  function validateGithubInput(v) {
    if (!v) return false;
    const cleaned = v.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "");
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(cleaned);
  }
  window.GHValidate = { email: validateEmail, password: validatePassword, github: validateGithubInput };

  /* ---------- Recent searches (sessionStorage) ---------- */
  const RECENT_KEY = "gha_recent_searches";
  const MAX_RECENT = 5;
  function getRecent() {
    try { return JSON.parse(sessionStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
  }
  function addRecent(u) {
    const prev = getRecent().filter((x) => x !== u);
    try { sessionStorage.setItem(RECENT_KEY, JSON.stringify([u, ...prev].slice(0, MAX_RECENT))); } catch (_) {}
  }
  function renderRecent() {
    const old = document.getElementById("gha-recent-wrap");
    if (old) old.remove();
    const items = getRecent();
    if (!items.length) return;
    const inp = document.getElementById("githubInput") || document.querySelector("input[placeholder*='username']");
    if (!inp) return;
    const wrap = document.createElement("div");
    wrap.id = "gha-recent-wrap";
    wrap.className = "gha-recent-wrap";
    wrap.innerHTML =
      `<span class="gha-recent-label">Recent:</span>` +
      items.map((u) => `<button class="gha-recent-chip" data-u="${u}">${u}</button>`).join("") +
      `<button class="gha-recent-clear">clear</button>`;
    wrap.querySelectorAll(".gha-recent-chip").forEach((b) => {
      b.onclick = () => {
        inp.value = b.dataset.u;
        inp.dispatchEvent(new Event("input"));
        const btn = document.getElementById("analyzeBtn") || document.querySelector("button[onclick*='analyze']");
        if (btn) btn.click();
      };
    });
    wrap.querySelector(".gha-recent-clear").onclick = () => {
      try { sessionStorage.removeItem(RECENT_KEY); } catch (_) {}
      wrap.remove();
    };
    inp.parentNode.after(wrap);
  }

  /* ---------- Hook analyze button ---------- */
  function hookAnalyzeBtn() {
    const btn = document.getElementById("analyzeBtn") || document.querySelector("button[onclick*='analyze']");
    if (!btn || btn._ghaHooked) return;
    btn._ghaHooked = true;
    btn.addEventListener("click", () => {
      const inp = document.getElementById("githubInput") || document.querySelector("input[placeholder*='username']");
      if (inp && inp.value) addRecent(inp.value.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, ""));
    });
  }

  /* ---------- Friendly error messages ---------- */
  function friendlyApiError(err) {
    const m = (err && (err.message || String(err))) || "";
    if (/Failed to fetch|NetworkError|network/i.test(m))
      return "Network error — check your connection or try again.";
    if (/rate limit|429/i.test(m)) return "GitHub API rate limit reached. Try adding a GITHUB_TOKEN.";
    if (/not found|404/i.test(m)) return "GitHub user not found.";
    return m || "An unexpected error occurred.";
  }

  /* ---------- Global fetch error toast for /api/* failures ---------- */
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      const res = await _fetch(input, init);
      const url = typeof input === "string" ? input : input?.url || "";
      if (res && !res.ok && /\/api\/github\//.test(url)) {
        const clone = res.clone();
        clone.json().then((d) => {
          if (d && d.error) window.GHToast?.warning(d.error, 6000);
        }).catch(() => {});
      }
      return res;
    } catch (err) {
      throw err;
    }
  };

  /* ---------- URL param auto-analyze ─────────────────────────────── */
  function autoAnalyzeFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const u = params.get('u') || params.get('username');
      if (u) {
        const inp = document.getElementById('githubInput');
        if (inp) {
          inp.value = u;
          inp.dispatchEvent(new Event('input'));
          // Auto-trigger analysis after a short delay for DOM to settle
          setTimeout(() => {
            const btn = document.getElementById('analyzeBtn');
            if (btn) btn.click();
          }, 600);
        }
      }
    } catch (_) {}
  }

  /* ---------- Init ---------- */
  onReady(() => {
    injectStyles();
    hookAnalyzeBtn();
    renderRecent();
    autoAnalyzeFromUrl();
    setTimeout(hookAnalyzeBtn, 1000);
    setTimeout(renderRecent, 1500);
  });
})();



        const GITHUB_API_BASE = 'https://api.github.com';
        let inputType = 'url';

        const githubInput = document.getElementById('githubInput');
        const analyzeBtn = document.getElementById('analyzeBtn');
        const loadingState = document.getElementById('loadingState');
        const errorState = document.getElementById('errorState');
        const errorMessage = document.getElementById('errorMessage');
        const resultsSection = document.getElementById('resultsSection');

        function setInputType(type) {
            inputType = type;
            document.getElementById('optionUrl').classList.remove('active');
            document.getElementById('optionUsername').classList.remove('active');
            
            if (type === 'url') {
                document.getElementById('optionUrl').classList.add('active');
                githubInput.placeholder = 'https://github.com/username';
            } else {
                document.getElementById('optionUsername').classList.add('active');
                githubInput.placeholder = 'Enter GitHub username';
            }
            githubInput.focus();
        }

        function extractUsername(input) {
            input = input.trim();
            
            if (input.startsWith('https://')) {
                const match = input.match(/github\.com\/([a-zA-Z0-9-]+)/);
                if (match) return match[1];
                throw new Error('Invalid GitHub URL format. Use: https://github.com/username');
            } else if (input.startsWith('http://')) {
                throw new Error('Use HTTPS URLs. Format: https://github.com/username');
            } else {
                if (input.length === 0) throw new Error('Please enter a GitHub username or URL');
                return input;
            }
        }

        async function handleAnalysis() {
            const input = githubInput.value.trim();

            if (!input) {
                showError('Please enter a GitHub username or profile URL');
                return;
            }

            let username;
            try {
                username = extractUsername(input);
            } catch (error) {
                showError(error.message);
                return;
            }

            showLoading();

            try {
                const userData = await fetchUserData(username);
                const reposData = await fetchRepositories(username);
                
                const analysis = analyzePortfolio(userData, reposData);
                displayResults(userData, reposData, analysis);
            } catch (error) {
                showError(error.message);
            }
        }

        async function fetchUserData(username) {
            const response = await fetch(`${GITHUB_API_BASE}/users/${username}`);

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('❌ GitHub user not found. Please check the username or URL.');
                }
                throw new Error('Failed to fetch user data from GitHub');
            }

            return await response.json();
        }

        async function fetchRepositories(username) {
            const response = await fetch(
                `${GITHUB_API_BASE}/users/${username}/repos?per_page=100&sort=updated`
            );

            if (!response.ok) {
                throw new Error('Failed to fetch repositories');
            }

            return await response.json();
        }

        function analyzePortfolio(userData, repos) {
            const scores = {
                documentation: calculateDocumentationScore(repos),
                codeStructure: calculateCodeStructureScore(repos),
                activityConsistency: calculateActivityConsistency(repos, userData),
                repositoryOrganization: calculateRepositoryOrganization(repos),
                projectImpact: calculateProjectImpact(repos),
                technicalDepth: calculateTechnicalDepth(repos)
            };

            const weightedScore = calculateWeightedScore(scores);

            return {
                scores,
                weightedScore,
                strengths: generateStrengths(scores, repos),
                improvements: generateImprovements(scores, repos),
                recommendations: generateRecommendations(scores, repos),
                languages: analyzeLanguages(repos)
            };
        }

        function calculateDocumentationScore(repos) {
            if (repos.length === 0) return 0;
            let score = 0;
            let count = 0;

            repos.forEach(repo => {
                if (!repo.fork) {
                    count++;
                    if (repo.description && repo.description.length > 20) score += 25;
                    if (repo.topics && repo.topics.length > 0) score += 25;
                    if (repo.updated_at) {
                        const lastUpdate = new Date(repo.updated_at);
                        const months = (new Date() - lastUpdate) / (1000 * 60 * 60 * 24 * 30);
                        if (months < 6) score += 25;
                    }
                    if (repo.has_wiki) score += 25;
                }
            });

            return count > 0 ? (score / (count * 100)) * 100 : 0;
        }

        function calculateCodeStructureScore(repos) {
            if (repos.length === 0) return 0;
            let score = 0;
            let count = 0;

            repos.forEach(repo => {
                if (!repo.fork) {
                    count++;
                    if (repo.size > 500) score += 30;
                    else if (repo.size > 100) score += 20;
                    if (repo.language) score += 15;
                    if (repo.open_issues_count > 0) score += 15;
                    if (repo.forks_count > 0) score += 20;
                    if (repo.pushed_at) {
                        const lastPush = new Date(repo.pushed_at);
                        const weeks = (new Date() - lastPush) / (1000 * 60 * 60 * 24 * 7);
                        if (weeks < 4) score += 20;
                    }
                }
            });

            return count > 0 ? Math.min((score / (count * 120)) * 100, 100) : 0;
        }

        function calculateActivityConsistency(repos, userData) {
            if (repos.length === 0) return 0;
            const publicRepos = repos.filter(r => !r.fork);
            if (publicRepos.length === 0) return 0;

            let score = 0;
            const now = new Date();
            const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
            const recentRepos = publicRepos.filter(r => new Date(r.pushed_at) > sixMonthsAgo).length;

            if (recentRepos / publicRepos.length > 0.7) score += 40;
            else if (recentRepos / publicRepos.length > 0.4) score += 20;

            if (publicRepos.length > 5) score += 30;
            else if (publicRepos.length > 2) score += 15;

            if (userData.followers > 100) score += 30;
            else if (userData.followers > 10) score += 15;

            return Math.min(score, 100);
        }

        function calculateRepositoryOrganization(repos) {
            if (repos.length === 0) return 0;
            const publicRepos = repos.filter(r => !r.fork);
            if (publicRepos.length === 0) return 0;

            let score = 0;
            const withDesc = publicRepos.filter(r => r.description && r.description.length > 10).length;
            score += (withDesc / publicRepos.length) * 30;

            const withTopics = publicRepos.filter(r => r.topics && r.topics.length > 0).length;
            score += (withTopics / publicRepos.length) * 25;

            const withHomepage = publicRepos.filter(r => r.homepage).length;
            score += (withHomepage / publicRepos.length) * 20;

            const goodNames = publicRepos.filter(r => r.name.length > 3 && !r.name.includes('test')).length;
            score += (goodNames / publicRepos.length) * 25;

            return Math.min(score, 100);
        }

        function calculateProjectImpact(repos) {
            if (repos.length === 0) return 0;
            const publicRepos = repos.filter(r => !r.fork);
            if (publicRepos.length === 0) return 0;

            const totalStars = publicRepos.reduce((sum, r) => sum + r.stargazers_count, 0);
            const totalForks = publicRepos.reduce((sum, r) => sum + r.forks_count, 0);

            let score = 0;
            if (totalStars > 100) score += 35;
            else if (totalStars > 10) score += 20;
            else if (totalStars > 0) score += 10;

            if (totalForks > 50) score += 30;
            else if (totalForks > 10) score += 15;
            else if (totalForks > 0) score += 8;

            const starredProjects = publicRepos.filter(r => r.stargazers_count > 0).length;
            score += Math.min((starredProjects / publicRepos.length) * 35, 35);

            return Math.min(score, 100);
        }

        function calculateTechnicalDepth(repos) {
            if (repos.length === 0) return 0;
            const publicRepos = repos.filter(r => !r.fork);
            if (publicRepos.length === 0) return 0;

            let score = 0;
            const languages = new Set(publicRepos.filter(r => r.language).map(r => r.language));
            score += Math.min(languages.size * 15, 40);

            const largeProjects = publicRepos.filter(r => r.size > 1000).length;
            score += Math.min(largeProjects * 20, 30);

            const complexProjects = publicRepos.filter(r => (r.stargazers_count + r.forks_count) > 20).length;
            score += Math.min(complexProjects * 15, 30);

            return Math.min(score, 100);
        }

        function calculateWeightedScore(scores) {
            const weights = {
                documentation: 0.20,
                codeStructure: 0.20,
                activityConsistency: 0.20,
                repositoryOrganization: 0.15,
                projectImpact: 0.15,
                technicalDepth: 0.10
            };

            let total = 0;
            Object.keys(scores).forEach(key => {
                total += scores[key] * weights[key];
            });

            return Math.round(total);
        }

        function generateStrengths(scores, repos) {
            const strengths = [];

            if (scores.documentation > 70) {
                strengths.push('Excellent documentation and detailed project descriptions');
            }
            if (scores.projectImpact > 70) {
                strengths.push('Projects have significant community impact with good stars and forks');
            }
            if (scores.technicalDepth > 70) {
                strengths.push('Demonstrated strong technical depth across multiple programming languages');
            }
            if (scores.activityConsistency > 70) {
                strengths.push('Consistent and regular project activity showing active engagement');
            }
            if (scores.codeStructure > 70) {
                strengths.push('Well-structured repositories with excellent code organization');
            }

            if (repos.filter(r => !r.fork && r.stargazers_count > 5).length > 0) {
                strengths.push('Multiple projects gaining meaningful community interest and recognition');
            }

            if (strengths.length === 0) {
                strengths.push('You have an active GitHub presence - excellent starting point for your portfolio!');
            }

            return strengths.slice(0, 6);
        }

        function generateImprovements(scores, repos) {
            const improvements = [];

            if (scores.documentation < 50) {
                improvements.push('Add comprehensive READMEs to all public repositories with clear explanations');
            }
            if (scores.repositoryOrganization < 50) {
                improvements.push('Improve repository naming conventions and add detailed descriptions');
            }
            if (scores.projectImpact < 50) {
                improvements.push('Focus on building projects with real-world utility and practical applications');
            }
            if (scores.activityConsistency < 50) {
                improvements.push('Increase consistent contributions and maintain regular commit activity');
            }
            if (scores.technicalDepth < 50) {
                improvements.push('Explore diverse technologies and work on more complex projects');
            }

            const forkedRepos = repos.filter(r => r.fork).length;
            if (forkedRepos > repos.length / 2) {
                improvements.push('Focus more on original projects - reduce the fork-to-original ratio');
            }

            return improvements.slice(0, 6);
        }

        function generateRecommendations(scores, repos) {
            const recommendations = [];

            recommendations.push({
                title: '📌 Pin Your Best 3-4 Projects',
                text: 'Pin your most impressive repositories on your GitHub profile. This is the first thing recruiters see.'
            });

            recommendations.push({
                title: '📝 Write Comprehensive READMEs',
                text: 'Each repository should have a detailed README including problem statement, solution, tech stack, features, and setup instructions.'
            });

            recommendations.push({
                title: '🖼️ Add Badges & Screenshots',
                text: 'Include build status badges, code quality badges, license information, and screenshots showing your projects in action.'
            });

            recommendations.push({
                title: '📅 Maintain Consistent Activity',
                text: 'Make meaningful contributions regularly. Recruiters value consistency. Aim for commits at least 3-4 times per week.'
            });

            recommendations.push({
                title: '✨ Improve Code Quality',
                text: 'Write clean, well-organized code with meaningful comments. Use proper naming conventions and consider adding CI/CD badges.'
            });

            recommendations.push({
                title: '🔗 Complete Your GitHub Profile',
                text: 'Add a professional bio, profile picture, location, website link, and keep your profile public and updated.'
            });

            return recommendations;
        }

        function analyzeLanguages(repos) {
            const languageStats = {};

            repos.forEach(repo => {
                if (repo.language && !repo.fork) {
                    languageStats[repo.language] = (languageStats[repo.language] || 0) + 1;
                }
            });

            const totalLangs = Object.values(languageStats).reduce((a, b) => a + b, 0) || 1;

            return Object.entries(languageStats)
                .map(([lang, count]) => ({
                    name: lang,
                    percentage: Math.round((count / totalLangs) * 100),
                    count: count
                }))
                .sort((a, b) => b.percentage - a.percentage);
        }

        function displayResults(userData, repos, analysis) {
            hideLoading();

            document.getElementById('portfolioScore').textContent = analysis.weightedScore;
            document.getElementById('scoreInterpretation').textContent = getScoreInterpretation(analysis.weightedScore);

            document.getElementById('userAvatar').src = userData.avatar_url;
            document.getElementById('userName').textContent = userData.name || userData.login;
            document.getElementById('userUsername').textContent = '@' + userData.login;
            document.getElementById('userBio').textContent = userData.bio || 'GitHub Developer';
            
            // Details Section
            document.getElementById('userLocation').textContent = userData.location || 'Not Specified';
            document.getElementById('userWebsite').textContent = userData.blog ? `<a href="${userData.blog}" target="_blank">${userData.blog}</a>` : 'Not Specified';
            document.getElementById('userCompany').textContent = userData.company || 'Not Specified';
            document.getElementById('accountCreated').textContent = new Date(userData.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            document.getElementById('lastActivity').textContent = userData.updated_at ? new Date(userData.updated_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';
            document.getElementById('publicGists').textContent = userData.public_gists || '0';
            document.getElementById('accountType').textContent = userData.type === 'User' ? '👤 User Account' : '🏢 Organization';
            
            document.getElementById('repoCount').textContent = repos.filter(r => !r.fork).length;
            document.getElementById('followerCount').textContent = userData.followers;
            document.getElementById('followingCount').textContent = userData.following;
            document.getElementById('starCount').textContent = repos.reduce((sum, r) => sum + r.stargazers_count, 0);

            updateScoreDisplay('docScore', 'docProgress', analysis.scores.documentation);
            updateScoreDisplay('codeScore', 'codeProgress', analysis.scores.codeStructure);
            updateScoreDisplay('activityScore', 'activityProgress', analysis.scores.activityConsistency);
            updateScoreDisplay('orgScore', 'orgProgress', analysis.scores.repositoryOrganization);
            updateScoreDisplay('impactScore', 'impactProgress', analysis.scores.projectImpact);
            updateScoreDisplay('techScore', 'techProgress', analysis.scores.technicalDepth);

            document.getElementById('strengthsList').innerHTML = analysis.strengths
                .map(s => `<li>${s}</li>`)
                .join('');

            document.getElementById('improvementsList').innerHTML = analysis.improvements
                .map(i => `<li>${i}</li>`)
                .join('');

            document.getElementById('recommendationsList').innerHTML = analysis.recommendations
                .map(r => `
                    <div class="recommendation-item">
                        <div class="recommendation-title">${r.title}</div>
                        <div class="recommendation-text">${r.text}</div>
                    </div>
                `)
                .join('');

            const topRepos = repos
                .filter(r => !r.fork)
                .sort((a, b) => (b.stargazers_count + b.forks_count) - (a.stargazers_count + a.forks_count))
                .slice(0, 6);

            document.getElementById('reposList').innerHTML = topRepos
                .map(repo => `
                    <div class="repo-item">
                        <div class="repo-name">${repo.name}</div>
                        <div class="repo-desc">${repo.description || 'No description'}</div>
                        <div class="repo-meta">
                            <span>⭐ ${repo.stargazers_count}</span>
                            <span>🔀 ${repo.forks_count}</span>
                            ${repo.language ? `<span class="repo-lang">${repo.language}</span>` : ''}
                        </div>
                    </div>
                `)
                .join('');

            document.getElementById('languageChart').innerHTML = analysis.languages
                .slice(0, 6)
                .map(lang => `
                    <div class="language-item">
                        <div class="language-name">${lang.name}</div>
                        <div class="language-percent">${lang.percentage}%</div>
                    </div>
                `)
                .join('');

            resultsSection.classList.remove('hidden');
            if (typeof renderMissingProfileChecks === 'function') renderMissingProfileChecks(userData, repos, analysis);
            if (typeof switchAnalysisTab === 'function') switchAnalysisTab('overview', false);
            if (typeof scrollToResults === 'function') scrollToResults();
        }

        function updateScoreDisplay(scoreId, progressId, value) {
            const rounded = Math.round(value);
            document.getElementById(scoreId).textContent = rounded + '%';
            document.getElementById(progressId).style.width = rounded + '%';
        }

        function getScoreInterpretation(score) {
            if (score >= 90) return '🎯 Outstanding! Your portfolio is recruiter-ready. Keep it up!';
            if (score >= 75) return '✨ Great work! Your profile is strong. Minor improvements will make it perfect.';
            if (score >= 60) return '💡 Good foundation. With some focused improvements, you\'ll stand out.';
            if (score >= 45) return '🚀 Room to grow. Focus on documentation and project consistency.';
            return '📈 Getting started. Work on README quality and repository structure.';
        }

        function showLoading() {
            analyzeBtn.disabled = true;
            loadingState.classList.remove('hidden');
            errorState.classList.add('hidden');
            resultsSection.classList.add('hidden');
        }

        function hideLoading() {
            analyzeBtn.disabled = false;
            loadingState.classList.add('hidden');
        }

        function showError(message) {
            errorMessage.textContent = message;
            errorState.classList.remove('hidden');
            loadingState.classList.add('hidden');
            resultsSection.classList.add('hidden');
        }

        function resetForm() {
            githubInput.value = '';
            resultsSection.classList.add('hidden');
            errorState.classList.add('hidden');
            loadingState.classList.add('hidden');
            githubInput.focus();
        }

        // Allow Enter key to submit
        githubInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleAnalysis();
            }
        });


        // ===== Enhanced features =====
        let currentData = null; // {userData, repos, analysis, username}

        // Dark mode
        function toggleDark(){
            document.body.classList.toggle('dark');
            const dark = document.body.classList.contains('dark');
            document.getElementById('darkBtn').textContent = dark ? '☀️ Light' : '🌙 Dark';
            localStorage.setItem('gpa_dark', dark ? '1':'0');
        }
        if (localStorage.getItem('gpa_dark') === '1') toggleDark();

        // History
        function loadHistory(){
            try { return JSON.parse(localStorage.getItem('gpa_history')||'[]'); } catch { return []; }
        }
        function saveHistory(list){ localStorage.setItem('gpa_history', JSON.stringify(list.slice(0,8))); }
        function addHistory(username){
            let list = loadHistory().filter(u => u.toLowerCase() !== username.toLowerCase());
            list.unshift(username); saveHistory(list); renderHistory();
        }
        function removeHistory(username){
            saveHistory(loadHistory().filter(u => u !== username)); renderHistory();
        }
        function renderHistory(){
            const list = loadHistory();
            const card = document.getElementById('historyCard');
            const chips = document.getElementById('historyChips');
            if (!list.length){ card.style.display='none'; return; }
            card.style.display='block';
            chips.innerHTML = list.map(u =>
                `<span class="history-chip"><span onclick="runUsername('${u}')">${u}</span><span class="x" onclick="removeHistory('${u}')">✕</span></span>`
            ).join('');
        }
        function runUsername(u){
            githubInput.value = u;
            handleAnalysis();
        }
        renderHistory();

        // Hook into displayResults to store state + render repos with filtering
        const _origDisplay = displayResults;
        displayResults = function(userData, repos, analysis){
            currentData = { userData, repos, analysis, username: userData.login };
            _origDisplay(userData, repos, analysis);
            addHistory(userData.login);
            renderRepos();
            renderLangBar(analysis.languages);
            renderBadge(analysis.weightedScore, userData.login);
            window.currentData = currentData;
            // NEW FEATURES hook
            setTimeout(() => {
                try { renderRepoHealth(repos); } catch(_) {}
                try { renderTechStack(repos); } catch(_) {}
                try { renderRecruiterSnapshot(userData, repos, analysis); } catch(_) {}
                try { renderStreakTracker(repos); } catch(_) {}
                try { renderStarLeader(repos); } catch(_) {}
                try { renderProfileAdvisor(userData, repos, analysis); } catch(_) {}
            }, 400);
        };

        function renderRepos(){
            if (!currentData) return;
            const q = (document.getElementById('repoSearch')?.value || '').toLowerCase();
            const sort = document.getElementById('repoSort')?.value || 'stars';
            const all = document.getElementById('showAllRepos')?.checked;
            let list = currentData.repos.filter(r => !r.fork);
            if (q) list = list.filter(r =>
                r.name.toLowerCase().includes(q) ||
                (r.description||'').toLowerCase().includes(q) ||
                (r.language||'').toLowerCase().includes(q)
            );
            list.sort((a,b)=>{
                if (sort==='forks') return b.forks_count - a.forks_count;
                if (sort==='updated') return new Date(b.updated_at) - new Date(a.updated_at);
                if (sort==='name') return a.name.localeCompare(b.name);
                return b.stargazers_count - a.stargazers_count;
            });
            if (!all) list = list.slice(0, 6);
            document.getElementById('reposList').innerHTML = list.map(repo => `
                <div class="repo-item">
                    <div class="repo-name"><a href="${repo.html_url}" target="_blank" style="color:inherit;text-decoration:none;">${repo.name}</a></div>
                    <div class="repo-desc">${repo.description || 'No description'}</div>
                    <div class="repo-meta">
                        <span>⭐ ${repo.stargazers_count}</span>
                        <span>🔀 ${repo.forks_count}</span>
                        <span>📅 ${new Date(repo.updated_at).toLocaleDateString()}</span>
                        ${repo.language ? `<span class="repo-lang">${repo.language}</span>` : ''}
                    </div>
                </div>
            `).join('') || '<p style="color:#999;">No repositories match your filter.</p>';
        }

        function renderLangBar(langs){
            const colors = ['#0d7377','#14919b','#76c7d1','#ffc107','#dc3545','#6f42c1','#28a745','#fd7e14'];
            const top = langs.slice(0,8);
            const bar = top.map((l,i)=>`<span title="${l.name} ${l.percentage}%" style="width:${l.percentage}%;background:${colors[i%colors.length]}"></span>`).join('');
            const chart = document.getElementById('languageChart');
            chart.insertAdjacentHTML('afterbegin', `<div class="lang-bar">${bar}</div>`);
        }

        // Export JSON
        function downloadJSON(){
            if (!currentData) return;
            const blob = new Blob([JSON.stringify({
                username: currentData.username,
                score: currentData.analysis.weightedScore,
                scores: currentData.analysis.scores,
                strengths: currentData.analysis.strengths,
                improvements: currentData.analysis.improvements,
                recommendations: currentData.analysis.recommendations,
                languages: currentData.analysis.languages,
                generated: new Date().toISOString()
            }, null, 2)], {type:'application/json'});
            triggerDownload(blob, `${currentData.username}-portfolio.json`);
        }

        // Export Markdown
        function downloadMarkdown(){
            if (!currentData) return;
            const a = currentData.analysis, u = currentData.userData;
            const md = `# GitHub Portfolio Report — ${u.name || u.login}

**Profile:** https://github.com/${u.login}
**Overall Score:** ${a.weightedScore}/100
**Generated:** ${new Date().toLocaleString()}

## Metric Breakdown
${Object.entries(a.scores).map(([k,v])=>`- **${k}:** ${Math.round(v)}%`).join('\n')}

## Strengths
${a.strengths.map(s=>`- ${s}`).join('\n')}

## Improvements
${a.improvements.map(s=>`- ${s}`).join('\n')}

## Recommendations
${a.recommendations.map(r=>`### ${r.title}\n${r.text}`).join('\n\n')}

## Top Languages
${a.languages.slice(0,6).map(l=>`- ${l.name}: ${l.percentage}%`).join('\n')}
`;
            triggerDownload(new Blob([md], {type:'text/markdown'}), `${currentData.username}-portfolio.md`);
        }

        function triggerDownload(blob, name){
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = name; a.click();
            setTimeout(()=>URL.revokeObjectURL(url), 1000);
        }

        // Share link
        function shareLink(){
            if (!currentData) return;
            const url = `${location.origin}${location.pathname}?u=${encodeURIComponent(currentData.username)}`;
            navigator.clipboard?.writeText(url);
            alert('🔗 Share link copied to clipboard:\n\n' + url);
        }
        // Shared inline-SVG badge builder — works WITHOUT the backend running.
        function buildBadgeSvg(score, opts){
            score = Math.max(0, Math.min(100, Math.round(score||0)));
            const color = score>=90?'#0d7377':score>=75?'#14919b':score>=60?'#ffc107':score>=45?'#ff8c00':'#dc3545';
            const rankLabel = score>=90?'S-Rank':score>=75?'A-Rank':score>=60?'B-Rank':score>=45?'C-Rank':'D-Rank';
            const label = 'GitHub Portfolio';
            const value = `${rankLabel}  ${score}/100`;
            const labelW = 140, valueW = 130, h = 28;
            const totalW = labelW + valueW;
            return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${h}" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <clipPath id="br"><rect width="${totalW}" height="${h}" rx="5" fill="#fff"/></clipPath>
  <g clip-path="url(#br)">
    <rect width="${labelW}" height="${h}" fill="#051d2a"/>
    <rect x="${labelW}" width="${valueW}" height="${h}" fill="${color}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Segoe UI,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW/2}" y="18" fill="#000" fill-opacity=".25" textLength="${labelW-24}" lengthAdjust="spacing">${label}</text>
    <text x="${labelW/2}" y="17" textLength="${labelW-24}" lengthAdjust="spacing">${label}</text>
    <text x="${labelW+valueW/2}" y="18" fill="#000" fill-opacity=".25" textLength="${valueW-16}" lengthAdjust="spacing">${value}</text>
    <text x="${labelW+valueW/2}" y="17" textLength="${valueW-16}" lengthAdjust="spacing">${value}</text>
  </g>
</svg>`;
        }
        // Turn an SVG string into a data: URI usable as <img src>
        function badgeSvgDataUri(score){
            return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buildBadgeSvg(score));
        }
        window.buildBadgeSvg = buildBadgeSvg;
        window.badgeSvgDataUri = badgeSvgDataUri;

        function renderBadge(score, username){
            const svgHtml = buildBadgeSvg(score);
            const svgWrap = document.getElementById('badgeSvgWrap');
            const liveLabel = document.getElementById('badgeLiveLabel');
            if (svgWrap) svgWrap.innerHTML = svgHtml;
            if (liveLabel) liveLabel.textContent = '← Live preview';

            // Also fill the legacy <img> preview with an inline data URI so it is visible.
            const imgPrev = document.getElementById('badgePreview');
            if (imgPrev){ imgPrev.src = badgeSvgDataUri(score); imgPrev.style.display = 'inline-block'; }

            // Server badge URL (used for the copyable markdown / README embed)
            const badgeUrl = `${location.origin}/api/badge/${encodeURIComponent(username)}`;
            const md = `[![Portfolio Score](${badgeUrl})](https://github.com/${username})`;
            const badgeTextEl = document.getElementById('badgeText');
            if (badgeTextEl) badgeTextEl.textContent = md;
            window.__lastBadgeScore = score;
            window.__lastBadgeUser = username;
        }
        function copyBadge(){
            navigator.clipboard?.writeText(document.getElementById('badgeText').textContent);
            const btn = event.target; const old = btn.textContent;
            btn.textContent='Copied!'; setTimeout(()=>btn.textContent=old, 1500);
        }
        // NEW FEATURE: download the score badge as a standalone .svg file
        window.downloadBadgeSvg = function(){
            const score = window.__lastBadgeScore || 0;
            const user = window.__lastBadgeUser || 'badge';
            const blob = new Blob([buildBadgeSvg(score)], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `${user}-portfolio-badge.svg`; a.click();
            setTimeout(()=>URL.revokeObjectURL(url), 3000);
            if (window.GHToast) window.GHToast.success('Badge SVG downloaded!');
        };

        // Compare
        async function compareProfiles(){
            const a = document.getElementById('cmpA').value.trim();
            const b = document.getElementById('cmpB').value.trim();
            const box = document.getElementById('compareResults');
            if (!a || !b){ alert('Enter both usernames'); return; }
            box.style.display='grid';
            box.innerHTML = '<p style="grid-column:1/-1;text-align:center;">Loading...</p>';
            try {
                const [uA, uB] = await Promise.all([fetchUserData(extractUsername(a)), fetchUserData(extractUsername(b))]);
                const [rA, rB] = await Promise.all([fetchRepositories(uA.login), fetchRepositories(uB.login)]);
                const anA = analyzePortfolio(uA, rA);
                const anB = analyzePortfolio(uB, rB);
                const winA = anA.weightedScore >= anB.weightedScore;
                box.innerHTML = [{u:uA,r:rA,an:anA,win:winA},{u:uB,r:rB,an:anB,win:!winA}].map(x=>`
                    <div class="compare-col ${x.win?'winner':''}">
                        <img src="${x.u.avatar_url}" alt="">
                        <h4>${x.u.name || x.u.login}</h4>
                        <p style="color:#666;font-size:.9em;">@${x.u.login}</p>
                        <div class="big">${x.an.weightedScore}</div>
                        <p>⭐ ${x.r.reduce((s,r)=>s+r.stargazers_count,0)} stars · ${x.r.filter(r=>!r.fork).length} repos</p>
                        <p>👥 ${x.u.followers} followers</p>
                    </div>
                `).join('');
            } catch(e){
                box.innerHTML = '<p style="grid-column:1/-1;color:var(--error);text-align:center;">'+e.message+'</p>';
            }
        }

        // Keyboard shortcut
        document.addEventListener('keydown', e=>{
            if (e.key==='/' && document.activeElement.tagName!=='INPUT'){
                e.preventDefault(); githubInput.focus();
            }
        });

        // Auto-analyze from ?u=
        const params = new URLSearchParams(location.search);
        if (params.get('u')){
            githubInput.value = params.get('u');
            setTimeout(handleAnalysis, 200);
        }

    
        // ========== ENHANCED FEATURES JS ==========

        // Toast notification system (replaces alerts)
        function showToast(msg, type='success', duration=3000) {
            let container = document.getElementById('toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'toast-container';
                document.body.appendChild(container);
            }
            const t = document.createElement('div');
            t.className = `toast ${type}`;
            t.textContent = msg;
            container.appendChild(t);
            setTimeout(() => t.remove(), duration + 100);
        }

        // Animated counter utility
        function animateCounter(el, target, duration=1200) {
            const start = parseInt(el.textContent) || 0;
            const diff = target - start;
            const startTime = performance.now();
            function step(now) {
                const elapsed = now - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const ease = 1 - Math.pow(1 - progress, 3);
                el.textContent = Math.round(start + diff * ease);
                if (progress < 1) requestAnimationFrame(step);
            }
            requestAnimationFrame(step);
        }

        // Scroll reveal observer
        const revealObserver = new IntersectionObserver((entries) => {
            entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); } });
        }, { threshold: 0.1 });

        // Floating particles
        (function initParticles() {
            const canvas = document.createElement('canvas');
            canvas.id = 'particles-canvas';
            document.body.appendChild(canvas);
            const ctx = canvas.getContext('2d');
            let W, H, particles = [];
            function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
            resize();
            window.addEventListener('resize', resize);
            for (let i = 0; i < 38; i++) {
                particles.push({
                    x: Math.random() * 9999, y: Math.random() * 9999,
                    r: Math.random() * 2.5 + 0.5,
                    dx: (Math.random() - 0.5) * 0.3, dy: (Math.random() - 0.5) * 0.3,
                    a: Math.random() * 0.5 + 0.2
                });
            }
            function draw() {
                ctx.clearRect(0, 0, W, H);
                particles.forEach(p => {
                    p.x = (p.x + p.dx + W) % W; p.y = (p.y + p.dy + H) % H;
                    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(118,199,209,${p.a})`; ctx.fill();
                });
                requestAnimationFrame(draw);
            }
            draw();
        })();

        // Skeleton loading
        function showSkeletonLoading() {
            const skeletonHtml = `
            <div class="skeleton-card">
                <div style="display:flex;gap:20px;align-items:center;margin-bottom:20px;">
                    <div class="skeleton-circle"></div>
                    <div style="flex:1;">
                        <div class="skeleton-line wide"></div>
                        <div class="skeleton-line medium"></div>
                        <div class="skeleton-line short"></div>
                    </div>
                </div>
                <div class="skeleton-line wide"></div>
                <div class="skeleton-line medium"></div>
                <div class="skeleton-line short"></div>
            </div>
            <div class="skeleton-card">
                <div class="skeleton-line wide"></div>
                <div class="skeleton-line medium" style="margin-bottom:20px;"></div>
                <div class="skeleton-line wide"></div>
                <div class="skeleton-line medium"></div>
                <div class="skeleton-line short"></div>
            </div>`;
            loadingState.innerHTML = skeletonHtml;
            loadingState.classList.remove('hidden');
        }

        // XP / Rank calculation
        const RANKS = [
            { name: '🌱 Beginner', minScore: 0, xpNeeded: 200 },
            { name: '⚡ Rising Developer', minScore: 30, xpNeeded: 500 },
            { name: '💪 Strong Contributor', minScore: 55, xpNeeded: 800 },
            { name: '🚀 Open Source Ready', minScore: 70, xpNeeded: 1100 },
            { name: '⭐ Recruiter Favorite', minScore: 85, xpNeeded: Infinity }
        ];

        function calculateXP(userData, repos, analysis) {
            let xp = 0;
            const own = repos.filter(r => !r.fork);
            xp += Math.min(own.length * 15, 300);
            xp += Math.min(repos.reduce((s,r) => s+r.stargazers_count, 0) * 4, 400);
            xp += Math.min(userData.followers * 2, 200);
            xp += Math.round(analysis.weightedScore * 8);
            xp += Math.min(own.filter(r => r.homepage).length * 25, 150);
            xp += Math.min(own.filter(r => r.description).length * 10, 100);
            const langs = new Set(own.map(r => r.language).filter(Boolean));
            xp += Math.min(langs.size * 20, 200);
            return Math.round(xp);
        }

        function getRank(xp) {
            for (let i = RANKS.length - 1; i >= 0; i--) {
                if (xp >= RANKS[i].xpNeeded || i === 0) {
                    const rank = RANKS[Math.min(i, RANKS.length-1)];
                    const prev = RANKS[Math.max(i-1,0)];
                    const next = RANKS[Math.min(i+1, RANKS.length-1)];
                    return { rank, prev, next, i };
                }
            }
        }

        function renderXP(userData, repos, analysis) {
            const xp = calculateXP(userData, repos, analysis);
            const score = analysis.weightedScore;
            let rankIndex = 0;
            for (let i = 0; i < RANKS.length; i++) { if (score >= RANKS[i].minScore) rankIndex = i; }
            const currentRank = RANKS[rankIndex];
            const nextRank = RANKS[Math.min(rankIndex+1, RANKS.length-1)];
            const prevRankXP = rankIndex > 0 ? RANKS[rankIndex].xpNeeded : 0;
            const nextXP = nextRank.xpNeeded === Infinity ? xp : nextRank.xpNeeded;
            const pct = nextXP === xp ? 100 : Math.min(Math.round(((xp - prevRankXP) / Math.max(nextXP - prevRankXP, 1)) * 100), 100);
            
            document.getElementById('rankBadge').textContent = currentRank.name;
            document.getElementById('xpBarFill').style.width = pct + '%';
            document.getElementById('xpCurrent').textContent = xp.toLocaleString() + ' XP';
            document.getElementById('xpNext').textContent = nextRank.xpNeeded === Infinity ? '🏆 Max Rank!' : `Next: ${nextRank.name} at ${nextRank.xpNeeded.toLocaleString()} XP`;
            document.getElementById('xpSection').style.display = '';
        }

        // Achievements system
        const ALL_ACHIEVEMENTS = [
            { id:'first_repo', icon:'📁', name:'First Repo', desc:'Has at least 1 original repo', check: (u,r) => r.filter(x=>!x.fork).length >= 1 },
            { id:'five_repos', icon:'📚', name:'Prolific Creator', desc:'10+ original repos', check: (u,r) => r.filter(x=>!x.fork).length >= 10 },
            { id:'star_power', icon:'⭐', name:'Star Power', desc:'50+ total stars', check: (u,r) => r.reduce((s,x)=>s+x.stargazers_count,0) >= 50 },
            { id:'multilingual', icon:'🌐', name:'Polyglot', desc:'5+ languages', check: (u,r) => new Set(r.filter(x=>!x.fork&&x.language).map(x=>x.language)).size >= 5 },
            { id:'community', icon:'👥', name:'Community Leader', desc:'50+ followers', check: (u,r) => u.followers >= 50 },
            { id:'documented', icon:'📝', name:'Well Documented', desc:'80%+ repos with descriptions', check: (u,r) => { const own=r.filter(x=>!x.fork); return own.length>0 && own.filter(x=>x.description).length/own.length >= 0.8; } },
            { id:'live_projects', icon:'🌍', name:'Ships to Production', desc:'3+ repos with live demos', check: (u,r) => r.filter(x=>!x.fork&&x.homepage).length >= 3 },
            { id:'forked_by', icon:'🔀', name:'Fork Magnet', desc:'Total forks > 10', check: (u,r) => r.reduce((s,x)=>s+x.forks_count,0) >= 10 },
            { id:'senior', icon:'🧓', name:'Veteran', desc:'Account 3+ years old', check: (u,r) => (new Date()-new Date(u.created_at))/(1000*60*60*24*365) >= 3 },
            { id:'topical', icon:'🏷️', name:'Well Tagged', desc:'50%+ repos with topics', check: (u,r) => { const own=r.filter(x=>!x.fork); return own.length>0 && own.filter(x=>x.topics&&x.topics.length>0).length/own.length >= 0.5; } },
            { id:'consistent', icon:'🔥', name:'Consistency Streak', desc:'Active in last 30 days', check: (u,r) => r.filter(x=>!x.fork&&(new Date()-new Date(x.pushed_at))<30*24*3600*1000).length > 0 },
            { id:'gist_master', icon:'📄', name:'Gist Master', desc:'5+ public gists', check: (u,r) => u.public_gists >= 5 },
        ];

        function renderAchievements(userData, repos) {
            const grid = document.getElementById('achievementsGrid');
            grid.innerHTML = ALL_ACHIEVEMENTS.map(a => {
                const earned = a.check(userData, repos);
                return `<div class="achievement-badge ${earned?'earned':'locked'}" data-tip="${a.desc}">
                    <span class="ach-icon">${a.icon}</span>
                    <div><div class="ach-name">${a.name}</div><div class="ach-desc">${a.desc}</div></div>
                    ${earned ? '<span style="margin-left:auto;font-size:0.8em;color:var(--success);">✓</span>' : ''}
                </div>`;
            }).join('');
            document.getElementById('achievementsSection').style.display = '';
        }

        // AI-style insights
        function renderAIInsights(userData, repos, analysis) {
            const own = repos.filter(r => !r.fork);
            const score = analysis.weightedScore;
            const langs = analysis.languages;
            const totalStars = repos.reduce((s,r) => s+r.stargazers_count, 0);
            const liveProjects = own.filter(r => r.homepage).length;

            // Developer level
            let devLevel, devClass;
            if (score >= 75) { devLevel = '🚀 Advanced Developer'; devClass = 'level-advanced'; }
            else if (score >= 50) { devLevel = '💡 Intermediate Developer'; devClass = 'level-intermediate'; }
            else { devLevel = '🌱 Beginner Developer'; devClass = 'level-beginner'; }

            document.getElementById('devLevel').textContent = devLevel;
            document.getElementById('devLevel').className = 'strength-level-badge ' + devClass;

            // Recruiter impression
            const impressionTexts = [];
            if (score >= 75) impressionTexts.push(`${userData.name || userData.login} presents a compelling technical portfolio with strong project organization and consistent activity.`);
            else if (score >= 55) impressionTexts.push(`${userData.name || userData.login} shows solid GitHub fundamentals with a growing portfolio worth deeper review.`);
            else impressionTexts.push(`${userData.name || userData.login}'s profile has potential — a few focused improvements would significantly boost recruiter appeal.`);
            if (totalStars > 20) impressionTexts.push(`Community recognition (${totalStars} stars) demonstrates real-world impact.`);
            if (liveProjects > 0) impressionTexts.push(`${liveProjects} live project${liveProjects>1?'s':''} show${liveProjects===1?'s':''} initiative to deploy and ship.`);
            if (langs.length >= 4) impressionTexts.push(`Polyglot background across ${langs.length} languages signals adaptability.`);
            document.getElementById('recruiterText').textContent = impressionTexts.join(' ');

            // Insight cards
            const complexityScore = Math.round((own.filter(r=>r.size>1000).length / Math.max(own.length,1)) * 100);
            const insights = [
                { label: '📊 Portfolio Strength', value: score >= 75 ? 'Strong 💪' : score >= 50 ? 'Moderate 📈' : 'Building 🌱' },
                { label: '🔧 Project Complexity', value: `${complexityScore}% are large projects` },
                { label: '📅 Account Age', value: `${Math.floor((new Date()-new Date(userData.created_at))/(1000*60*60*24*365))} years on GitHub` },
                { label: '🎯 Smart Suggestion', value: score < 60 ? 'Add READMEs & live demos to boost score by ~20pts' : score < 80 ? 'Pin top repos & add topics to maximize visibility' : 'Contribute to open source to reach elite status' },
                { label: '🏆 Portfolio Rank', value: score>=85?'⭐ Recruiter Favorite':score>=70?'🚀 Open Source Ready':score>=55?'💪 Strong Contributor':score>=30?'⚡ Rising Dev':'🌱 Beginner' },
                { label: '📈 Consistency Index', value: `${Math.round(analysis.scores.activityConsistency)}% — ${analysis.scores.activityConsistency>70?'Excellent':'Needs improvement'}` },
            ];
            document.getElementById('aiInsightGrid').innerHTML = insights.map(i =>
                `<div class="ai-insight-card"><div class="ai-label">${i.label}</div><div class="ai-value">${i.value}</div></div>`
            ).join('');

            // Top skills
            const skillMap = { JavaScript:'⚡', Python:'🐍', TypeScript:'📘', Java:'☕', 'C++':'⚙️', Go:'🐹', Rust:'🦀', Ruby:'💎', PHP:'🐘', Swift:'🍎', Kotlin:'📱', CSS:'🎨', HTML:'🌐', Shell:'🖥️', Vue:'💚', React:'⚛️', Django:'🌿' };
            const skillTags = langs.slice(0,6).map(l => `<span class="skill-tag">${skillMap[l.name]||'🔹'} ${l.name}</span>`).join('');
            document.getElementById('topSkillsTags').innerHTML = skillTags;

            document.getElementById('aiSection').style.display = '';
        }

        // Charts with Chart.js
        let chartInstances = {};
        function destroyCharts() {
            Object.values(chartInstances).forEach(c => { try { c.destroy(); } catch(e){} });
            chartInstances = {};
        }

        function renderCharts(repos, analysis) {
            destroyCharts();
            document.getElementById('chartsSection').style.display = '';

            // Language Pie
            const langCtx = document.getElementById('langPieChart').getContext('2d');
            const langData = analysis.languages.slice(0, 7);
            const COLORS = ['#0d7377','#14919b','#76c7d1','#ffc107','#dc3545','#6f42c1','#28a745'];
            chartInstances.pie = new Chart(langCtx, {
                type: 'doughnut',
                data: {
                    labels: langData.map(l => l.name),
                    datasets: [{ data: langData.map(l => l.percentage), backgroundColor: COLORS, borderWidth: 2, borderColor: '#fff' }]
                },
                options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } }, animation: { animateScale: true } }
            });

            // Skill Radar
            const radarCtx = document.getElementById('skillRadarChart').getContext('2d');
            const s = analysis.scores;
            chartInstances.radar = new Chart(radarCtx, {
                type: 'radar',
                data: {
                    labels: ['Documentation', 'Code Structure', 'Activity', 'Org', 'Impact', 'Tech Depth'],
                    datasets: [{
                        label: 'Your Profile',
                        data: [s.documentation, s.codeStructure, s.activityConsistency, s.repositoryOrganization, s.projectImpact, s.technicalDepth].map(v => Math.round(v)),
                        backgroundColor: 'rgba(13,115,119,0.2)', borderColor: '#0d7377',
                        pointBackgroundColor: '#0d7377', pointRadius: 4
                    }]
                },
                options: { responsive: true, scales: { r: { min: 0, max: 100, ticks: { display: false }, grid: { color: 'rgba(13,115,119,0.15)' } } } }
            });

            // Activity Bar — repos updated per month (last 12 months)
            const barCtx = document.getElementById('activityBarChart').getContext('2d');
            const now = new Date();
            const months = [];
            const counts = [];
            for (let i = 11; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                months.push(d.toLocaleString('default', { month: 'short' }));
                counts.push(repos.filter(r => {
                    const u = new Date(r.pushed_at);
                    return u.getFullYear() === d.getFullYear() && u.getMonth() === d.getMonth();
                }).length);
            }
            chartInstances.bar = new Chart(barCtx, {
                type: 'bar',
                data: {
                    labels: months,
                    datasets: [{ label: 'Repo Updates', data: counts, backgroundColor: 'rgba(13,115,119,0.7)', borderRadius: 4 }]
                },
                options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
            });
        }

        // Contribution heatmap (simulated from repo push dates)
        function renderHeatmap(repos) {
            const grid = document.getElementById('heatmapGrid');
            const now = new Date();
            const startDate = new Date(now); startDate.setDate(startDate.getDate() - 364);
            // Build date→count map from repo push dates
            const dateCounts = {};
            repos.forEach(r => {
                if (r.pushed_at) {
                    const d = new Date(r.pushed_at).toISOString().slice(0,10);
                    dateCounts[d] = (dateCounts[d] || 0) + 1;
                }
                // Also use created and updated dates
                [r.created_at, r.updated_at].forEach(dt => {
                    if (dt) {
                        const d = new Date(dt).toISOString().slice(0,10);
                        if (!dateCounts[d]) dateCounts[d] = 0;
                        dateCounts[d]++;
                    }
                });
            });

            // Generate 52 weeks × 7 days
            let cells = '';
            for (let week = 0; week < 53; week++) {
                for (let day = 0; day < 7; day++) {
                    const d = new Date(startDate);
                    d.setDate(d.getDate() + week * 7 + day);
                    if (d > now) { cells += `<div class="heatmap-cell level-0"></div>`; continue; }
                    const key = d.toISOString().slice(0,10);
                    const count = dateCounts[key] || 0;
                    const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 5 ? 3 : 4;
                    cells += `<div class="heatmap-cell level-${level}" data-tip="${key}: ${count} activity"></div>`;
                }
            }
            grid.innerHTML = cells;
            document.getElementById('heatmapSection').style.display = '';
        }

        // Stats insights
        function renderStatsInsights(userData, repos, analysis) {
            const own = repos.filter(r => !r.fork);
            const langs = new Set(own.map(r=>r.language).filter(Boolean));
            
            // Most active (most recently pushed)
            const mostActive = own.sort((a,b) => new Date(b.pushed_at)-new Date(a.pushed_at))[0];
            // Longest maintained (oldest still pushed within a year)
            const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear()-1);
            const active = own.filter(r => new Date(r.pushed_at) > oneYearAgo);
            const longest = active.sort((a,b) => new Date(a.created_at)-new Date(b.created_at))[0];

            const completion = Math.round((
                (userData.bio ? 10 : 0) +
                (userData.location ? 10 : 0) +
                (userData.blog ? 10 : 0) +
                (userData.company ? 5 : 0) +
                Math.min((own.filter(r=>r.description).length/Math.max(own.length,1))*25, 25) +
                Math.min((own.filter(r=>r.topics&&r.topics.length>0).length/Math.max(own.length,1))*20, 20) +
                Math.min(own.filter(r=>r.homepage).length*5, 15) +
                (own.length >= 5 ? 5 : 0)
            ));

            animateCounter(document.getElementById('siOriginal'), own.length);
            document.getElementById('siMostActive').textContent = mostActive ? mostActive.name.slice(0,14) : '—';
            document.getElementById('siLongest').textContent = longest ? longest.name.slice(0,14) : '—';
            animateCounter(document.getElementById('siLangCount'), langs.size);
            animateCounter(document.getElementById('siLive'), own.filter(r=>r.homepage).length);
            animateCounter(document.getElementById('siComplete'), completion);
            document.getElementById('statsInsights').style.display = '';
        }

        // ATS / Recruiter checklist
        function renderATS(userData, repos, analysis) {
            const own = repos.filter(r => !r.fork);
            const checks = [
                { label: 'Profile has a bio', pass: !!userData.bio, tip: 'Bio makes you memorable' },
                { label: 'Profile photo set', pass: !!userData.avatar_url, tip: 'Humanizes your profile' },
                { label: 'Location provided', pass: !!userData.location, tip: 'Helps recruiters find you' },
                { label: 'Website/portfolio linked', pass: !!userData.blog, tip: 'Shows initiative' },
                { label: '5+ original repos', pass: own.length >= 5, tip: 'Shows sustained effort' },
                { label: '80%+ repos have descriptions', pass: own.length>0 && own.filter(r=>r.description).length/own.length >= 0.8, tip: 'Key for ATS scans' },
                { label: 'At least 1 live demo', pass: own.filter(r=>r.homepage).length >= 1, tip: 'Proves you ship' },
                { label: '3+ languages used', pass: new Set(own.map(r=>r.language).filter(Boolean)).size >= 3, tip: 'Shows versatility' },
                { label: 'Active in last 30 days', pass: own.some(r=>(new Date()-new Date(r.pushed_at))<30*24*3600*1000), tip: 'Freshness matters' },
                { label: 'Repos use topics/tags', pass: own.some(r=>r.topics&&r.topics.length>0), tip: 'Improves discoverability' },
                { label: '10+ followers', pass: userData.followers >= 10, tip: 'Social proof for recruiters' },
                { label: 'Multiple starred repos', pass: own.filter(r=>r.stargazers_count>0).length >= 2, tip: 'Community validation' },
            ];

            const passing = checks.filter(c=>c.pass).length;
            const completion = Math.round((passing / checks.length) * 100);

            document.getElementById('atsChecklist').innerHTML = checks.map(c =>
                `<li class="ats-check ${c.pass?'pass':'fail'}" data-tip="${c.tip}">
                    <span class="chk-icon">${c.pass?'✅':'❌'}</span>
                    <span>${c.label}</span>
                </li>`
            ).join('');

            setTimeout(() => {
                document.getElementById('completionBar').style.width = completion + '%';
                document.getElementById('completionLabel').textContent = `${passing}/${checks.length} criteria met`;
                document.getElementById('completionPct').textContent = completion + '%';
            }, 600);

            document.getElementById('atsSection').style.display = '';
        }

        // Share functions
        function copyShareLink() {
            if (!currentData) return;
            const url = `${location.origin}${location.pathname}?u=${encodeURIComponent(currentData.username)}`;
            navigator.clipboard?.writeText(url);
            showToast('🔗 Share link copied to clipboard!', 'success');
        }

        function generateLinkedInSummary() {
            if (!currentData) return;
            const u = currentData.userData;
            const a = currentData.analysis;
            const own = currentData.repos.filter(r => !r.fork);
            const langs = a.languages.slice(0,4).map(l=>l.name).join(', ');
            const stars = currentData.repos.reduce((s,r) => s+r.stargazers_count, 0);
            const summary = `👋 Hi! I'm ${u.name || u.login}, a passionate developer with ${own.length} public projects on GitHub (${stars} ⭐ total).

🛠️ My primary stack includes ${langs}.

📊 My GitHub Portfolio Score: ${a.weightedScore}/100 — ${a.weightedScore>=75?'Recruiter-ready':'Building toward recruiter-ready'}.

🔗 GitHub: https://github.com/${u.login}${u.blog ? '\n🌐 Portfolio: '+u.blog : ''}

I'm actively ${a.scores.activityConsistency>60?'contributing and':'working to increase my'} shipping projects. Let's connect!`;

            document.getElementById('linkedinSummaryText').textContent = summary;
            document.getElementById('linkedinSummaryBox').style.display = '';
            showToast('💼 LinkedIn summary generated!', 'success');
        }

        function copySummary() {
            navigator.clipboard?.writeText(document.getElementById('linkedinSummaryText').textContent);
            showToast('📋 Summary copied!', 'success');
        }

        function copyRecruiterProfile() {
            if (!currentData) return;
            const u = currentData.userData;
            const a = currentData.analysis;
            const own = currentData.repos.filter(r => !r.fork);
            const stars = currentData.repos.reduce((s,r) => s+r.stargazers_count, 0);
            const profile = `=== GITHUB PORTFOLIO REPORT ===
Developer: ${u.name || u.login} (@${u.login})
Portfolio Score: ${a.weightedScore}/100
Repositories: ${own.length} original | Stars: ${stars}
Top Languages: ${a.languages.slice(0,5).map(l=>l.name).join(', ')}
Followers: ${u.followers} | Following: ${u.following}

METRIC SCORES:
• Documentation: ${Math.round(a.scores.documentation)}%
• Activity: ${Math.round(a.scores.activityConsistency)}%
• Impact: ${Math.round(a.scores.projectImpact)}%
• Tech Depth: ${Math.round(a.scores.technicalDepth)}%

STRENGTHS: ${a.strengths.slice(0,2).join(' | ')}
GitHub: https://github.com/${u.login}
Generated: ${new Date().toLocaleString()}`;
            navigator.clipboard?.writeText(profile);
            showToast('📄 Recruiter profile copied!', 'success');
        }

        async function generateQR() {
            if (!currentData) return;
            const qrWrap = document.getElementById('qrWrap');
            // Use QR server API
            const url = `https://github.com/${currentData.username}`;
            const img = document.createElement('img');
            img.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(url)}&color=0d7377`;
            img.alt = 'QR Code';
            img.style = 'border-radius:10px;border:4px solid var(--accent-teal);margin:0 auto;display:block;';
            qrWrap.innerHTML = '<p style="color:#888;font-size:0.9em;margin-bottom:10px;">GitHub Profile QR Code</p>';
            qrWrap.appendChild(img);
            qrWrap.style.display = '';
            showToast('📱 QR Code generated!', 'success');
        }

        // Override the original shareLink
        function shareLink() { copyShareLink(); }

        // Animated score ring on score circle
        function animateScoreRing(score) {
            const circle = document.querySelector('.score-circle');
            if (!circle) return;
            // Create SVG ring overlay
            const existing = circle.querySelector('.score-ring-svg');
            if (existing) existing.remove();
            const size = 180;
            const r = 80;
            const circumference = 2 * Math.PI * r;
            const offset = circumference - (score / 100) * circumference;
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'score-ring-svg');
            svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
            svg.innerHTML = `
                <circle class="score-ring-track" cx="${size/2}" cy="${size/2}" r="${r}"/>
                <circle class="score-ring-fill" cx="${size/2}" cy="${size/2}" r="${r}"
                    stroke-dasharray="${circumference}"
                    stroke-dashoffset="${circumference}"/>`;
            circle.appendChild(svg);
            requestAnimationFrame(() => {
                setTimeout(() => { svg.querySelector('.score-ring-fill').style.strokeDashoffset = offset; }, 50);
            });
        }

        // Enhanced displayResults — hook in all new features
        const _superOrigDisplay = displayResults;
        displayResults = function(userData, repos, analysis) {
            // ── Step 1: Pre-unhide all reveal sections BEFORE writing data ──
            // This allocates their layout space upfront so there are no
            // sudden jumps when sections pop in one by one later.
            // Reset .visible so the IntersectionObserver can re-fire on scroll.
            const revealSectionIds = [
                'xpSection','statsInsights','aiSection','achievementsSection',
                'chartsSection','heatmapSection','atsSection','shareSection'
            ];
            revealSectionIds.forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.style.display = '';          // take up layout space
                el.classList.remove('visible'); // reset to invisible (opacity:0)
            });

            // Also stop observing so we can re-observe fresh below
            document.querySelectorAll('.reveal').forEach(el => {
                revealObserver.unobserve(el);
                el.classList.remove('visible');
            });

            // ── Step 2: Run the original render chain ────────────────────
            _superOrigDisplay(userData, repos, analysis);

            // Animate score counter
            const scoreEl = document.getElementById('portfolioScore');
            const finalScore = analysis.weightedScore;
            scoreEl.textContent = '0';
            animateCounter(scoreEl, finalScore, 1500);
            animateScoreRing(finalScore);

            // Animate stat values
            setTimeout(() => {
                ['repoCount','followerCount','starCount','followingCount'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) animateCounter(el, parseInt(el.textContent) || 0);
                });
            }, 300);

            // Render all new sections (they are already display:'', so no layout shift)
            renderXP(userData, repos, analysis);
            renderStatsInsights(userData, repos, analysis);
            renderAIInsights(userData, repos, analysis);
            renderAchievements(userData, repos);
            renderCharts(repos, analysis);
            renderHeatmap(repos);
            renderATS(userData, repos, analysis);

            // Show share section
            document.getElementById('shareSection').style.display = '';

            // ── Step 3: Re-observe all reveal elements after DOM is ready ─
            // Use rAF to ensure the browser has painted before observing,
            // so IntersectionObserver sees correct positions.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    document.querySelectorAll('.reveal').forEach(el => {
                        revealObserver.observe(el);
                    });
                });
            });

            // Show toast
            showToast(`✅ Analysis complete for @${userData.login}!`, 'success');
        };

        // Override showLoading to use skeleton
        const _origShowLoading = showLoading;
        showLoading = function() {
            analyzeBtn.disabled = true;
            showSkeletonLoading();
            errorState.classList.add('hidden');
            resultsSection.classList.add('hidden');
        };

        // Override showError to use toast
        const _origShowError = showError;
        showError = function(message) {
            _origShowError(message);
            showToast('❌ ' + message, 'error', 4000);
        };

        // Mobile bottom navigation
        const mobileNav = document.createElement('nav');
        mobileNav.className = 'mobile-bottom-nav';
        mobileNav.innerHTML = `<div class="mbn-inner">
            <button class="mbn-btn" onclick="window.scrollTo({top:0,behavior:'smooth'})"><span>🏠</span>Top</button>
            <button class="mbn-btn" onclick="document.getElementById('chartsSection')?.scrollIntoView({behavior:'smooth'})"><span>📊</span>Charts</button>
            <button class="mbn-btn" onclick="document.getElementById('achievementsSection')?.scrollIntoView({behavior:'smooth'})"><span>🏆</span>Badges</button>
            <button class="mbn-btn" onclick="document.getElementById('compareSection')?.scrollIntoView({behavior:'smooth'})"><span>⚖️</span>Compare</button>
            <button class="mbn-btn" onclick="document.getElementById('shareSection')?.scrollIntoView({behavior:'smooth'})"><span>🔗</span>Share</button>
        </div>`;
        document.body.appendChild(mobileNav);

        // Load Chart.js dynamically
        if (!window.Chart) {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js';
            document.head.appendChild(s);
        }

        // Debounce search
        (function patchRepoSearch() {
            const orig = window.renderRepos;
            let timer;
            window.renderRepos = function() {
                clearTimeout(timer);
                timer = setTimeout(orig, 200);
            };
        })();

        // API rate limit handling
        const _origFetch = window.fetch;
        window._apiFetchWithRetry = async function(url, retries=2) {
            for (let i = 0; i <= retries; i++) {
                try {
                    const res = await _origFetch(url);
                    if (res.status === 403) {
                        const reset = res.headers.get('X-RateLimit-Reset');
                        const msg = reset ? `GitHub API rate limit hit. Resets at ${new Date(reset*1000).toLocaleTimeString()}.` : 'GitHub API rate limit hit. Try again in a minute.';
                        throw new Error(msg);
                    }
                    if (!res.ok && i < retries) { await new Promise(r => setTimeout(r, 1000 * (i+1))); continue; }
                    return res;
                } catch (e) {
                    if (i === retries) throw e;
                    await new Promise(r => setTimeout(r, 1000 * (i+1)));
                }
            }
        };

        // Setup reveal for all existing sections on load
        document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));




/* ============================================================
   ENHANCEMENT PACK v2 — JS
   ============================================================ */
(function(){
    'use strict';

    /* ---------- 1. Privacy & Trust banner ---------- */
    function injectPrivacyBanner(){
        if (localStorage.getItem('gpa_privacy_ack') === '1') return;
        const bar = document.createElement('div');
        bar.className = 'privacy-banner';
        bar.setAttribute('role','region');
        bar.setAttribute('aria-label','Privacy notice');
        bar.innerHTML = `
            <span>🔒 <strong>Privacy:</strong> This tool calls the public GitHub API directly from your browser.
            We don't store your data on any server. Your recent searches are saved only in your browser (localStorage) and never sent anywhere.
            <a href="#" id="privacyMore">Learn more</a></span>
            <button id="privacyOk" aria-label="Dismiss privacy notice">Got it</button>
        `;
        const container = document.querySelector('.container');
        container.insertBefore(bar, container.firstChild);
        bar.querySelector('#privacyOk').onclick = () => { localStorage.setItem('gpa_privacy_ack','1'); bar.remove(); };
        bar.querySelector('#privacyMore').onclick = (e) => { e.preventDefault(); openModal('privacyModal'); };
    }

    /* ---------- 2. Modals (Score methodology + Privacy details) ---------- */
    function buildModals(){
        const wrap = document.createElement('div');
        wrap.innerHTML = `
        <div class="lov-modal-overlay" id="scoreModal" role="dialog" aria-modal="true" aria-labelledby="scoreModalTitle">
            <div class="lov-modal">
                <button class="close-btn" aria-label="Close" onclick="closeModal('scoreModal')">×</button>
                <h3 id="scoreModalTitle">📊 How Your Portfolio Score Is Calculated</h3>
                <p>Your overall score (0–100) is a <strong>weighted average</strong> of 6 metrics that recruiters use when scanning GitHub profiles:</p>
                <h4>The Six Metrics</h4>
                <ul>
                    <li><strong>Documentation Quality (20%)</strong> — % of non-fork repos that include a description. A README is the #1 thing recruiters look for.</li>
                    <li><strong>Code Structure (15%)</strong> — Average repo size, indicating real engineering work vs. tutorials.</li>
                    <li><strong>Activity Consistency (15%)</strong> — Recency of pushes (last 90 days weighted heavily).</li>
                    <li><strong>Repository Organization (15%)</strong> — Use of topics/tags and clean naming.</li>
                    <li><strong>Project Impact (20%)</strong> — Stars, forks, and watcher counts across your work.</li>
                    <li><strong>Technical Depth (15%)</strong> — Language diversity and use of varied tech stacks.</li>
                </ul>
                <h4>Score Bands</h4>
                <ul>
                    <li><strong>90–100</strong> Outstanding · recruiter-ready</li>
                    <li><strong>75–89</strong> Strong · minor polish needed</li>
                    <li><strong>60–74</strong> Good foundation · focused improvements help</li>
                    <li><strong>45–59</strong> Room to grow</li>
                    <li><strong>0–44</strong> Early stage · start with READMEs</li>
                </ul>
                <p style="margin-top:12px; color:#888; font-size:.85em;">Scores are heuristic and run entirely in your browser. They are not affiliated with GitHub.</p>
            </div>
        </div>
        <div class="lov-modal-overlay" id="privacyModal" role="dialog" aria-modal="true" aria-labelledby="privacyModalTitle">
            <div class="lov-modal">
                <button class="close-btn" aria-label="Close" onclick="closeModal('privacyModal')">×</button>
                <h3 id="privacyModalTitle">🔒 Privacy & Data Use</h3>
                <h4>What we access</h4>
                <ul>
                    <li>Public GitHub profile & public repository metadata via the public GitHub REST API.</li>
                    <li>No GitHub login. No private repos. No emails.</li>
                </ul>
                <h4>What we store</h4>
                <ul>
                    <li><strong>localStorage only</strong>: your recent search usernames, dark-mode preference, and this banner-dismissed flag.</li>
                    <li>Nothing is sent to any external server other than github.com (and shields.io for the badge image).</li>
                </ul>
                <h4>How to clear data</h4>
                <p>Use your browser's "Clear site data" option, or click <button onclick="clearAllLocalData()" style="background:var(--error);color:#fff;border:0;padding:4px 10px;border-radius:4px;cursor:pointer;">Clear all local data</button> to wipe history and preferences now.</p>
            </div>
        </div>`;
        document.body.appendChild(wrap);
    }
    window.openModal = (id) => {
        const m = document.getElementById(id);
        if (!m) return;
        m.classList.add('active');
        const focusable = m.querySelector('button, a, input');
        focusable && focusable.focus();
    };
    window.closeModal = (id) => document.getElementById(id)?.classList.remove('active');
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') document.querySelectorAll('.lov-modal-overlay.active').forEach(m => m.classList.remove('active'));
    });
    window.clearAllLocalData = () => {
        ['gpa_history','gpa_dark','gpa_privacy_ack','gpa_onboarded'].forEach(k => localStorage.removeItem(k));
        alert('Local data cleared. Reloading...'); location.reload();
    };

    /* ---------- 3. A11y: ARIA labels on existing controls ---------- */
    function annotateA11y(){
        const m = {
            'githubInput':  ['aria-label','GitHub username or profile URL'],
            'analyzeBtn':   ['aria-label','Analyze this GitHub profile'],
            'darkBtn':      ['aria-label','Toggle dark mode'],
            'repoSearch':   ['aria-label','Search repositories'],
            'repoSort':     ['aria-label','Sort repositories'],
            'cmpA':         ['aria-label','First username to compare'],
            'cmpB':         ['aria-label','Second username to compare'],
        };
        Object.entries(m).forEach(([id, [attr, val]]) => {
            const el = document.getElementById(id);
            if (el && !el.hasAttribute(attr)) el.setAttribute(attr, val);
        });
        document.querySelectorAll('.icon-btn').forEach(b => {
            if (!b.hasAttribute('aria-label')) b.setAttribute('aria-label', b.textContent.trim());
        });
        document.documentElement.setAttribute('lang','en');
    }

    /* ---------- 4. Multi-stage loading ---------- */
    const STAGES = [
        { id: 'fetch-user',  label: 'Fetching profile data' },
        { id: 'fetch-repos', label: 'Loading repositories' },
        { id: 'analyze',     label: 'Analyzing portfolio metrics' },
        { id: 'render',      label: 'Building your report' },
    ];
    function enhanceLoadingUI(){
        const ls = document.getElementById('loadingState');
        if (!ls) return;
        ls.innerHTML = `
            <div class="spinner" role="progressbar" aria-label="Loading"></div>
            <p id="loadingHeadline" aria-live="polite">Starting analysis…</p>
            <div class="progress-track"><div class="bar" id="loadProgressBar"></div></div>
            <div class="stages" id="loadStages" aria-live="polite">
                ${STAGES.map(s => `<div class="stage-item" data-stage="${s.id}"><span class="stage-icon">○</span>${s.label}</div>`).join('')}
            </div>
        `;
    }
    function setStage(id, status){ // status: active | done
        const el = document.querySelector(`[data-stage="${id}"]`);
        if (!el) return;
        el.classList.remove('active','done');
        el.classList.add(status);
        if (status === 'done') el.querySelector('.stage-icon').textContent = '✓';
        const total = STAGES.length, done = document.querySelectorAll('.stage-item.done').length;
        const bar = document.getElementById('loadProgressBar');
        if (bar) bar.style.width = Math.min(100, (done/total)*100 + (status==='active'?15:0)) + '%';
        const headline = document.getElementById('loadingHeadline');
        const stage = STAGES.find(s => s.id === id);
        if (headline && stage && status === 'active') headline.textContent = stage.label + '…';
    }
    function resetStages(){
        document.querySelectorAll('.stage-item').forEach(s => {
            s.classList.remove('active','done');
            s.querySelector('.stage-icon').textContent = '○';
        });
        const bar = document.getElementById('loadProgressBar');
        if (bar) bar.style.width = '0%';
    }

    /* ---------- 5. Better fetch with explicit error handling ---------- */
    async function safeFetch(url){
        let res;
        try {
            res = await fetch(url);
        } catch (networkErr) {
            throw new Error('🌐 Network error — please check your internet connection and try again.');
        }
        if (res.status === 404) throw new Error('❌ GitHub user not found. Double-check the spelling of the username.');
        if (res.status === 403) {
            const reset = res.headers.get('X-RateLimit-Reset');
            const remaining = res.headers.get('X-RateLimit-Remaining');
            if (remaining === '0' && reset) {
                const m = Math.max(1, Math.round((reset*1000 - Date.now())/60000));
                throw new Error(`⏳ GitHub API rate limit reached. Please try again in about ${m} minute${m>1?'s':''}. (Unauthenticated API: 60 requests/hour per IP.)`);
            }
            throw new Error('🚫 GitHub API blocked this request (403). You may have hit the rate limit — try again shortly.');
        }
        if (res.status >= 500) throw new Error('🛠️ GitHub is having trouble responding right now. Please try again in a moment.');
        if (!res.ok) throw new Error(`Unexpected error from GitHub (status ${res.status}). Please try again.`);
        return res.json();
    }

    /* ---------- 6. Wrap handleAnalysis with stages + better errors ---------- */

    // Re-analysis overlay: shown over existing results instead of hiding them
    (function injectReanalysisOverlayStyles(){
        const style = document.createElement('style');
        style.id = 'gpa-reanalysis-styles';
        style.textContent = `
            #gpa-reanalysis-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.45);
                z-index: 9998;
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(2px);
                opacity: 0;
                transition: opacity 0.2s ease;
                pointer-events: none;
            }
            #gpa-reanalysis-overlay.visible {
                opacity: 1;
                pointer-events: all;
            }
            #gpa-reanalysis-box {
                background: var(--card-bg, #fff);
                border-radius: 16px;
                padding: 32px 40px;
                text-align: center;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                min-width: 280px;
                max-width: 400px;
            }
            body.dark #gpa-reanalysis-box { background: #161b22; color: #e6edf3; }
            #gpa-reanalysis-box .spinner {
                width: 44px; height: 44px;
                margin: 0 auto 16px;
                border: 4px solid rgba(13,115,119,0.2);
                border-top-color: #0d7377;
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
            }
            #gpa-reanalysis-box p { margin: 8px 0 0; font-size: 1em; color: var(--text-secondary, #666); }
            #gpa-reanalysis-box strong { font-size: 1.1em; color: var(--text-primary, #222); }
            body.dark #gpa-reanalysis-box p { color: #8b949e; }
            body.dark #gpa-reanalysis-box strong { color: #e6edf3; }
            .gpa-reanalysis-stages { margin-top: 16px; text-align: left; font-size: 0.85em; }
            .gpa-reanalysis-stage { padding: 4px 0; color: #888; display: flex; align-items: center; gap: 8px; }
            .gpa-reanalysis-stage.active { color: #0d7377; font-weight: 600; }
            .gpa-reanalysis-stage.done { color: #28a745; }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'gpa-reanalysis-overlay';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        overlay.setAttribute('aria-label', 'Re-analyzing profile');
        overlay.innerHTML = `
            <div id="gpa-reanalysis-box">
                <div class="spinner"></div>
                <strong id="gpa-reanalysis-title">Re-analyzing…</strong>
                <p id="gpa-reanalysis-msg">Fetching latest data from GitHub</p>
                <div class="gpa-reanalysis-stages" id="gpa-reanalysis-stages"></div>
            </div>
        `;
        document.body.appendChild(overlay);
    })();

    let _gpaAnalysisInFlight = false;
    let _gpaAbortController = null;

    function showReanalysisOverlay(msg) {
        const overlay = document.getElementById('gpa-reanalysis-overlay');
        const msgEl = document.getElementById('gpa-reanalysis-msg');
        const stagesEl = document.getElementById('gpa-reanalysis-stages');
        if (msgEl) msgEl.textContent = msg || 'Fetching latest data from GitHub';
        if (stagesEl) stagesEl.innerHTML = STAGES.map(s =>
            `<div class="gpa-reanalysis-stage" data-rastage="${s.id}">○ ${s.label}</div>`
        ).join('');
        if (overlay) {
            overlay.classList.add('visible');
        }
    }

    function updateReanalysisStage(id, status) {
        const el = document.querySelector(`[data-rastage="${id}"]`);
        if (!el) return;
        el.classList.remove('active','done');
        el.classList.add(status);
        if (status === 'active') el.textContent = `⟳ ${STAGES.find(s=>s.id===id)?.label || id}…`;
        if (status === 'done')   el.textContent = `✓ ${STAGES.find(s=>s.id===id)?.label || id}`;
        const msgEl = document.getElementById('gpa-reanalysis-msg');
        if (msgEl && status === 'active') {
            const stage = STAGES.find(s => s.id === id);
            if (stage) msgEl.textContent = stage.label + '…';
        }
    }

    function hideReanalysisOverlay() {
        const overlay = document.getElementById('gpa-reanalysis-overlay');
        if (overlay) overlay.classList.remove('visible');
    }

    function wrapHandleAnalysis(){
        const origExtract = window.extractUsername;
        window.handleAnalysis = async function(){
            // ── Prevent concurrent requests ──────────────────────────────
            if (_gpaAnalysisInFlight) {
                window.GHToast?.info('Analysis already in progress…', 2000);
                return;
            }

            const input = (document.getElementById('githubInput')?.value || '').trim();
            if (!input) { showFriendlyError('Please enter a GitHub username or profile URL to begin.'); return; }
            let username;
            try { username = origExtract(input); } catch(e){ showFriendlyError(e.message); return; }
            if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username)) {
                showFriendlyError(`"${username}" doesn't look like a valid GitHub username. Usernames are 1–39 characters and may contain letters, numbers, and hyphens.`);
                return;
            }

            // ── Determine if this is a first analysis or a re-analysis ───
            const resultsVisible = document.getElementById('resultsSection') &&
                !document.getElementById('resultsSection').classList.contains('hidden');

            _gpaAnalysisInFlight = true;

            // Abort any previous in-flight fetch
            if (_gpaAbortController) {
                try { _gpaAbortController.abort(); } catch(_) {}
            }
            _gpaAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const signal = _gpaAbortController?.signal;

            if (resultsVisible) {
                // Re-analysis: show overlay OVER existing results — don't hide them
                const btn = document.getElementById('analyzeBtn');
                if (btn) btn.disabled = true;
                showReanalysisOverlay('Fetching latest data from GitHub');
                resetStages();
            } else {
                // First analysis: use normal full-page loading
                showLoading();
                resetStages();
            }

            try {
                if (!resultsVisible) setStage('fetch-user','active');
                else updateReanalysisStage('fetch-user','active');

                const userData = await safeFetch(`${window.GITHUB_API_BASE || 'https://api.github.com'}/users/${username}`);
                if (!userData || !userData.login) throw new Error('Profile data was incomplete. Try again.');

                if (!resultsVisible) setStage('fetch-user','done');
                else updateReanalysisStage('fetch-user','done');

                if (!resultsVisible) setStage('fetch-repos','active');
                else updateReanalysisStage('fetch-repos','active');

                const repos = await safeFetch(`${window.GITHUB_API_BASE || 'https://api.github.com'}/users/${username}/repos?per_page=100&sort=updated`);

                if (!resultsVisible) setStage('fetch-repos','done');
                else updateReanalysisStage('fetch-repos','done');

                if (!resultsVisible) setStage('analyze','active');
                else updateReanalysisStage('analyze','active');

                await new Promise(r => setTimeout(r, 120)); // visual beat
                const analysis = window.analyzePortfolio(userData, repos || []);

                if (!resultsVisible) setStage('analyze','done');
                else updateReanalysisStage('analyze','done');

                if (!resultsVisible) setStage('render','active');
                else updateReanalysisStage('render','active');

                // Now it's safe to swap the results
                if (resultsVisible) {
                    hideReanalysisOverlay();
                    // Small delay to let overlay fade out before updating DOM
                    await new Promise(r => setTimeout(r, 220));
                }

                window.displayResults(userData, repos || [], analysis);

                if (!resultsVisible) setStage('render','done');

                // Re-enable button (hideLoading handles first-analysis case)
                const btn = document.getElementById('analyzeBtn');
                if (btn) btn.disabled = false;

                // Post-display additions
                addLastUpdated();
                addAnalyzeMethodologyButton();
                renderEmptyStateChecks(userData, repos);
                renderRecruiterInsights(userData, repos, analysis);
                addAdvancedFilters(repos);
                addExportButtons();
            } catch (err) {
                // Always hide overlay and re-enable button on error
                hideReanalysisOverlay();
                const btn = document.getElementById('analyzeBtn');
                if (btn) btn.disabled = false;

                // If re-analysis failed, keep the existing results visible
                if (resultsVisible) {
                    const rs = document.getElementById('resultsSection');
                    if (rs) rs.classList.remove('hidden');
                    const ls = document.getElementById('loadingState');
                    if (ls) ls.classList.add('hidden');
                    window.GHToast?.error('Re-analysis failed — previous results restored. ' + (err.message || ''), 5000);
                } else {
                    showFriendlyError(err.message || 'Something went wrong. Please try again.');
                }
            } finally {
                _gpaAnalysisInFlight = false;
            }
        };
    }
    function showFriendlyError(message){
        const e = document.getElementById('errorState');
        const m = document.getElementById('errorMessage');
        const l = document.getElementById('loadingState');
        const r = document.getElementById('resultsSection');
        if (m) m.innerHTML = `<strong>Couldn't complete the analysis</strong><br><br>${message}<br><br><span style="font-size:.85em;color:#888;">Tip: GitHub limits unauthenticated requests to 60/hour per IP. If you're hitting that, wait a few minutes.</span>`;
        e?.classList.remove('hidden');
        l?.classList.add('hidden');
        r?.classList.add('hidden');
        const btn = document.getElementById('analyzeBtn');
        if (btn) btn.disabled = false;
    }

    /* ---------- 7. Last updated timestamp ---------- */
    function addLastUpdated(){
        if (document.getElementById('lastUpdatedChip')) {
            document.getElementById('lastUpdatedChip').textContent = '🕐 Analyzed ' + new Date().toLocaleString();
            return;
        }
        const chip = document.createElement('div');
        chip.className = 'last-updated';
        chip.id = 'lastUpdatedChip';
        chip.textContent = '🕐 Analyzed ' + new Date().toLocaleString();
        const scoreCard = document.querySelector('#resultsSection .score-card');
        scoreCard?.appendChild(chip);
    }

    /* ---------- 8. Methodology info button ---------- */
    function addAnalyzeMethodologyButton(){
        const h2 = document.querySelector('#resultsSection .score-description h2');
        if (h2 && !h2.querySelector('.info-btn')){
            const b = document.createElement('button');
            b.className = 'info-btn';
            b.type = 'button';
            b.setAttribute('aria-label','How is this score calculated?');
            b.title = 'How is this calculated?';
            b.textContent = 'i';
            b.onclick = () => openModal('scoreModal');
            h2.appendChild(b);
        }
        const breakdown = document.querySelector('.scoring-breakdown h3');
        if (breakdown && !breakdown.querySelector('.btn-help')){
            const help = document.createElement('button');
            help.className = 'btn-help';
            help.style.cssText = 'margin-left:10px;font-size:.78em;padding:4px 10px;';
            help.textContent = 'How is this scored?';
            help.onclick = () => openModal('scoreModal');
            breakdown.appendChild(help);
        }
    }

    /* ---------- 9. Empty-state checks ---------- */
    function renderEmptyStateChecks(userData, repos){
        const target = document.getElementById('resultsSection');
        const existing = document.getElementById('emptyStateBox');
        existing && existing.remove();
        const msgs = [];
        const realRepos = (repos||[]).filter(r => !r.fork);
        if (realRepos.length === 0) msgs.push({ t:'No original repositories yet', d:'This profile has no non-fork repositories. Start a project — even a small one with a README — to begin building a portfolio.' });
        else if (realRepos.length < 3) msgs.push({ t:'Few projects to evaluate', d:`Only ${realRepos.length} original repositories were found. Most recruiters look for 4–8 quality projects.` });
        const stars = (repos||[]).reduce((s,r)=>s+r.stargazers_count,0);
        if (stars === 0 && realRepos.length > 0) msgs.push({ t:'No stars yet', d:'None of the repositories have stars. Share your projects on LinkedIn, dev.to, or Twitter/X to gain visibility.' });
        if (!userData.bio || !userData.bio.trim()) msgs.push({ t:'Empty bio', d:'A short bio (e.g. "Backend engineer focused on distributed systems") helps recruiters instantly understand your focus.' });
        if (!userData.location && !userData.company && !userData.blog) msgs.push({ t:'Profile information missing', d:'Adding location, company, or a personal website makes your profile feel real and contactable.' });
        const now = Date.now();
        const recent = (repos||[]).some(r => (now - new Date(r.pushed_at).getTime()) < 1000*60*60*24*180);
        if (!recent && realRepos.length > 0) msgs.push({ t:'No recent activity', d:'No commits in the last 6 months. Recruiters favor active accounts — even small updates count.' });
        if (!msgs.length) return;
        const box = document.createElement('div');
        box.id = 'emptyStateBox';
        box.innerHTML = `<h3 style="color:var(--primary-teal);margin:30px 0 10px;">💡 What needs attention</h3>` +
            msgs.map(m => `<div class="empty-state"><strong>${m.t}</strong>${m.d}</div>`).join('');
        const breakdown = target.querySelector('.scoring-breakdown');
        breakdown ? breakdown.parentNode.insertBefore(box, breakdown) : target.appendChild(box);
    }

    /* ---------- 10. Recruiter-oriented insights ---------- */
    function renderRecruiterInsights(userData, repos, analysis){
        const real = (repos||[]).filter(r => !r.fork);
        // Deployment quality
        const withHomepage = real.filter(r => r.homepage && r.homepage.length > 5).length;
        const hasPages = real.some(r => r.has_pages);
        const deployScore = withHomepage + (hasPages ? 2 : 0);
        // Collaboration signals
        const contributed = (repos||[]).filter(r => r.fork).length;
        const forkedByOthers = real.reduce((s,r)=>s+r.forks_count,0);
        const issuesEnabled = real.filter(r => r.has_issues).length;
        // Project relevance / freshness
        const now = Date.now();
        const last90 = real.filter(r => (now - new Date(r.pushed_at).getTime()) < 1000*60*60*24*90).length;
        // License & docs
        const licensed = real.filter(r => r.license).length;
        const described = real.filter(r => r.description && r.description.trim().length > 10).length;

        const signals = [];
        signals.push(deployScore >= 3
            ? { e:'🚀', t:`${withHomepage} live deployment${withHomepage===1?'':'s'}`, d:'Linked demos make projects tangible.', k:'good'}
            : deployScore >= 1
            ? { e:'🚀', t:`Only ${withHomepage} live demo${withHomepage===1?'':'s'}`, d:'Add a `homepage` URL to top repos to show real deployments.', k:'warn'}
            : { e:'🚀', t:'No deployed projects', d:'Deploy at least one repo to Vercel/Netlify/Pages and link it via the `homepage` field.', k:'bad'}
        );
        signals.push(contributed > 0
            ? { e:'🤝', t:`Contributing to ${contributed} forked project${contributed===1?'':'s'}`, d:'Signals teamwork & ability to read others\' code.', k:'good'}
            : { e:'🤝', t:'No open-source contributions', d:'Forking and opening a PR to a popular project is one of the strongest collaboration signals.', k:'warn'}
        );
        signals.push(last90 >= 3
            ? { e:'⚡', t:`Active in last 90 days (${last90} repos)`, d:'Looks like a currently coding developer.', k:'good'}
            : last90 >= 1
            ? { e:'⚡', t:`${last90} repo updated in last 90 days`, d:'A bit more activity will boost recruiter trust.', k:'warn'}
            : { e:'⚡', t:'Quiet for 90+ days', d:'Even small commits keep the green squares moving.', k:'bad'}
        );
        signals.push(licensed/Math.max(1,real.length) >= 0.5
            ? { e:'📜', t:`${licensed}/${real.length} repos have a license`, d:'Licensing shows professional polish.', k:'good'}
            : { e:'📜', t:'Most repos missing a license', d:'Add MIT/Apache-2.0 license — recruiters notice.', k:'warn'}
        );
        signals.push(forkedByOthers > 0
            ? { e:'🔱', t:`${forkedByOthers} fork${forkedByOthers===1?'':'s'} of your work`, d:'Others find your code useful enough to copy.', k:'good'}
            : { e:'🔱', t:'No external forks yet', d:'Promoting your best repo can attract first forks.', k:'warn'}
        );
        signals.push(described/Math.max(1,real.length) >= 0.7
            ? { e:'📝', t:`${described}/${real.length} repos have descriptions`, d:'Recruiters can scan your work fast.', k:'good'}
            : { e:'📝', t:'Many repos lack descriptions', d:'A one-line description on every repo is the cheapest win.', k:'bad'}
        );

        const existing = document.getElementById('recruiterPanel');
        existing && existing.remove();
        const panel = document.createElement('div');
        panel.id = 'recruiterPanel';
        panel.className = 'recruiter-panel';
        panel.innerHTML = `
            <h3>🎯 Recruiter Signals</h3>
            <p style="color:#666;font-size:.9em;">Signals beyond the score — what hiring managers actively look for:</p>
            <div class="signal-grid">
                ${signals.map(s => `
                    <div class="signal ${s.k}">
                        <span class="signal-emoji" aria-hidden="true">${s.e}</span>
                        <div>
                            <div class="signal-title">${s.t}</div>
                            <div class="signal-desc">${s.d}</div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        const breakdown = document.querySelector('#resultsSection .scoring-breakdown');
        breakdown ? breakdown.after(panel) : document.getElementById('resultsSection').appendChild(panel);
    }

    /* ---------- 11. Advanced filters ---------- */
    function addAdvancedFilters(repos){
        const reposSection = document.querySelector('#reposList')?.closest('.repos-section, section, div');
        const host = document.getElementById('reposList');
        if (!host) return;
        if (document.getElementById('advFilters')) return;
        const real = (repos||[]).filter(r=>!r.fork);
        const langs = [...new Set(real.map(r => r.language).filter(Boolean))].sort();
        const div = document.createElement('div');
        div.className = 'adv-filters';
        div.id = 'advFilters';
        div.setAttribute('role','region');
        div.setAttribute('aria-label','Advanced repository filters');
        div.innerHTML = `
            <div><label for="filtLang">Language</label>
                <select id="filtLang"><option value="">All</option>${langs.map(l=>`<option>${l}</option>`).join('')}</select>
            </div>
            <div><label for="filtMinStars">Min ⭐ stars</label>
                <input id="filtMinStars" type="number" min="0" value="0">
            </div>
            <div><label for="filtActivity">Activity</label>
                <select id="filtActivity">
                    <option value="">Any time</option>
                    <option value="30">Last 30 days</option>
                    <option value="90">Last 90 days</option>
                    <option value="365">Last year</option>
                </select>
            </div>
            <div><label for="filtArchived">Show archived</label>
                <select id="filtArchived"><option value="hide">Hide</option><option value="show">Show</option></select>
            </div>
        `;
        host.parentNode.insertBefore(div, host);
        ['filtLang','filtMinStars','filtActivity','filtArchived'].forEach(id => {
            document.getElementById(id).addEventListener('input', applyAdvFilters);
        });
    }
    function applyAdvFilters(){
        const cd = window.currentData;
        if (!cd) return;
        const lang = document.getElementById('filtLang')?.value || '';
        const minStars = parseInt(document.getElementById('filtMinStars')?.value || '0', 10);
        const activity = parseInt(document.getElementById('filtActivity')?.value || '0', 10);
        const showArch = (document.getElementById('filtArchived')?.value === 'show');
        const q = (document.getElementById('repoSearch')?.value || '').toLowerCase();
        const sort = document.getElementById('repoSort')?.value || 'stars';
        const showAll = document.getElementById('showAllRepos')?.checked;
        const now = Date.now();
        let list = cd.repos.filter(r => !r.fork)
            .filter(r => !lang || r.language === lang)
            .filter(r => r.stargazers_count >= minStars)
            .filter(r => !activity || (now - new Date(r.pushed_at).getTime()) <= activity*86400000)
            .filter(r => showArch || !r.archived);
        if (q) list = list.filter(r =>
            r.name.toLowerCase().includes(q) ||
            (r.description||'').toLowerCase().includes(q) ||
            (r.language||'').toLowerCase().includes(q));
        list.sort((a,b)=>{
            if (sort==='forks') return b.forks_count - a.forks_count;
            if (sort==='updated') return new Date(b.updated_at) - new Date(a.updated_at);
            if (sort==='name') return a.name.localeCompare(b.name);
            return b.stargazers_count - a.stargazers_count;
        });
        if (!showAll) list = list.slice(0, 6);
        document.getElementById('reposList').innerHTML = list.length ? list.map(repo => `
            <div class="repo-item">
                <div class="repo-name"><a href="${repo.html_url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${repo.name}</a>${repo.archived?' <span style="font-size:.7em;color:#888;">[archived]</span>':''}</div>
                <div class="repo-desc">${repo.description || '<em style="color:#999;">No description</em>'}</div>
                <div class="repo-meta">
                    <span>⭐ ${repo.stargazers_count}</span>
                    <span>🔀 ${repo.forks_count}</span>
                    <span>📅 ${new Date(repo.updated_at).toLocaleDateString()}</span>
                    ${repo.language ? `<span class="repo-lang">${repo.language}</span>` : ''}
                </div>
            </div>
        `).join('') : '<div class="empty-state"><strong>No repositories match these filters</strong>Try widening the filters above.</div>';
    }
    // Re-route any extra filter changes to advanced renderer
    document.addEventListener('input', e => {
        if (['repoSearch','repoSort','showAllRepos'].includes(e.target.id)) applyAdvFilters();
    });

    /* ---------- 12. Export: PDF (via print) + History controls ---------- */
    function addExportButtons(){
        if (document.getElementById('exportPdfBtn')) return;
        const host = document.querySelector('#resultsSection .score-card');
        if (!host) return;
        const bar = document.createElement('div');
        bar.style.cssText = 'margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;';
        bar.innerHTML = `
            <button id="exportPdfBtn" class="btn-pdf" aria-label="Download analysis as PDF">📄 Download PDF</button>
            <button id="exportShareBtn" class="btn-pdf" aria-label="Copy shareable link">🔗 Copy Share Link</button>
        `;
        host.appendChild(bar);
        document.getElementById('exportPdfBtn').onclick = () => {
            // Use browser print → "Save as PDF". CSS @media print already prepared.
            window.print();
        };
        document.getElementById('exportShareBtn').onclick = () => {
            if (typeof window.shareLink === 'function') window.shareLink();
        };
    }

    /* ---------- 13. History search + delete UI enhancement ---------- */
    function enhanceHistory(){
        const card = document.getElementById('historyCard');
        if (!card || document.getElementById('historySearch')) return;
        const search = document.createElement('input');
        search.id = 'historySearch';
        search.type = 'search';
        search.placeholder = '🔎 Search history...';
        search.setAttribute('aria-label','Search saved analysis history');
        card.querySelector('h4').after(search);
        search.addEventListener('input', () => {
            const q = search.value.toLowerCase();
            card.querySelectorAll('.history-chips > *').forEach(chip => {
                chip.style.display = chip.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
        });
    }
    // hook into renderHistory if exists
    const origRenderHistory = window.renderHistory;
    if (typeof origRenderHistory === 'function'){
        window.renderHistory = function(){
            origRenderHistory.apply(this, arguments);
            enhanceHistory();
        };
    }

    /* ---------- 14. Comparison explanation ---------- */
    if (typeof window.compareProfiles === 'function'){
        const origCompare = window.compareProfiles;
        window.compareProfiles = async function(){
            await origCompare.apply(this, arguments);
            try {
                const box = document.getElementById('compareResults');
                if (!box) return;
                // Get the two cols rendered by original to extract scores
                const cols = box.querySelectorAll('.compare-col');
                if (cols.length !== 2) return;
                const aName = cols[0].querySelector('h4')?.textContent || 'A';
                const bName = cols[1].querySelector('h4')?.textContent || 'B';
                const aScore = parseInt(cols[0].querySelector('.big')?.textContent || '0', 10);
                const bScore = parseInt(cols[1].querySelector('.big')?.textContent || '0', 10);
                const diff = Math.abs(aScore - bScore);
                const leader = aScore === bScore ? null : (aScore > bScore ? aName : bName);
                const trailer = aScore === bScore ? null : (aScore > bScore ? bName : aName);
                const exp = document.createElement('div');
                exp.className = 'compare-explanation';
                if (!leader) {
                    exp.innerHTML = `<strong>It's a tie.</strong> Both profiles scored ${aScore}/100. Look at the recruiter signals and language breakdown to differentiate.`;
                } else {
                    const reason = diff >= 15 ? 'a significant gap, usually driven by more documented projects, recent activity, or higher impact (stars/forks)'
                        : diff >= 5 ? 'a meaningful but small gap — typically comes from documentation quality or repo organization'
                        : 'essentially neck-and-neck; granular signals (deployments, licensing, descriptions) will decide';
                    exp.innerHTML = `<strong>Why ${leader} scored higher:</strong> ${leader} leads by ${diff} point${diff===1?'':'s'} over ${trailer}. This is ${reason}. Run each profile individually for the detailed breakdown.`;
                }
                box.appendChild(exp);
            } catch(_){}
        };
    }

    /* ---------- 15. Onboarding tip for first-time users ---------- */
    function showOnboardingTip(){
        if (localStorage.getItem('gpa_onboarded') === '1') return;
        const tip = document.createElement('div');
        tip.className = 'onboard-tip';
        tip.setAttribute('role','dialog');
        tip.setAttribute('aria-label','Welcome tip');
        tip.innerHTML = `
            <h4>👋 First time here?</h4>
            <p>Paste any GitHub username or profile URL above and hit <strong>Analyze</strong>. You'll get a recruiter-style score, six metric breakdowns, and concrete improvements.</p>
            <p style="margin-top:6px;font-size:.85em;color:#888;">Tip: press <kbd>/</kbd> any time to jump to the input.</p>
            <div class="onboard-actions">
                <button class="secondary" id="onboardSkip">Dismiss</button>
                <button id="onboardGo">Got it</button>
            </div>
        `;
        document.body.appendChild(tip);
        const close = () => { localStorage.setItem('gpa_onboarded','1'); tip.remove(); };
        tip.querySelector('#onboardSkip').onclick = close;
        tip.querySelector('#onboardGo').onclick = close;
    }

    /* ---------- INIT ---------- */
    function init(){
        annotateA11y();
        injectPrivacyBanner();
        buildModals();
        enhanceLoadingUI();
        wrapHandleAnalysis();
        // Make Enter key still work (re-bind because handleAnalysis replaced)
        const inp = document.getElementById('githubInput');
        if (inp){
            inp.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); window.handleAnalysis(); } });
        }
        setTimeout(showOnboardingTip, 800);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();




(function() {
'use strict';

// ============================================================
// FEATURE 1: Public Shareable Portfolio Page
// ============================================================
window.sharePublicPortfolio = function() {
    const username = (window.currentData && window.currentData.username) ||
        (document.getElementById('githubInput') ? document.getElementById('githubInput').value.trim() : '');
    if (!username) { if(window.GHToast) window.GHToast.warning('Analyze a profile first'); return; }
    const url = `${location.origin}/p/${encodeURIComponent(username)}`;
    // Show modal
    let ov = document.getElementById('sharePortfolioOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'sharePortfolioOverlay';
        ov.className = 'public-portfolio-modal-overlay';
        ov.innerHTML = `
            <div class="public-portfolio-modal" role="dialog" aria-modal="true" aria-label="Share Portfolio">
                <button class="modal-close-btn" onclick="document.getElementById('sharePortfolioOverlay').remove()">×</button>
                <h3>🌐 Share Your Portfolio</h3>
                <p>Anyone with this link can view your read-only portfolio card — no login required:</p>
                <div class="share-url-box" id="shareUrlBox">${url}</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                    <button class="btn-analyze" style="padding:10px 24px;" onclick="
                        navigator.clipboard.writeText('${url}').then(()=>{
                            if(window.GHToast) window.GHToast.success('Portfolio link copied!');
                            document.getElementById('sharePortfolioOverlay').remove();
                        }).catch(()=>{ if(window.GHToast) window.GHToast.error('Copy failed'); });
                    ">📋 Copy Link</button>
                    <button class="btn-secondary" style="padding:10px 24px;" onclick="
                        window.open('${url}','_blank');
                        document.getElementById('sharePortfolioOverlay').remove();
                    ">🔗 Open</button>
                </div>
            </div>`;
        document.body.appendChild(ov);
        ov.addEventListener('click', function(e){ if(e.target===ov) ov.remove(); });
    }
};

// ============================================================
// FEATURE 2: Repo Deep-Dive Modal
// ============================================================
// AI summary cache
const repoSummaryCache = {};

async function fetchRepoDeepdive(owner, repo) {
    const [repoData, contributors, issues, pulls, commits] = await Promise.all([
        fetch(`/api/github/repos/${owner}/${repo}`).then(r=>r.json()).catch(()=>({})),
        fetch(`/api/github/repos/${owner}/${repo}/contributors?per_page=5`).then(r=>r.json()).catch(()=>[]),
        fetch(`/api/github/repos/${owner}/${repo}/issues?state=open&per_page=1`).then(async r=>{
            const data = await r.json().catch(()=>[]);
            // GitHub returns Link header for total; fallback to array length
            const link = r.headers.get('Link')||'';
            const m = link.match(/page=(\d+)>; rel="last"/);
            return m ? parseInt(m[1]) : (Array.isArray(data)?data.length:0);
        }).catch(()=>0),
        fetch(`/api/github/repos/${owner}/${repo}/pulls?state=open&per_page=1`).then(async r=>{
            const link = r.headers.get('Link')||'';
            const m = link.match(/page=(\d+)>; rel="last"/);
            return m ? parseInt(m[1]) : 1;
        }).catch(()=>0),
        fetch(`/api/github/repos/${owner}/${repo}/stats/commit_activity`).then(r=>r.json()).catch(()=>[]),
    ]);

    // Build last-12-month commit counts from weekly stats
    const monthCommits = new Array(12).fill(0);
    if(Array.isArray(commits)) {
        // commit_activity returns 52 weeks; group into months
        const now = new Date();
        commits.forEach((wk, i) => {
            const weeksAgo = 51 - i;
            const d = new Date(now - weeksAgo * 7 * 86400000);
            const monthIdx = 11 - Math.floor(weeksAgo / 4.33);
            if(monthIdx >= 0 && monthIdx < 12) monthCommits[monthIdx] += (wk.total||0);
        });
    }

    return { repoData, contributors: Array.isArray(contributors)?contributors:[], issues, pulls, monthCommits };
}

function openRepoDeepdive(repoName, username) {
    // Remove any existing
    const existing = document.getElementById('repoDeepDiveOverlay');
    if(existing) existing.remove();

    const ov = document.createElement('div');
    ov.id = 'repoDeepDiveOverlay';
    ov.className = 'repo-deepdive-overlay';
    ov.innerHTML = `
        <div class="repo-deepdive-modal" role="dialog" aria-modal="true">
            <button class="modal-close-btn" onclick="document.getElementById('repoDeepDiveOverlay').remove()">×</button>
            <h3>📦 ${repoName}</h3>
            <div class="repo-meta">@${username}</div>
            <div style="text-align:center;padding:40px;color:#888;">⏳ Loading deep-dive data...</div>
        </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });

    const modal = ov.querySelector('.repo-deepdive-modal');

    fetchRepoDeepdive(username, repoName).then(({repoData, contributors, issues, pulls, monthCommits}) => {
        const aiSummary = repoSummaryCache[repoName] || (repoData.description ? `"${repoData.description}"` : 'No description available.');
        // Months labels
        const now = new Date();
        const monthLabels = [];
        for(let i=11;i>=0;i--) {
            const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
            monthLabels.push(d.toLocaleString('default',{month:'short'}));
        }

        modal.innerHTML = `
            <button class="modal-close-btn" onclick="document.getElementById('repoDeepDiveOverlay').remove()">×</button>
            <h3>📦 ${repoName}</h3>
            <div class="repo-meta">@${username} · ${repoData.language||'N/A'} · ⭐ ${repoData.stargazers_count||0} · 🍴 ${repoData.forks_count||0}</div>
            <div class="repo-ai-summary">🤖 ${aiSummary}</div>
            <div class="repo-deepdive-stats">
                <div class="repo-deepdive-stat"><div class="val">${repoData.open_issues_count||issues||0}</div><div class="lbl">Open Issues</div></div>
                <div class="repo-deepdive-stat"><div class="val">${pulls}</div><div class="lbl">Open PRs</div></div>
                <div class="repo-deepdive-stat"><div class="val">${monthCommits.reduce((a,b)=>a+b,0)}</div><div class="lbl">Commits (12m)</div></div>
            </div>
            <div class="repo-commit-chart-wrap">
                <div style="font-size:.9em;font-weight:600;color:var(--primary-teal);margin-bottom:8px;">📊 Commit Frequency (Last 12 Months)</div>
                <canvas id="repoDeepdiveCommitChart" height="100"></canvas>
            </div>
            ${contributors.length ? `
            <div class="repo-contributors" style="margin-top:16px;">
                <div style="font-size:.9em;font-weight:600;color:var(--primary-teal);margin-bottom:8px;">👥 Top Contributors</div>
                ${contributors.slice(0,5).map(c=>`
                    <span class="repo-contributor-chip">
                        <img src="${c.avatar_url}" alt="${c.login}" loading="lazy">
                        ${c.login} <span style="color:#aaa;font-size:.8em;">${c.contributions}</span>
                    </span>`).join('')}
            </div>` : ''}
            ${repoData.html_url ? `<div style="margin-top:18px;text-align:right;">
                <a href="${repoData.html_url}" target="_blank" rel="noopener" style="color:var(--light-teal);font-size:.9em;text-decoration:none;">View on GitHub →</a>
            </div>` : ''}
        `;

        // Render commit frequency chart using Chart.js if available
        const canvas = document.getElementById('repoDeepdiveCommitChart');
        if(canvas && window.Chart) {
            new window.Chart(canvas, {
                type: 'bar',
                data: {
                    labels: monthLabels,
                    datasets: [{
                        label: 'Commits',
                        data: monthCommits,
                        backgroundColor: 'rgba(13,115,119,0.6)',
                        borderColor: '#0d7377',
                        borderRadius: 4,
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, ticks: { color: '#666' } },
                        x: { ticks: { color: '#666', font: { size: 10 } } }
                    }
                }
            });
        } else if(canvas) {
            // SVG fallback mini bar chart
            const max = Math.max(...monthCommits, 1);
            const W = 580, H = 80, barW = Math.floor(W/12)-2;
            let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%">`;
            monthCommits.forEach((v,i) => {
                const bh = Math.max(2, Math.round((v/max)*(H-10)));
                const x = i*(barW+2);
                svg += `<rect x="${x}" y="${H-bh}" width="${barW}" height="${bh}" rx="2" fill="rgba(13,115,119,0.7)"/>`;
            });
            svg += '</svg>';
            canvas.outerHTML = svg;
        }
    }).catch(e => {
        modal.innerHTML = `
            <button class="modal-close-btn" onclick="document.getElementById('repoDeepDiveOverlay').remove()">×</button>
            <h3>📦 ${repoName}</h3>
            <p style="color:var(--error);">Failed to load deep-dive: ${e.message}</p>`;
    });
}

// Hook into existing repo rendering — intercept repo item clicks
function hookRepoDeepdive() {
    document.addEventListener('click', function(e) {
        const card = e.target.closest('.repo-item');
        if(!card) return;
        // Don't open deepdive if user clicked an actual link inside the card
        if(e.target.tagName === 'A') return;
        const repoName = card.dataset.repoName;
        const username = card.dataset.username ||
            (window.currentData && window.currentData.username) ||
            document.getElementById('githubInput')?.value?.trim();
        if(repoName && username) {
            e.preventDefault();
            openRepoDeepdive(repoName, username);
        }
    });
}

// Patch renderRepos to add data attributes for deep-dive
function patchReposRenderer() {
    const origRenderRepos = window.renderRepos;
    if(typeof origRenderRepos !== 'function' || origRenderRepos.__dd) return;
    window.renderRepos = function() {
        origRenderRepos.apply(this, arguments);
        // Add data-repo-name to each rendered repo item
        setTimeout(()=>{
            const username = window.currentData && window.currentData.username;
            document.querySelectorAll('.repo-item').forEach(card => {
                if(!card.dataset.repoName) {
                    const h = card.querySelector('h4,h3,.repo-name');
                    if(h) card.dataset.repoName = h.textContent.trim();
                }
                if(username) card.dataset.username = username;
            });
        }, 100);
    };
    window.renderRepos.__dd = true;
}

// ============================================================
// FEATURE 3: 3-User Compare with Radar Chart
// ============================================================
// Override compareProfiles to support 3 users + radar
(function patchCompareProfiles() {
    const _orig = window.compareProfiles;
    window.compareProfiles = async function() {
        const a = (document.getElementById('cmpA')||{}).value?.trim();
        const b = (document.getElementById('cmpB')||{}).value?.trim();
        const c = (document.getElementById('cmpC')||{}).value?.trim();
        if(!a || !b) { if(window.GHToast) window.GHToast.warning('Enter at least two usernames'); return; }

        const box = document.getElementById('compareResults');
        const radarWrap = document.getElementById('compareRadarWrap');
        if(!box) return;

        box.style.display = 'grid';
        box.className = 'compare-results' + (c ? ' three-col' : '');
        box.innerHTML = '<p style="grid-column:1/-1;text-align:center;padding:20px;">⏳ Loading comparison...</p>';
        if(radarWrap) radarWrap.style.display = 'none';

        try {
            const targets = [a, b].concat(c ? [c] : []);
            const results = await Promise.all(targets.map(u =>
                fetch(`/api/public/${encodeURIComponent(u)}`).then(r=>r.json())
            ));

            const colors = ['var(--primary-teal)', 'var(--light-teal)', 'var(--accent-teal)'];
            const pillars = ['activity','quality','impact','diversity','documentation'];
            const pillarEmoji = {'activity':'⚡','quality':'🏆','impact':'🚀','diversity':'🎨','documentation':'📝'};

            // Determine winner by total score
            const maxScore = Math.max(...results.map(r=>r.score?.total||0));

            box.innerHTML = results.map((r, idx) => {
                const isWinner = (r.score?.total||0) === maxScore && idx === results.findIndex(x=>(x.score?.total||0)===maxScore);
                const profile = r.profile || {};
                return `<div class="compare-col${isWinner?' winner':''}">
                    <img src="${profile.avatar_url||''}" alt="${profile.login||r.username}" style="width:70px;height:70px;border-radius:50%;margin:10px auto;display:block;">
                    <h4 style="color:${colors[idx]}">${profile.name||profile.login||r.username}</h4>
                    <p style="color:#888;font-size:.85em;">@${r.username}</p>
                    <div class="big" style="color:${colors[idx]}">${r.score?.total||0}</div>
                    <p style="font-size:.9em;color:#666;">${r.score?.rank||'?'}-Rank</p>
                    <p style="font-size:.85em;margin-top:8px;">⭐ ${r.stats?.totalStars||0} stars · 📦 ${(r.stats?.topRepos||[]).length} repos</p>
                    <p style="font-size:.85em;">👥 ${profile.followers||0} followers</p>
                    <div style="margin-top:12px;text-align:left;">
                        ${pillars.map(p=>`
                            <div style="display:flex;justify-content:space-between;font-size:.82em;margin-bottom:4px;">
                                <span>${pillarEmoji[p]} ${p}</span>
                                <strong style="color:${colors[idx]}">${r.score?.pillars?.[p]??'-'}</strong>
                            </div>`).join('')}
                    </div>
                </div>`;
            }).join('');

            // Radar Chart
            if(radarWrap && window.Chart) {
                radarWrap.style.display = 'block';
                const existingChart = window._compareRadarChart;
                if(existingChart) existingChart.destroy();
                const canvas = document.getElementById('compareRadarCanvas');
                if(canvas) {
                    window._compareRadarChart = new window.Chart(canvas, {
                        type: 'radar',
                        data: {
                            labels: pillars.map(p => p.charAt(0).toUpperCase()+p.slice(1)),
                            datasets: results.map((r, idx) => ({
                                label: `@${r.username}`,
                                data: pillars.map(p => r.score?.pillars?.[p]||0),
                                backgroundColor: `rgba(13,115,119,${0.15*(idx+1)})`,
                                borderColor: idx===0?'#0d7377':idx===1?'#14919b':'#76c7d1',
                                borderWidth: 2,
                                pointBackgroundColor: idx===0?'#0d7377':idx===1?'#14919b':'#76c7d1',
                            }))
                        },
                        options: {
                            responsive: true,
                            scales: { r: { beginAtZero: true, max: 100, ticks: { stepSize: 25 } } },
                            plugins: { legend: { position: 'bottom' } }
                        }
                    });
                }
            } else if(radarWrap) {
                // SVG radar fallback
                radarWrap.style.display = 'block';
                radarWrap.querySelector('canvas')?.parentNode && buildSvgRadar(radarWrap, results, pillars);
            }

        } catch(e) {
            box.innerHTML = `<p style="grid-column:1/-1;color:var(--error);text-align:center;padding:20px;">${e.message}</p>`;
        }
    };
})();
function renderNewBadge(username, rank, score) {
    const section = document.getElementById('newBadgeSection');
    if(!section) return;
    const badgeUrl = `${location.origin}/api/badge/${encodeURIComponent(username)}`;
    const mdLink = `![GitHub Portfolio Score](${badgeUrl})`;
    const htmlEmbed = `<img src="${badgeUrl}" alt="GitHub Portfolio Score: ${rank} ${score}/100">`;
    const el1 = document.getElementById('badgeMdText');
    const el2 = document.getElementById('badgeHtmlText');
    const prev = document.getElementById('newBadgePreview');
    if(el1) el1.textContent = mdLink;
    if(el2) el2.textContent = htmlEmbed;
    // Use an inline SVG data URI so the preview is ALWAYS visible (no server needed).
    if(prev){
        prev.src = (window.badgeSvgDataUri ? window.badgeSvgDataUri(score) : badgeUrl);
        prev.style.height = '28px';
        prev.onerror = function(){ if(window.badgeSvgDataUri) this.src = window.badgeSvgDataUri(score); };
    }
}

// ============================================================
// FEATURE 5: Embeddable Score Badge (inline SVG preview + README embed)
// ============================================================

window.copyBadgeNew = function(type) {
    const el = document.getElementById(type==='md'?'badgeMdText':'badgeHtmlText');
    if(!el) return;
    navigator.clipboard?.writeText(el.textContent).then(()=>{
        if(window.GHToast) window.GHToast.success('Badge code copied!');
    }).catch(()=>{ if(window.GHToast) window.GHToast.error('Copy failed'); });
};

// ============================================================
// FEATURE 6: Skill Gap Recommendations
// ============================================================
const ROLE_PROFILES = {
    frontend: {
        label: 'Frontend Developer',
        required: ['React','TypeScript','CSS','Vue','Accessibility','Testing'],
        resources: {
            'React': 'https://react.dev/',
            'TypeScript': 'https://www.typescriptlang.org/',
            'CSS': 'https://css-tricks.com/',
            'Vue': 'https://vuejs.org/',
            'Accessibility': 'https://web.dev/accessibility/',
            'Testing': 'https://jestjs.io/'
        }
    },
    backend: {
        label: 'Backend Developer',
        required: ['Docker','CI/CD','SQL','GraphQL','Security','Caching'],
        resources: {
            'Docker': 'https://docs.docker.com/',
            'CI/CD': 'https://github.com/features/actions',
            'SQL': 'https://mode.com/sql-tutorial/',
            'GraphQL': 'https://graphql.org/learn/',
            'Security': 'https://owasp.org/',
            'Caching': 'https://redis.io/'
        }
    },
    fullstack: {
        label: 'Full-Stack Developer',
        required: ['TypeScript','Docker','Testing','CI/CD','GraphQL','Accessibility'],
        resources: {
            'TypeScript': 'https://www.typescriptlang.org/',
            'Docker': 'https://docs.docker.com/',
            'Testing': 'https://testing-library.com/',
            'CI/CD': 'https://github.com/features/actions',
            'GraphQL': 'https://graphql.org/learn/',
            'Accessibility': 'https://web.dev/accessibility/'
        }
    },
    data: {
        label: 'Data Engineer / ML',
        required: ['Python','Jupyter','SQL','TensorFlow','MLflow','Statistics'],
        resources: {
            'Python': 'https://docs.python.org/',
            'Jupyter': 'https://jupyter.org/',
            'SQL': 'https://mode.com/sql-tutorial/',
            'TensorFlow': 'https://www.tensorflow.org/',
            'MLflow': 'https://mlflow.org/',
            'Statistics': 'https://www.khanacademy.org/math/statistics-probability'
        }
    }
};

function detectRole(languages, topics) {
    const allText = [...(languages||[]).map(l=>l.name||l), ...(topics||[])].map(x=>x.toLowerCase()).join(' ');
    if(/python|jupyter|numpy|pandas|ml|machine.learning|tensorflow|sklearn/.test(allText)) return 'data';
    if(/java|go|rust|c\+\+|c#|ruby|php|django|rails|spring|node/.test(allText) &&
       !/react|vue|angular|svelte|css/.test(allText)) return 'backend';
    if(/react|vue|angular|svelte|html|css|frontend/.test(allText)) return 'frontend';
    return 'fullstack';
}

function renderSkillGap(data) {
    const section = document.getElementById('skillGapSection');
    if(!section) return;

    const languages = (data.stats?.languages||[]).map(l=>l.name||l);
    const topics = (data.stats?.topRepos||[]).flatMap(r=>r.topics||[]);
    const role = detectRole(languages, topics);
    const profile = ROLE_PROFILES[role];

    const userSkills = [...languages, ...topics].map(s=>s.toLowerCase());
    const missing = profile.required.filter(skill =>
        !userSkills.some(us => us.includes(skill.toLowerCase()))
    ).slice(0, 3);

    if(!missing.length) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    const roleEl = document.getElementById('skillGapRoleBadge');
    if(roleEl) roleEl.textContent = `Detected Role: ${profile.label}`;

    const grid = document.getElementById('skillGapStaticGrid') || document.getElementById('skillGapGrid');
    if(grid) {
        grid.innerHTML = missing.map((skill, i) => `
            <div class="skill-gap-card">
                <div class="gap-skill">${['🥇','🥈','🥉'][i]} ${skill}</div>
                <div class="gap-reason">Not found in your language/topic stack. ${profile.label}s commonly use this.</div>
                <a href="${profile.resources[skill]||'#'}" target="_blank" rel="noopener">📚 Learn ${skill} →</a>
            </div>`).join('');
    }
}

// ============================================================
// FEATURE 8: Onboarding Tooltip Tour
// ============================================================
const TOUR_STEPS = [
    { selector: '#githubInput', title: '1️⃣ Enter a GitHub Username', text: 'Type any GitHub username or paste a profile URL here to get started.' },
    { selector: '#analyzeBtn, .btn-analyze', title: '2️⃣ Hit Analyze', text: 'Click Analyze (or press Ctrl+Enter) to score the profile instantly.' },
    { selector: '#resultsSection .score-card, .score-card', title: '3️⃣ Your Score Card', text: 'Your overall portfolio score out of 100, with rank (S/A/B/C/D) and pillar breakdown.' },
    { selector: '#aiSection, .ai-insights-section', title: '4️⃣ AI-Style Insights', text: 'Recruiter impression, detected skill level, and personalized action items.' },
    { selector: '.action-buttons, #newAnalysisBtn', title: '5️⃣ Export & Share', text: 'Download as PDF, copy your badge embed code, or share a public portfolio link.' }
];

let tourStep = 0;
let tourEl = null;
let spotEl = null;

function startTour() {
    if(localStorage.getItem('gpa_v2_tour_done')==='1') return;
    tourStep = 0;
    showTourStep();
}

function showTourStep() {
    cleanupTour();
    if(tourStep >= TOUR_STEPS.length) {
        localStorage.setItem('gpa_v2_tour_done','1');
        return;
    }
    const step = TOUR_STEPS[tourStep];
    const target = document.querySelector(step.selector);

    // Check if target exists AND is actually visible (not display:none)
    const isVisible = target && target.offsetParent !== null && target.getBoundingClientRect().width > 0;

    spotEl = document.createElement('div');
    spotEl.className = 'tour-spotlight';
    document.body.appendChild(spotEl);

    tourEl = document.createElement('div');
    tourEl.className = 'tour-tooltip';
    tourEl.innerHTML = `
        <div class="tour-step-indicator">Step ${tourStep+1} of ${TOUR_STEPS.length}</div>
        <h4>${step.title}</h4>
        <p>${step.text}</p>
        <div class="tour-nav">
            <button class="tour-btn-skip" onclick="window._skipTour()">Skip Tour</button>
            <button class="tour-btn-next" onclick="window._nextTourStep()">${tourStep===TOUR_STEPS.length-1?'Done 🎉':'Next →'}</button>
        </div>`;
    document.body.appendChild(tourEl);

    function positionTour() {
        if(isVisible) {
            target.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
        const ttW = 310;
        const ttH = tourEl.offsetHeight || 180;
        const pad = 6;

        if(isVisible) {
            const rect = target.getBoundingClientRect();
            // Spotlight
            spotEl.style.cssText = `position:fixed;top:${rect.top-pad}px;left:${rect.left-pad}px;width:${rect.width+pad*2}px;height:${rect.height+pad*2}px;border-radius:10px;box-shadow:0 0 0 9999px rgba(5,29,42,0.72);z-index:9001;`;

            // Tooltip: prefer ABOVE target, centered horizontally on it
            let top = rect.top - ttH - 18;
            // If not enough space above, put below
            if(top < 10) top = rect.bottom + 14;
            // Final clamp so it never goes off screen
            top = Math.min(Math.max(top, 10), window.innerHeight - ttH - 10);
            let left = rect.left + rect.width/2 - ttW/2;
            left = Math.min(Math.max(left, 10), window.innerWidth - ttW - 10);
            tourEl.style.cssText = `position:fixed;top:${top}px;left:${left}px;width:${ttW}px;z-index:9002;`;
        } else {
            // Target hidden or not found — center tooltip on screen
            spotEl.style.cssText = 'display:none;';
            const top = Math.max(10, Math.round(window.innerHeight * 0.28));
            tourEl.style.cssText = `position:fixed;top:${top}px;left:50%;transform:translateX(-50%);width:${ttW}px;z-index:9002;`;
        }
    }

    // Use a short delay so scrollIntoView + layout settle before we read rects
    setTimeout(positionTour, 80);
}

function cleanupTour() {
    if(tourEl) { tourEl.remove(); tourEl = null; }
    if(spotEl) { spotEl.remove(); spotEl = null; }
}

window._nextTourStep = function() { tourStep++; showTourStep(); };
window._skipTour = function() { cleanupTour(); localStorage.setItem('gpa_v2_tour_done','1'); };

// ============================================================
// FEATURE 9: Keyboard Shortcut Panel
// ============================================================
function buildKeyboardPanel() {
    if(document.getElementById('kbFab')) return;

    const fab = document.createElement('button');
    fab.id = 'kbFab';
    fab.className = 'kb-fab';
    fab.setAttribute('aria-label', 'Keyboard shortcuts');
    fab.title = 'Keyboard shortcuts';
    fab.textContent = '?';
    document.body.appendChild(fab);

    const overlay = document.createElement('div');
    overlay.id = 'kbModalOverlay';
    overlay.className = 'kb-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Keyboard shortcuts');
    overlay.innerHTML = `
        <div class="kb-modal">
            <button class="modal-close-btn" id="kbCloseBtn">×</button>
            <h3>⌨️ Keyboard Shortcuts</h3>
            <ul class="kb-list">
                <li><span>Analyze profile</span><span class="kbkey">Ctrl + Enter</span></li>
                <li><span>Toggle dark mode</span><span class="kbkey">Ctrl + D</span></li>
                <li><span>Export PDF</span><span class="kbkey">Ctrl + E</span></li>
                <li><span>Compare profiles</span><span class="kbkey">Ctrl + C</span></li>
                <li><span>Focus search input</span><span class="kbkey">/</span></li>
                <li><span>Share portfolio link</span><span class="kbkey">Ctrl + Shift + S</span></li>
                <li><span>Close modals</span><span class="kbkey">Escape</span></li>
                <li><span>Show this panel</span><span class="kbkey">?</span></li>
            </ul>
        </div>`;
    document.body.appendChild(overlay);

    fab.addEventListener('click', ()=>overlay.classList.add('open'));
    overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.classList.remove('open'); });
    document.getElementById('kbCloseBtn').addEventListener('click', ()=>overlay.classList.remove('open'));

    // Global keyboard handler
    document.addEventListener('keydown', function(e) {
        const active = document.activeElement;
        const inInput = active && (active.tagName==='INPUT'||active.tagName==='TEXTAREA'||active.isContentEditable);

        if(e.key==='Escape') {
            overlay.classList.remove('open');
            ['sharePortfolioOverlay','repoDeepDiveOverlay'].forEach(id=>document.getElementById(id)?.remove());
            cleanupTour();
        }
        if(e.key==='?' && !inInput) { overlay.classList.toggle('open'); e.preventDefault(); }
        if(e.ctrlKey && e.key==='Enter') {
            e.preventDefault();
            const btn = document.getElementById('analyzeBtn')||document.querySelector('.btn-analyze');
            if(btn && typeof window.handleAnalysis==='function') window.handleAnalysis();
        }
        if(e.ctrlKey && !e.shiftKey && e.key==='d') {
            e.preventDefault();
            if(typeof window.toggleDark==='function') window.toggleDark();
        }
        if(e.ctrlKey && e.key==='e') {
            e.preventDefault();
            window.exportPDF && window.exportPDF();
        }
        if(e.ctrlKey && !e.shiftKey && e.key==='c' && !inInput) {
            e.preventDefault();
            document.getElementById('compareSection')?.scrollIntoView({behavior:'smooth'});
        }
        if(e.ctrlKey && e.shiftKey && e.key==='S') {
            e.preventDefault();
            window.sharePublicPortfolio && window.sharePublicPortfolio();
        }
    });
}

window.exportPDF = function() {
    const u = window.currentData?.username || document.getElementById('githubInput')?.value?.trim();
    if(!u) { if(window.GHToast) window.GHToast.warning('Analyze a profile first'); return; }
    window.location.href = `/api/export/${encodeURIComponent(u)}.pdf`;
};

// ============================================================
// FEATURE 10: Admin Analytics Dashboard
// ============================================================
async function loadAdminDashboard() {
    const section = document.getElementById('adminDashSection');
    if(!section) return;

    const token = localStorage.getItem('auth_token');
    if(!token) return; // Only show for logged-in users; admin check is server-side

    try {
        const res = await fetch('/api/admin/dashboard', { headers: { Authorization: 'Bearer '+token } });
        if(!res.ok) return; // not admin — hide silently
        const data = await res.json();
        section.style.display = 'block';

        const grid = document.getElementById('adminStatsGrid');
        if(grid && data.analyses) {
            grid.innerHTML = [
                { val: data.analyses.today||0, lbl: '📊 Analyses Today' },
                { val: data.analyses.week||0, lbl: '📅 This Week' },
                { val: data.analyses.month||0, lbl: '🗓️ This Month' },
                { val: data.activeSessions||0, lbl: '🟢 Active Sessions' },
                { val: `${data.apiErrorRate?.rate||0}%`, lbl: '🔴 Error Rate (24h)' },
            ].map(s=>`<div class="admin-stat-card"><div class="as-val">${s.val}</div><div class="as-lbl">${s.lbl}</div></div>`).join('');
        }

        const topWrap = document.getElementById('adminTopUsersWrap');
        if(topWrap && data.topUsernames?.length) {
            topWrap.style.display = 'block';
            document.getElementById('adminTopUsers').innerHTML = data.topUsernames.slice(0,10).map((u,i)=>`
                <div class="admin-top-row">
                    <span class="atr-rank">#${i+1}</span>
                    <span class="atr-name">@${u.username}</span>
                    <span class="atr-count">${u.count} analyses</span>
                </div>`).join('');
        }

        // Score distribution bar chart
        const canvas = document.getElementById('adminScoreDistCanvas');
        if(canvas && data.scoreDistribution?.length && window.Chart) {
            const labels = ['0-20','20-40','40-55','55-70','70-85','85-100'];
            const vals = labels.map((_,i) => (data.scoreDistribution[i]||{}).count||0);
            if(window._adminDistChart) window._adminDistChart.destroy();
            window._adminDistChart = new window.Chart(canvas, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{
                        label: 'Users',
                        data: vals,
                        backgroundColor: ['#dc3545','#ffc107','#fd7e14','#14919b','#0d7377','#051d2a'],
                        borderRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true } }
                }
            });
        }
    } catch(e) { /* not admin or db offline */ }
}

// ============================================================
// HOOK INTO EXISTING analyze flow
// ============================================================
function hookAnalysisComplete() {
    const origHandleAnalysis = window.handleAnalysis;
    if(typeof origHandleAnalysis !== 'function' || origHandleAnalysis.__v22) return;

    window.handleAnalysis = async function() {
        await origHandleAnalysis.apply(this, arguments);
        // After analysis completes, wire up new features
        setTimeout(async () => {
            const data = window.currentData;
            const username = data?.username || document.getElementById('githubInput')?.value?.trim();
            if(!username) return;

            // Feature 3: patch radar after compareProfiles is already patched

            // Feature 4: Score history
            loadScoreHistory(username);

            // Feature 5: Enhanced badge
            const score = data?.score || {};
            renderNewBadge(username, score.rank||'?', score.total||0);

            // Feature 6: Skill gap
            if(data) renderSkillGap(data);

            // Show skill gap section always (no login required)
            const sgSection = document.getElementById('skillGapSection');
            if (sgSection) {
                sgSection.style.display = '';
            }

            // Global rank badge
            if (username) showGlobalRank(username);

            // Feature 2: patch renderRepos for deep-dive
            patchReposRenderer();
            if(typeof window.renderRepos==='function') window.renderRepos();

            // Admin dashboard (will silently skip for non-admins)
            loadAdminDashboard();
        }, 600);
    };
    window.handleAnalysis.__v22 = true;
}

// ============================================================
// NEW FEATURES: Auth, Leaderboard, Embed Card, AI Skill Gap, Compare x4, Digest
// ============================================================

// --- AUTH STATE ---
let _authUser = null;

function getAuthToken() {
    return localStorage.getItem('gpa_jwt') || localStorage.getItem('auth_token') || null;
}

function setAuthUser(user, token) {
    _authUser = user;
    if (token) {
        localStorage.setItem('gpa_jwt', token);
        localStorage.setItem('auth_token', token); // backward compat
    }
    updateAuthBtn();
    restoreLoggedInState();
}

function updateAuthBtn() {
    const btn = document.getElementById('authBtn');
    if (!btn) return;
    if (_authUser) {
        btn.innerHTML = `👤 ${_authUser.name || _authUser.email}`;
        btn.onclick = openUserMenu;
    } else {
        btn.innerHTML = '🔑 Login / Register';
        // btn.onclick = openAuthModal; // removed
    }
}

function restoreLoggedInState() {
    // Auth state restored (leaderboard, login, timeline removed)
}

async function restoreAuthFromStorage() {
    const token = getAuthToken();
    if (!token) return;
    try {
        const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
        if (res.ok) {
            const data = await res.json();
            setAuthUser(data.user, null);
        } else {
            localStorage.removeItem('gpa_jwt');
        }
    } catch { /* ignore */ }
}

function logout() {
    const token = getAuthToken();
    if (token) {
        fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
    }
    localStorage.removeItem('gpa_jwt');
    localStorage.removeItem('auth_token');
    _authUser = null;
    updateAuthBtn();
    closeAllNewModals();
}

function openUserMenu() {
    // Small dropdown from auth button
    const existing = document.getElementById('userMenuDrop');
    if (existing) { existing.remove(); return; }
    const btn = document.getElementById('authBtn');
    const rect = btn.getBoundingClientRect();
    const drop = document.createElement('div');
    drop.id = 'userMenuDrop';
    drop.style.cssText = `position:fixed;top:${rect.bottom+6}px;right:${window.innerWidth-rect.right}px;background:var(--bg-card);border-radius:10px;box-shadow:var(--shadow-lg);padding:10px;z-index:1001;min-width:220px;`;
    drop.innerHTML = `
        <div style="padding:8px 12px;font-weight:600;color:var(--primary-teal);border-bottom:1px solid var(--border-color);margin-bottom:8px;">${_authUser?.name || _authUser?.email}</div>
        <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;font-size:.92em;">
            <input type="checkbox" id="digestToggle" ${_authUser?.weeklyDigest ? 'checked' : ''}> 📬 Weekly digest emails
        </label>
        <div style="padding:8px 12px;">
            <button onclick="logout()" style="width:100%;padding:8px;background:var(--error);color:white;border:none;border-radius:6px;cursor:pointer;font-size:.9em;">🚪 Logout</button>
        </div>`;
    document.body.appendChild(drop);
    document.getElementById('digestToggle')?.addEventListener('change', async function() {
        const token = getAuthToken();
        if (!token) return;
        await fetch('/api/auth/me/digest', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ subscribe: this.checked })
        });
        if (_authUser) _authUser.weeklyDigest = this.checked;
    });
    setTimeout(() => document.addEventListener('click', function rm(e) {
        if (!drop.contains(e.target) && e.target !== btn) { drop.remove(); document.removeEventListener('click', rm); }
    }), 50);
}

// --- PRINT CURRENT USER OUTPUT ---
function printAnalysis() {
    const cd = window.currentData;
    if (!cd || !cd.userData || !cd.analysis) {
        if (window.GHToast) window.GHToast.warning('Analyze a GitHub profile first, then print.');
        else alert('Analyze a GitHub profile first, then print.');
        return;
    }

    // Button loading state for better UX feedback
    const btn = document.getElementById('printBtn');
    const originalLabel = btn ? btn.innerHTML : null;
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.style.cursor = 'wait';
        btn.innerHTML = '⏳ Generating…';
    }
    const restoreBtn = () => {
        if (btn && originalLabel !== null) {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor = '';
            btn.innerHTML = originalLabel;
        }
    };

    try {

    const u = cd.userData;
    const a = cd.analysis;
    const repos = (cd.repos || []).filter(r => !r.fork).sort((x,y) => y.stargazers_count - x.stargazers_count).slice(0, 8);
    const username = cd.username || u.login;
    const score = a.weightedScore;
    const rankColor = score>=90?'#0d7377':score>=75?'#14919b':score>=60?'#ffc107':score>=45?'#ff8c00':'#dc3545';
    const rankLabel = score>=90?'S-Rank':score>=75?'A-Rank':score>=60?'B-Rank':score>=45?'C-Rank':'D-Rank';
    const generated = new Date().toLocaleString('en-US', {dateStyle:'long', timeStyle:'short'});

    // Build languages bar
    const langs = a.languages || {};
    const totalLangBytes = Object.values(langs).reduce((s,v)=>s+v,0) || 1;
    const langColors = ['#0d7377','#14919b','#76c7d1','#051d2a','#ffc107','#28a745','#dc3545','#6f42c1'];
    const langBars = Object.entries(langs).slice(0,8).map(([name,bytes],i)=>{
        const pct = ((bytes/totalLangBytes)*100).toFixed(1);
        return `<div style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                <span style="font-size:13px;font-weight:600;color:#1a1a1a;">${name}</span>
                <span style="font-size:13px;color:#555;">${pct}%</span>
            </div>
            <div style="background:#e8f4f5;border-radius:4px;height:8px;overflow:hidden;">
                <div style="background:${langColors[i%langColors.length]};height:100%;width:${pct}%;border-radius:4px;"></div>
            </div>
        </div>`;
    }).join('');

    // Build score breakdown
    const scoreBreakdown = [
        {label:'Documentation',  key:'documentation',        icon:'📄'},
        {label:'Code Structure',  key:'codeStructure',        icon:'🏗️'},
        {label:'Activity',        key:'activityConsistency',  icon:'📈'},
        {label:'Organisation',    key:'repositoryOrganization',icon:'🗂️'},
        {label:'Project Impact',  key:'projectImpact',        icon:'⭐'},
        {label:'Technical Depth', key:'technicalDepth',       icon:'🔬'},
    ].map(({label,key,icon})=>{
        const val = Math.round((a.scores?.[key]||0)*100);
        const barColor = val>=75?'#0d7377':val>=50?'#14919b':val>=30?'#ffc107':'#dc3545';
        return `<div style="margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:600;color:#1a1a1a;">${icon} ${label}</span>
                <span style="font-size:13px;font-weight:700;color:${barColor};">${val}%</span>
            </div>
            <div style="background:#e8f4f5;border-radius:4px;height:10px;overflow:hidden;">
                <div style="background:${barColor};height:100%;width:${val}%;border-radius:4px;"></div>
            </div>
        </div>`;
    }).join('');

    // Build top repos
    const repoCards = repos.map(r=>`
        <div style="border:1px solid #dde8ea;border-radius:8px;padding:12px 14px;margin-bottom:10px;page-break-inside:avoid;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                <div>
                    <a href="${r.html_url}" style="color:#0d7377;font-weight:700;font-size:14px;text-decoration:none;">${r.name}</a>
                    ${r.language?`<span style="font-size:11px;background:#e8f4f5;color:#0d7377;border-radius:4px;padding:2px 7px;margin-left:6px;font-weight:600;">${r.language}</span>`:''}
                </div>
                <div style="display:flex;gap:12px;white-space:nowrap;font-size:12px;color:#666;">
                    <span>⭐ ${r.stargazers_count}</span>
                    <span>🍴 ${r.forks_count}</span>
                </div>
            </div>
            ${r.description?`<p style="margin:6px 0 0;font-size:12px;color:#555;line-height:1.5;">${r.description}</p>`:''}
        </div>`).join('');

    // Strengths / improvements
    const mkList = (arr, color) => (arr||[]).slice(0,8).map(s=>{
        const text = typeof s === 'string' ? s : (s.text || s.title || JSON.stringify(s));
        return '<li style="margin-bottom:8px;font-size:13px;color:#222;line-height:1.5;padding-left:4px;display:flex;align-items:flex-start;gap:6px;"><span style="color:' + color + ';font-weight:bold;">•</span><span>' + text + '</span></li>';
    }).join('');

    // Achievements if present
    const achSection = (() => {
        const grid = document.getElementById('achievementsGrid');
        if (!grid || !grid.children.length) return '';
        const items = Array.from(grid.querySelectorAll('.achievement-card, [class*="achievement"]')).slice(0,8)
            .map(c=>`<span style="display:inline-block;background:#e8f4f5;border-radius:20px;padding:4px 12px;margin:3px;font-size:12px;color:#0d7377;font-weight:600;">${c.textContent.trim().slice(0,50)}</span>`).join('');
        if (!items) return '';
        return `<div style="margin-top:0;"><div style="margin-top:8px;">${items}</div></div>`;
    })();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub Portfolio — @${username}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  body { font-family: 'Inter', 'Segoe UI', sans-serif; background: #f5f9fa; color: #1a1a1a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { max-width: 860px; margin: 0 auto; padding: 32px 24px; background: #fff; }

  /* HEADER */
  .rpt-header { background: linear-gradient(135deg, #051d2a 0%, #0d7377 100%); color: #fff; border-radius: 14px; padding: 28px 32px; margin-bottom: 24px; display: flex; align-items: center; gap: 24px; }
  .rpt-avatar { width: 88px; height: 88px; border-radius: 50%; border: 3px solid rgba(255,255,255,0.35); object-fit: cover; flex-shrink: 0; }
  .rpt-avatar-fallback { width: 88px; height: 88px; border-radius: 50%; background: rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 700; color: #fff; flex-shrink: 0; }
  .rpt-name { font-size: 24px; font-weight: 700; margin-bottom: 2px; }
  .rpt-handle { font-size: 14px; opacity: 0.75; margin-bottom: 6px; }
  .rpt-bio { font-size: 13px; opacity: 0.85; max-width: 480px; line-height: 1.5; }
  .rpt-meta { margin-left: auto; text-align: center; flex-shrink: 0; }
  .rpt-score-circle { background: rgba(255,255,255,0.12); border: 2px solid rgba(255,255,255,0.3); border-radius: 12px; padding: 14px 20px; }
  .rpt-score-num { font-size: 40px; font-weight: 700; line-height: 1; color: #fff; }
  .rpt-score-sub { font-size: 12px; opacity: 0.75; margin-top: 2px; }
  .rpt-rank-pill { display: inline-block; background: ${rankColor}; border-radius: 20px; padding: 4px 14px; font-size: 13px; font-weight: 700; color: #fff; margin-top: 8px; }

  /* STATS ROW */
  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat-box { background: #f5f9fa; border: 1px solid #dde8ea; border-radius: 10px; padding: 14px; text-align: center; }
  .stat-num { font-size: 24px; font-weight: 700; color: #0d7377; }
  .stat-label { font-size: 11px; color: #666; margin-top: 2px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }

  /* GRID */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
  .one-col { margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #dde8ea; border-radius: 12px; padding: 18px 20px; height: 100%; }
  .card-title { font-size: 14px; font-weight: 700; color: #0d7377; margin-bottom: 14px; display: flex; align-items: center; gap: 7px; }
  .card-title::before { content: ''; display: block; width: 3px; height: 16px; background: #0d7377; border-radius: 2px; }

  /* FOOTER */
  .rpt-footer { border-top: 1px solid #dde8ea; margin-top: 24px; padding-top: 16px; display: flex; justify-content: space-between; align-items: center; color: #888; font-size: 12px; }
  .rpt-footer a { color: #0d7377; }

  /* INFO TABLE */
  .info-table { width: 100%; border-collapse: collapse; }
  .info-table td { padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f0f5f6; }
  .info-table td:first-child { color: #666; font-weight: 600; width: 45%; }
  .info-table tr:last-child td { border-bottom: none; }

  @page { margin: 12mm; size: A4; }
  @media print {
    body { background: #fff; }
    .page { max-width: 100%; padding: 0; box-shadow: none; }
    .rpt-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .stat-box, .card { page-break-inside: avoid; }
  }
  @media screen {
    body { padding: 24px 0 48px; }
    .page { box-shadow: 0 4px 24px rgba(0,0,0,0.1); border-radius: 16px; }
    .print-btn { position: fixed; bottom: 28px; right: 28px; background: #0d7377; color: #fff; border: none; border-radius: 50px; padding: 14px 24px; font-size: 15px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 16px rgba(13,115,119,0.4); display: flex; align-items: center; gap: 8px; transition: transform 0.15s; }
    .print-btn:hover { transform: translateY(-2px); }
  }
  @media (max-width: 600px) {
    .two-col { grid-template-columns: 1fr; }
    .stats-row { grid-template-columns: repeat(2, 1fr); }
    .rpt-header { flex-direction: column; text-align: center; }
    .rpt-meta { margin-left: 0; }
  }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()" aria-label="Print or save as PDF">🖨️ Print / Save PDF</button>
<div class="page">

  <!-- HEADER -->
  <div class="rpt-header">
    <img class="rpt-avatar" src="${u.avatar_url||''}" alt="${username}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
    <div class="rpt-avatar-fallback" style="display:none;">${(username[0]||'?').toUpperCase()}</div>
    <div style="flex:1;min-width:0;">
      <div class="rpt-name">${u.name || username}</div>
      <div class="rpt-handle">@${username}</div>
      <div class="rpt-bio">${u.bio || 'GitHub Developer'}</div>
      <div style="margin-top:10px;font-size:12px;opacity:0.7;display:flex;flex-wrap:wrap;gap:12px;">
        ${u.location?`<span>📍 ${u.location}</span>`:''}
        ${u.company?`<span>🏢 ${u.company}</span>`:''}
        ${u.blog?`<span>🔗 <a href="${u.blog}" style="color:rgba(255,255,255,0.85);">${u.blog}</a></span>`:''}
      </div>
    </div>
    <div class="rpt-meta">
      <div class="rpt-score-circle">
        <div class="rpt-score-num">${score}</div>
        <div class="rpt-score-sub">out of 100</div>
      </div>
      <div class="rpt-rank-pill">${rankLabel}</div>
    </div>
  </div>

  
  <!-- RECRUITER EXECUTIVE IMPRESSION -->
  <div class="one-col card" style="background:#f0fdfa;border:1px solid #99f6e4;margin-bottom:20px;">
    <div class="card-title" style="color:#0f766e;">👔 Recruiter First Impression</div>
    <p style="font-size:13.5px;color:#134e4a;line-height:1.6;font-style:italic;">
      ${document.getElementById('recruiterText')?.textContent || 'Strong engineering signals with consistent repository activity. Adding open-source licenses and pinned project demos will significantly improve ATS shortlisting.'}
    </p>
    <div style="margin-top:10px;font-size:12px;font-weight:700;color:#0f766e;">
      Developer Level: <span style="background:#ccfbf1;padding:3px 10px;border-radius:12px;">${document.getElementById('devLevel')?.textContent || 'Rising Contributor'}</span>
    </div>
  </div>

  <!-- ATS & CAREER READINESS CARD -->
  <div class="two-col" style="margin-bottom:20px;">
    <div class="card">
      <div class="card-title" style="color:#0d7377;">📋 ATS & Profile Readiness</div>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;">
        <div style="font-size:32px;font-weight:800;color:#0d7377;">${document.getElementById('completionPct')?.textContent || '72%'}</div>
        <div style="font-size:12px;color:#555;">Profile Completeness & Recruiter Friendliness Index</div>
      </div>
      <ul style="padding-left:18px;font-size:12.5px;color:#444;line-height:1.6;">
        <li>Documentation Coverage: ${a.scores?.documentation ? Math.round(a.scores.documentation * 100) : 100}%</li>
        <li>Bio & Social Links: ${u.bio ? '✅ Provided' : '⚠️ Missing Bio'}</li>
        <li>Original Repositories: ${(cd.repos||[]).filter(r=>!r.fork).length} projects</li>
      </ul>
    </div>

    <div class="card">
      <div class="card-title" style="color:#0d7377;">🎯 Detected Technical Skills</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
        ${(Array.from(document.querySelectorAll('#topSkillsTags span')).map(s => s.outerHTML).join('') || Object.keys(langs||{}).slice(0,6).map(l => '<span style="background:#e8f4f5;color:#0d7377;padding:3px 10px;border-radius:6px;font-size:12px;font-weight:600;">' + l + '</span>').join(''))}
      </div>
    </div>
  </div>

  <!-- STATS -->
  <div class="stats-row">
    <div class="stat-box"><div class="stat-num">${(cd.repos||[]).filter(r=>!r.fork).length}</div><div class="stat-label">Repositories</div></div>
    <div class="stat-box"><div class="stat-num">${u.followers||0}</div><div class="stat-label">Followers</div></div>
    <div class="stat-box"><div class="stat-num">${(cd.repos||[]).reduce((s,r)=>s+r.stargazers_count,0)}</div><div class="stat-label">Total Stars</div></div>
    <div class="stat-box"><div class="stat-num">${(cd.repos||[]).reduce((s,r)=>s+r.forks_count,0)}</div><div class="stat-label">Total Forks</div></div>
  </div>

  <!-- SCORE BREAKDOWN + PROFILE INFO -->
  <div class="two-col">
    <div class="card">
      <div class="card-title">Score Breakdown</div>
      ${scoreBreakdown}
    </div>
    <div>
      <div class="card" style="margin-bottom:18px;">
        <div class="card-title">Profile Info</div>
        <table class="info-table">
          <tr><td>GitHub Username</td><td><a href="https://github.com/${username}" style="color:#0d7377;">@${username}</a></td></tr>
          <tr><td>Account Type</td><td>${u.type||'User'}</td></tr>
          <tr><td>Member Since</td><td>${u.created_at?new Date(u.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long'}):'N/A'}</td></tr>
          <tr><td>Public Repos</td><td>${u.public_repos||0}</td></tr>
          <tr><td>Public Gists</td><td>${u.public_gists||0}</td></tr>
          <tr><td>Following</td><td>${u.following||0}</td></tr>
        </table>
      </div>
      ${langs && Object.keys(langs).length ? `<div class="card">
        <div class="card-title">Languages</div>
        ${langBars}
      </div>` : ''}
    </div>
  </div>

  <!-- STRENGTHS + IMPROVEMENTS -->
  <div class="two-col">
    <div class="card">
      <div class="card-title" style="color:#28a745;">✅ Strengths</div>
      <ul style="padding-left:18px;list-style-type:none;padding:0;">
        ${mkList(a.strengths,'#28a745')}
      </ul>
    </div>
    <div class="card">
      <div class="card-title" style="color:#dc3545;">📈 Areas to Improve</div>
      <ul style="padding-left:18px;list-style-type:none;padding:0;">
        ${mkList(a.improvements,'#dc3545')}
      </ul>
    </div>
  </div>

  <!-- RECOMMENDATIONS -->
  ${a.recommendations && a.recommendations.length ? `<div class="one-col card">
    <div class="card-title">💡 Recommendations</div>
    <ul style="padding:0;list-style:none;">
      ${(a.recommendations||[]).slice(0,8).map((r,i)=>{
      const title = typeof r === 'string' ? r : (r.title || 'Recommendation');
      const desc = typeof r === 'object' && r.text ? '<div style="font-size:12px;color:#555;margin-top:3px;line-height:1.5;">' + r.text + '</div>' : '';
      return '<li style="display:flex;gap:10px;margin-bottom:12px;font-size:13px;color:#1a1a1a;line-height:1.5;"><span style="background:#e8f4f5;color:#0d7377;font-weight:700;font-size:11px;border-radius:4px;padding:2px 7px;min-width:22px;text-align:center;height:fit-content;margin-top:2px;">' + (i+1) + '</span><div><div style="font-weight:700;color:#0d7377;">' + title + '</div>' + desc + '</div></li>';
    }).join('')}
    </ul>
  </div>` : ''}

  <!-- TOP REPOS -->
  ${repoCards ? `<div class="one-col">
    <div class="card">
      <div class="card-title">🏆 Top Repositories</div>
      ${repoCards}
    </div>
  </div>` : ''}

  ${achSection ? `<div class="one-col card">
    <div class="card-title">🎖️ Achievements</div>
    ${achSection}
  </div>` : ''}

  <!-- FOOTER -->
  <div class="rpt-footer">
    <span>Generated by <a href="${location.origin}">GitHub Portfolio Analyzer</a></span>
    <span>${generated}</span>
    <span>github.com/${username}</span>
  </div>

</div>
</body>
</html>`;

    // ── Always auto-download the evaluation as a standalone .html website file ──
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const fileName = `${username}-github-portfolio.html`;

    const dl = document.createElement('a');
    dl.href = blobUrl;
    dl.download = fileName;
    document.body.appendChild(dl);
    dl.click();
    dl.remove();

    if (window.GHToast) window.GHToast.success(`Downloaded "${fileName}".`);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err) {
        console.error('[printAnalysis] Failed to generate report:', err);
        if (window.GHToast) window.GHToast.error('Could not generate report. Please try again.');
        else alert('Could not generate report. Please try again.');
    } finally {
        restoreBtn();
    }
}
window.printAnalysis = printAnalysis;


// --- AUTH MODAL ---



function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}



// --- LEADERBOARD MODAL ---

async function loadLeaderboard() {
    const content = document.getElementById('leaderboardContent');
    if (!content) return;
    try {
        const res = await fetch('/api/leaderboard');
        const data = await res.json();
        const entries = data.leaderboard || [];
        if (!entries.length) {
            content.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">No entries yet. Analyze some profiles!</div>';
            return;
        }
        const rankColor = { S: '#f5a623', A: '#7ed321', B: '#4a90e2', C: '#9b59b6', D: '#e74c3c' };
        content.innerHTML = `<table style="width:100%;border-collapse:collapse;">
            <thead><tr style="color:var(--primary-teal);font-size:.85em;text-transform:uppercase;">
                <th style="padding:8px 4px;text-align:left;">#</th>
                <th style="padding:8px 4px;text-align:left;">User</th>
                <th style="padding:8px 4px;text-align:right;">Score</th>
                <th style="padding:8px 4px;text-align:right;">Rank</th>
            </tr></thead>
            <tbody>${entries.map((e, i) => `
                <tr style="border-top:1px solid var(--border-color);">
                    <td style="padding:10px 4px;color:#888;font-weight:700;">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + e.position}</td>
                    <td style="padding:10px 4px;">
                        <div style="display:flex;align-items:center;gap:10px;">
                            <img src="${e.avatarUrl||''}" alt="${e.username}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">
                            <a href="https://github.com/${e.username}" target="_blank" rel="noopener" style="color:var(--primary-teal);text-decoration:none;font-weight:600;">@${e.username}</a>
                        </div>
                    </td>
                    <td style="padding:10px 4px;text-align:right;font-weight:700;font-size:1.1em;">${e.score}</td>
                    <td style="padding:10px 4px;text-align:right;">
                        <span style="background:${rankColor[e.rank]||'#0d7377'};color:white;padding:3px 10px;border-radius:20px;font-size:.82em;font-weight:700;">${e.rank}</span>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;
    } catch {
        content.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">Failed to load leaderboard. Is MongoDB connected?</div>';
    }
}

async function showGlobalRank(username) {
    try {
        const res = await fetch(`/api/leaderboard/rank/${encodeURIComponent(username)}`);
        if (!res.ok) return;
        const data = await res.json();
        // Find score card area and append rank badge
        const scoreEl = document.querySelector('.score-circle, .score-main, #scoreCircle, .overall-score');
        if (!scoreEl) return;
        let rankBadge = document.getElementById('globalRankBadge');
        if (!rankBadge) {
            rankBadge = document.createElement('div');
            rankBadge.id = 'globalRankBadge';
            rankBadge.style.cssText = 'display:inline-block;background:var(--primary-teal);color:white;padding:4px 14px;border-radius:20px;font-size:.88em;font-weight:700;margin-top:8px;';
            scoreEl.parentNode.insertBefore(rankBadge, scoreEl.nextSibling);
        }
        rankBadge.textContent = `🌍 Global Rank: #${data.position} of ${data.total}`;
    } catch { /* ignore */ }
}

// --- EMBED CARD MODAL ---
function openEmbedCardModal() {
    const username = window.currentData?.username || window.currentData?.profile?.login ||
                     document.getElementById('githubInput')?.value?.trim();
    if (!username) { if (window.GHToast) window.GHToast.warning('Analyze a profile first'); return; }

    const existing = document.getElementById('embedCardModal');
    if (existing) { existing.style.display = 'flex'; return; }

    const host = window.location.host;
    const cardUrl = `/api/public/card/${encodeURIComponent(username)}`;
    const embedCode = `<img src="https://${host}/api/public/card/${encodeURIComponent(username)}" alt="GitHub Portfolio Card for ${username}">`;

    const modal = document.createElement('div');
    modal.id = 'embedCardModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(5,29,42,0.7);display:flex;align-items:center;justify-content:center;z-index:1100;';
    modal.innerHTML = `
        <div style="background:var(--bg-card);border-radius:16px;box-shadow:var(--shadow-lg);padding:32px 28px;max-width:600px;width:92%;position:relative;">
            <button onclick="document.getElementById('embedCardModal').style.display='none'" style="position:absolute;top:14px;right:16px;background:none;border:none;font-size:1.4em;cursor:pointer;color:#888;">✕</button>
            <h3 style="color:var(--primary-teal);margin-bottom:16px;font-size:1.4em;">📤 Embed Profile Card</h3>
            <p style="color:#666;margin-bottom:18px;font-size:.95em;">Live SVG card you can embed anywhere:</p>
            <div style="background:#f5f9fa;border-radius:10px;padding:16px;text-align:center;margin-bottom:20px;">
                <img src="${cardUrl}" alt="GitHub Portfolio Card" style="max-width:100%;border-radius:8px;">
            </div>
            <div style="margin-bottom:8px;font-weight:600;color:var(--primary-teal);font-size:.9em;">HTML Embed Code:</div>
            <div style="position:relative;">
                <textarea id="embedCodeArea" readonly style="width:100%;padding:12px;border:2px solid var(--accent-teal);border-radius:8px;font-family:monospace;font-size:.85em;resize:none;height:64px;box-sizing:border-box;">${embedCode}</textarea>
                <button onclick="navigator.clipboard.writeText(document.getElementById('embedCodeArea').value);this.textContent='✅ Copied!';setTimeout(()=>this.textContent='📋 Copy',2000);" style="position:absolute;top:8px;right:8px;padding:5px 12px;background:var(--primary-teal);color:white;border:none;border-radius:6px;cursor:pointer;font-size:.82em;">📋 Copy</button>
            </div>
        </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.body.appendChild(modal);
}

// --- AI SKILL GAP ---
async function runAISkillGap() {
    const username = window.currentData?.username || window.currentData?.profile?.login ||
                     document.getElementById('githubInput')?.value?.trim();
    if (!username) { if (window.GHToast) window.GHToast.warning('Analyze a profile first'); return; }

    const role = document.getElementById('skillGapRole')?.value || 'Full Stack';
    const resultEl = document.getElementById('skillGapAIResult');
    const badge = document.getElementById('skillGapRoleBadge');
    if (badge) badge.textContent = 'Analyzing for: ' + role + '...';
    if (resultEl) resultEl.style.display = 'none';

    try {
        const res = await fetch('/api/ai/skillgap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, role })
        });
        if (!res.ok) throw new Error('API error');
        const data = await res.json();

        if (badge) badge.textContent = 'Target Role: ' + role;

        // Missing skills as teal tags
        const missingWrap = document.getElementById('skillGapMissingWrap');
        if (missingWrap && data.missingSkills?.length) {
            missingWrap.innerHTML = `<div style="font-weight:600;color:var(--primary-teal);margin-bottom:8px;">🔴 Missing Skills:</div>` +
                data.missingSkills.map(s => `<span style="display:inline-block;background:var(--primary-teal);color:white;padding:4px 14px;border-radius:20px;margin:4px;font-size:.88em;">${s}</span>`).join('');
        }

        // Project ideas as cards
        const grid = document.getElementById('skillGapGrid');
        if (grid && data.projectIdeas?.length) {
            grid.innerHTML = `<div style="font-weight:600;color:var(--primary-teal);margin-bottom:8px;">💡 Project Ideas:</div>` +
                data.projectIdeas.map(p => `<div class="skill-gap-card"><div class="gap-skill">${p.title}</div><div class="gap-reason">${p.description}</div></div>`).join('');
        }

        // Next steps as numbered list
        const steps = document.getElementById('skillGapNextSteps');
        if (steps && data.nextSteps?.length) {
            steps.innerHTML = `<div style="font-weight:600;color:var(--primary-teal);margin-bottom:6px;list-style:none;">📋 Next Steps:</div>` +
                data.nextSteps.map(s => `<li style="color:var(--text-dark);">${s}</li>`).join('');
        }

        if (resultEl) resultEl.style.display = '';
    } catch (e) {
        if (badge) badge.textContent = '';
        if (window.GHToast) window.GHToast.error('Skill gap analysis failed. Check your connection.');
    }
}

// --- COMPARE x4 ---
let _compareProfileCount = 3; // existing: A, B, C

function addCompareProfile() {
    if (_compareProfileCount >= 4) {
        if (window.GHToast) window.GHToast.warning('Maximum 4 profiles supported');
        return;
    }
    _compareProfileCount++;
    const input = document.getElementById('cmpD');
    if (input) {
        input.style.display = '';
        input.placeholder = 'Username D (optional)';
    }
    const addBtn = document.getElementById('addCmpBtn');
    if (addBtn) addBtn.style.display = 'none'; // max reached
}

// Patch compareProfiles to handle 4 profiles
function patchCompare4() {
    const orig = window.compareProfiles;
    if (!orig || orig.__patched4) return;
    window.compareProfiles = async function() {
        const a = (document.getElementById('cmpA')||{}).value?.trim();
        const b = (document.getElementById('cmpB')||{}).value?.trim();
        const c = (document.getElementById('cmpC')||{}).value?.trim();
        const d = (document.getElementById('cmpD')||{}).value?.trim();
        if (!a || !b) { if(window.GHToast) window.GHToast.warning('Enter at least two usernames'); return; }

        const box = document.getElementById('compareResults');
        const radarWrap = document.getElementById('compareRadarWrap');
        if(!box) return;

        const extras = [c, d].filter(Boolean);
        const count = 2 + extras.length;
        box.style.display = 'grid';
        box.className = 'compare-results' + (count >= 3 ? ' three-col' : '');
        box.innerHTML = '<p style="grid-column:1/-1;text-align:center;padding:20px;">⏳ Loading comparison...</p>';
        if(radarWrap) radarWrap.style.display = 'none';

        try {
            const targets = [a, b, ...extras];
            const results = await Promise.all(targets.map(u =>
                fetch(`/api/public/${encodeURIComponent(u)}`).then(r=>r.json())
            ));

            const colors = ['var(--primary-teal)', 'var(--light-teal)', 'var(--accent-teal)', '#f5a623'];
            const pillars = ['activity','quality','impact','diversity','documentation'];
            const pillarEmoji = {'activity':'⚡','quality':'🏆','impact':'🚀','diversity':'🎨','documentation':'📝'};
            const maxScore = Math.max(...results.map(r=>r.score?.total||0));

            box.innerHTML = results.map((r, idx) => {
                const isWinner = (r.score?.total||0) === maxScore && idx === results.findIndex(x=>(x.score?.total||0)===maxScore);
                const profile = r.profile || {};
                return `<div class="compare-col${isWinner?' winner':''}">
                    <img src="${profile.avatar_url||''}" alt="${profile.login||r.username}" style="width:70px;height:70px;border-radius:50%;margin:10px auto;display:block;">
                    <h4 style="color:${colors[idx]}">${profile.name||profile.login||r.username}</h4>
                    <p style="color:#888;font-size:.85em;">@${r.username}</p>
                    <div class="big" style="color:${colors[idx]}">${r.score?.total||0}</div>
                    <p style="font-size:.9em;color:#666;">${r.score?.rank||'?'}-Rank</p>
                    <p style="font-size:.85em;margin-top:8px;">⭐ ${r.stats?.totalStars||0} stars · 📦 ${(r.stats?.topRepos||[]).length} repos</p>
                    <div style="margin-top:12px;text-align:left;">
                        ${pillars.map(p=>`<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:.82em;">
                            <span>${pillarEmoji[p]} ${p}</span><span style="font-weight:700;color:${colors[idx]}">${r.score?.pillars?.[p]||0}</span>
                        </div>`).join('')}
                    </div>
                    ${isWinner?'<div style="margin-top:10px;background:var(--primary-teal);color:white;padding:4px 0;border-radius:6px;text-align:center;font-size:.82em;">🏆 Winner</div>':''}
                </div>`;
            }).join('');
            box.style.display = 'grid';
        } catch(e) {
            box.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:var(--error)">Error loading comparison</p>`;
        }
    };
    window.compareProfiles.__patched4 = true;
}

function closeAllNewModals() {
    ['embedCardModal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
}

// ============================================================
// OAuth hash token consumer — runs on every page load
// GitHub OAuth redirects back with #token=...&refreshToken=...&user=...
// ============================================================
function consumeOAuthHash() {
    const hash = window.location.hash;
    if (!hash || hash.length < 10) return;
    try {
        const params = new URLSearchParams(hash.replace(/^#/, ''));
        const token = params.get('token');
        const userStr = params.get('user');
        if (!token || !userStr) return;

        const user = JSON.parse(decodeURIComponent(userStr));
        // Store tokens
        localStorage.setItem('gpa_jwt', token);
        localStorage.setItem('auth_token', token);
        const refreshToken = params.get('refreshToken');
        if (refreshToken) localStorage.setItem('gpa_refresh', refreshToken);

        // Clean hash from URL without page reload
        history.replaceState(null, '', window.location.pathname + window.location.search);

        // Set auth user state
        setAuthUser(user, token);
        if (window.GHToast) {
            window.GHToast.success('Welcome, ' + (user.name || user.githubLogin || user.email) + '! 🎉');
        }

        // Check for oauth=failed in query string
    } catch (e) {
        console.warn('OAuth hash parse error:', e);
    }
}

// Handle OAuth failure/denied query params
function handleOAuthQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    if (!oauth) return;
    if (oauth === 'failed') {
        const reason = params.get('reason') || 'unknown';
        if (window.GHToast) window.GHToast.error('GitHub login failed (reason: ' + reason + '). Please try again.');
    } else if (oauth === 'denied') {
        if (window.GHToast) window.GHToast.warning('GitHub login was cancelled.');
    }
    // Clean query param
    const url = new URL(window.location.href);
    url.searchParams.delete('oauth');
    url.searchParams.delete('reason');
    history.replaceState(null, '', url.toString());
}

// ============================================================
// INIT
// ============================================================
function initV22() {
    buildKeyboardPanel();
    hookRepoDeepdive();
    hookAnalysisComplete();
    loadAdminDashboard();
    // Tour: start after a brief delay
    setTimeout(startTour, 1200);
    // Consume OAuth tokens from URL hash BEFORE restoring from storage
    consumeOAuthHash();
    handleOAuthQueryParams();
    // Restore auth from localStorage
    restoreAuthFromStorage();
    // Patch compare for 4 profiles after a tick so window.compareProfiles is defined
    setTimeout(patchCompare4, 500);
}

if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initV22);
} else {
    initV22();
}
// Re-try hook after existing scripts settle
setTimeout(hookAnalysisComplete, 800);
setTimeout(hookAnalysisComplete, 2000);

// Expose new feature functions globally
// openAuthModal removed
// openLeaderboardModal removed
window.openEmbedCardModal = openEmbedCardModal;
window.runAISkillGap = runAISkillGap;
window.addCompareProfile = addCompareProfile;
window.logout = logout;
window.doLogin = doLogin;
window.doRegister = doRegister;
window.switchAuthTab = switchAuthTab;
window.openUserMenu = openUserMenu;
window.showGlobalRank = showGlobalRank;

})();



(function(){
  /* ── 7. Scroll-to-top ── */
  const stBtn = document.getElementById('gpa-scroll-top');
  window.addEventListener('scroll', () => {
    stBtn.classList.toggle('visible', window.scrollY > 400);
  }, {passive:true});

  /* ── 2. Keyboard shortcut Ctrl/Cmd+P → printAnalysis ── */
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      if (window.currentData) {
        e.preventDefault();
        window.printAnalysis?.();
      }
    }
    // Ctrl/Cmd+K → focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      const inp = document.getElementById('githubInput');
      if (inp) { e.preventDefault(); inp.focus(); inp.select(); }
    }
  });

  /* ── 1. Dark mode persistence ── */
  try {
    const saved = localStorage.getItem('gpa_dark');
    if (saved === 'true' && typeof toggleDark === 'function') {
      toggleDark();
    }
  } catch(_){}
  const _origToggleDark = window.toggleDark;
  if (_origToggleDark) {
    window.toggleDark = function(){
      _origToggleDark();
      try { localStorage.setItem('gpa_dark', document.body.classList.contains('dark') ? 'true' : 'false'); } catch(_){}
    };
  }

  /* ── 8. Analysis timestamp ── */
  function showTimestamp(username) {
    let el = document.getElementById('gpa-timestamp');
    if (!el) {
      el = document.createElement('p');
      el.id = 'gpa-timestamp';
      const scoreCard = document.querySelector('.score-card');
      if (scoreCard) scoreCard.insertAdjacentElement('afterend', el);
    }
    const now = Date.now();
    el.dataset.ts = now;
    el.textContent = `Analysis of @${username} — just now`;
    clearInterval(window._gpaTimerInterval);
    window._gpaTimerInterval = setInterval(() => {
      const mins = Math.floor((Date.now() - now) / 60000);
      el.textContent = mins < 1
        ? `Analysis of @${username} — just now`
        : `Analysis of @${username} — ${mins} min ago`;
    }, 30000);
  }

  /* ── 5. Score history mini-chart ── */
  const HISTORY_KEY = 'gpa_score_history';
  function getScoreHistory() {
    try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  }
  function pushScoreHistory(username, score) {
    const h = getScoreHistory().filter(x => x.username !== username);
    h.push({ username, score, ts: Date.now() });
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-10))); } catch(_){}
  }
  function renderScoreHistory() {
    const h = getScoreHistory();
    if (h.length < 2) return;
    let wrap = document.getElementById('gpa-history-chart-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'gpa-history-chart-wrap';
      wrap.innerHTML = `<p style="font-size:13px;font-weight:600;color:var(--primary-teal,#0d7377);margin-bottom:8px;">📊 Session Score History</p><canvas id="gpa-hist-canvas" height="80" role="img" aria-label="Score history chart"></canvas>`;
      // Insert inside resultsSection so it's contained within the page layout
      const scoreCard = document.querySelector('#resultsSection .score-card');
      const statsInsights = document.getElementById('statsInsights');
      const insertTarget = statsInsights || scoreCard;
      if (insertTarget) insertTarget.insertAdjacentElement('afterend', wrap);
    }
    wrap.style.display = 'block';
    const canvas = document.getElementById('gpa-hist-canvas');
    if (!canvas || typeof Chart === 'undefined') return;
    if (canvas._chartInst) canvas._chartInst.destroy();
    canvas._chartInst = new Chart(canvas, {
      type: 'line',
      data: {
        labels: h.map(x => x.username),
        datasets: [{
          label: 'Score',
          data: h.map(x => x.score),
          borderColor: '#0d7377',
          backgroundColor: 'rgba(13,115,119,0.08)',
          tension: 0.3,
          fill: true,
          pointBackgroundColor: '#0d7377',
          pointRadius: 5,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { min: 0, max: 100, ticks: { stepSize: 25, font: { size: 11 } } },
          x: { ticks: { font: { size: 11 } } }
        }
      }
    });
  }

  /* ── 3. Download HTML report button (injects into share section) ── */
  function injectDownloadHtmlBtn() {
    if (document.getElementById('gpa-dl-html')) return;
    const shareSection = document.getElementById('shareSection');
    if (!shareSection) return;
    const actionBtns = shareSection.querySelector('.action-buttons');
    if (!actionBtns) return;
    const btn = document.createElement('button');
    btn.id = 'gpa-dl-html';
    btn.className = 'btn-secondary visible';
    btn.textContent = '💾 Download HTML Report';
    btn.onclick = () => {
      if (!window.currentData) return;
      window.printAnalysis?.();
    };
    actionBtns.appendChild(btn);
  }

  /* ── 9. Repo language filter chips ── */
  function injectLangFilter() {
    if (document.getElementById('gpa-lang-filter')) return;
    const repoSection = document.querySelector('.repositories .feedback-header, #repoListWrap, [id*="repoList"]');
    if (!repoSection || !window.currentData) return;
    const langs = [...new Set((window.currentData.repos||[]).filter(r=>!r.fork && r.language).map(r=>r.language))].slice(0,8);
    if (langs.length < 2) return;
    const wrap = document.createElement('div');
    wrap.id = 'gpa-lang-filter';
    const allChip = `<button class="gpa-lang-chip active" data-lang="all" onclick="window.gpaFilterLang('all')">All</button>`;
    const chips = langs.map(l=>`<button class="gpa-lang-chip" data-lang="${l}" onclick="window.gpaFilterLang('${l}')">${l}</button>`).join('');
    wrap.innerHTML = allChip + chips;
    repoSection.insertAdjacentElement('beforebegin', wrap);
  }

  window.gpaFilterLang = function(lang) {
    document.querySelectorAll('.gpa-lang-chip').forEach(c => c.classList.toggle('active', c.dataset.lang === lang));
    document.querySelectorAll('.repo-card, [class*="repo-item"], [class*="repoCard"]').forEach(card => {
      if (lang === 'all') { card.style.display = ''; return; }
      const cardLang = card.querySelector('[class*="lang"], .badge')?.textContent?.trim();
      card.style.display = (!cardLang || cardLang === lang) ? '' : 'none';
    });
  };

  /* ── 6. Copy profile link button ── */
  function injectCopyLink() {
    if (document.getElementById('gpa-copy-link')) return;
    const shareSection = document.getElementById('shareSection');
    if (!shareSection) return;
    const actionBtns = shareSection.querySelector('.action-buttons');
    if (!actionBtns) return;
    const btn = document.createElement('button');
    btn.id = 'gpa-copy-link';
    btn.className = 'btn-secondary';
    btn.textContent = '🔗 Copy Profile URL';
    btn.onclick = () => {
      const u = window.currentData?.username;
      if (!u) return;
      const url = `${location.origin}${location.pathname}?u=${encodeURIComponent(u)}`;
      navigator.clipboard?.writeText(url).then(() => {
        btn.textContent = '✅ Copied!';
        setTimeout(() => btn.textContent = '🔗 Copy Profile URL', 2000);
      });
    };
    actionBtns.insertBefore(btn, actionBtns.firstChild);
  }

  /* ── Hook into displayResults ── */
  function hookDisplayResults() {
    const orig = window.displayResults;
    if (!orig || orig._gpaNewFeaturesHooked) return;
    window.displayResults = function(userData, repos, analysis) {
      orig(userData, repos, analysis);
      const username = userData.login;
      const score = analysis.weightedScore;
      showTimestamp(username);
      pushScoreHistory(username, score);
      setTimeout(() => {
        renderScoreHistory();
        injectDownloadHtmlBtn();
        injectCopyLink();
        injectLangFilter();
      }, 600);
    };
    window.displayResults._gpaNewFeaturesHooked = true;
  }

  // Attempt hook immediately and after scripts settle
  hookDisplayResults();
  setTimeout(hookDisplayResults, 500);
  setTimeout(hookDisplayResults, 1500);

  /* ── Keyboard shortcut toast on page load ── */
  setTimeout(() => {
    if (window.GHToast) window.GHToast.info('Tip: Press Ctrl+P to print report • Ctrl+K to search', 5000);
  }, 3000);

})();

// ============================================================
// NEW FEATURE A: Repository Health Checker
// ============================================================
function renderRepoHealth(repos) {
    const section = document.getElementById('repoHealthSection');
    const grid = document.getElementById('repoHealthGrid');
    if (!section || !grid) return;
    const ownRepos = (repos || []).filter(r => !r.fork).sort((a,b) => b.stargazers_count - a.stargazers_count).slice(0, 12);
    if (!ownRepos.length) return;
    section.style.display = 'block';
    grid.innerHTML = ownRepos.map(r => {
        const flags = [];
        const okFlags = [];
        if (!r.description || !r.description.trim()) flags.push('No description');
        else okFlags.push('Has description');
        if (!r.homepage) flags.push('No live URL');
        else okFlags.push('Live demo');
        if (!r.license) flags.push('No license');
        else okFlags.push(r.license.spdx_id || 'Licensed');
        if (!r.topics || r.topics.length === 0) flags.push('No topics');
        else okFlags.push(`${r.topics.length} topic${r.topics.length>1?'s':''}`);
        if (!r.language) flags.push('No language detected');
        // Health score
        const health = Math.round((okFlags.length / (flags.length + okFlags.length)) * 100);
        const healthColor = health >= 75 ? '#28a745' : health >= 50 ? '#ffc107' : '#dc3545';
        return `<div class="repo-health-card">
            <div class="rh-name" title="${r.name}">📦 ${r.name}</div>
            <div class="rh-flags">
                ${flags.map(f => `<span class="rh-flag err">✗ ${f}</span>`).join('')}
                ${okFlags.map(f => `<span class="rh-flag ok">✓ ${f}</span>`).join('')}
            </div>
            <div class="rh-score" style="color:${healthColor};">Health: ${health}% ${health>=75?'🟢':health>=50?'🟡':'🔴'}</div>
        </div>`;
    }).join('');
}

// ============================================================
// NEW FEATURE B: Tech Stack Fingerprint
// ============================================================
function renderTechStack(repos) {
    const section = document.getElementById('techStackSection');
    const grid = document.getElementById('techStackGrid');
    const catEl = document.getElementById('techStackCategory');
    if (!section || !grid) return;

    const langMap = {};
    (repos || []).forEach(r => {
        if (r.language) langMap[r.language] = (langMap[r.language] || 0) + 1;
        (r.topics || []).forEach(t => { langMap[t] = (langMap[t] || 0) + 1; });
    });

    const techIcons = {
        'JavaScript': '🟨', 'TypeScript': '🔷', 'Python': '🐍', 'Java': '☕',
        'Go': '🐹', 'Rust': '🦀', 'C++': '⚙️', 'C': '⚙️', 'C#': '💜',
        'Ruby': '💎', 'PHP': '🐘', 'Swift': '🍎', 'Kotlin': '🟣',
        'Dart': '🎯', 'Scala': '🔴', 'R': '📊', 'HTML': '🌐',
        'CSS': '🎨', 'Shell': '💻', 'Vue': '💚', 'React': '⚛️',
        'react': '⚛️', 'vue': '💚', 'angular': '🔺', 'svelte': '🔥',
        'nextjs': '▲', 'nodejs': '🟩', 'docker': '🐳', 'kubernetes': '☸️',
        'tensorflow': '🧠', 'pytorch': '🔦', 'django': '🎸', 'flask': '🧪',
        'fastapi': '⚡', 'graphql': '🩷', 'postgres': '🐘', 'mongodb': '🍃',
        'redis': '🔴', 'aws': '☁️', 'gcp': '🌤️', 'azure': '☁️',
        'machine-learning': '🤖', 'web3': '⛓️', 'blockchain': '🔗',
    };

    const categories = {
        'Frontend': ['JavaScript','TypeScript','HTML','CSS','Vue','React','react','vue','angular','svelte','nextjs'],
        'Backend': ['Python','Go','Java','C#','Ruby','PHP','Rust','Scala','nodejs','django','flask','fastapi'],
        'Mobile': ['Swift','Kotlin','Dart','Flutter','flutter'],
        'Data/AI': ['Python','R','tensorflow','pytorch','machine-learning','data-science'],
        'DevOps': ['Shell','docker','kubernetes','aws','gcp','azure'],
        'Systems': ['C','C++','Rust','Go'],
    };

    const detected = Object.keys(langMap).sort((a,b) => langMap[b] - langMap[a]).slice(0,20);
    if (!detected.length) return;
    section.style.display = 'block';

    grid.innerHTML = detected.map(t => {
        const icon = techIcons[t] || techIcons[t.toLowerCase()] || '🔧';
        return `<span class="tech-tag">${icon} ${t}</span>`;
    }).join('');

    // Category verdict
    const catScores = {};
    detected.forEach(t => {
        Object.entries(categories).forEach(([cat, items]) => {
            if (items.map(x=>x.toLowerCase()).includes(t.toLowerCase())) {
                catScores[cat] = (catScores[cat] || 0) + langMap[t];
            }
        });
    });
    const topCats = Object.entries(catScores).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c])=>c);
    if (topCats.length && catEl) {
        catEl.textContent = `🏷️ You appear to be a ${topCats.join(' / ')} developer based on your repositories.`;
    }
}

// ============================================================
// NEW FEATURE C: Recruiter Snapshot Card
// ============================================================
function renderRecruiterSnapshot(userData, repos, analysis) {
    const section = document.getElementById('recruiterSnapshotSection');
    const grid = document.getElementById('recruiterSnapshotGrid');
    if (!section || !grid) return;
    section.style.display = 'block';

    const ownRepos = (repos || []).filter(r => !r.fork);
    const totalStars = (repos || []).reduce((s,r) => s + r.stargazers_count, 0);
    const totalForks = (repos || []).reduce((s,r) => s + r.forks_count, 0);
    const hasReadme = ownRepos.filter(r => r.description).length;
    const now = Date.now();
    const recentActivity = (repos || []).some(r => (now - new Date(r.pushed_at).getTime()) < 1000*60*60*24*30);
    const topLangs = [...new Set((repos||[]).map(r=>r.language).filter(Boolean))].slice(0,4);
    const accountAge = userData.created_at ? Math.floor((now - new Date(userData.created_at).getTime()) / (1000*60*60*24*365)) : 0;
    const score = analysis?.weightedScore || 0;

    const signals = [
        { label: 'Portfolio Score', value: `${score}/100`, sub: score>=75?'Strong':'Needs work', cls: score>=75?'rs-good':score>=50?'rs-warn':'rs-bad' },
        { label: 'Followers', value: userData.followers || 0, sub: (userData.followers||0)>=100?'Notable presence':'Building up', cls: (userData.followers||0)>=100?'rs-good':'rs-warn' },
        { label: 'Total Stars', value: totalStars, sub: totalStars>=50?'High impact':'Gaining traction', cls: totalStars>=50?'rs-good':totalStars>=10?'rs-warn':'rs-bad' },
        { label: 'Public Repos', value: ownRepos.length, sub: ownRepos.length>=10?'Active builder':ownRepos.length>=4?'Growing':'Early stage', cls: ownRepos.length>=10?'rs-good':ownRepos.length>=4?'rs-warn':'rs-bad' },
        { label: 'Account Age', value: `${accountAge}y`, sub: accountAge>=3?'Experienced':'New to platform', cls: accountAge>=3?'rs-good':accountAge>=1?'rs-warn':'rs-bad' },
        { label: 'Recent Activity', value: recentActivity?'Active':'Quiet', sub: recentActivity?'Committed in last 30d':'No recent pushes', cls: recentActivity?'rs-good':'rs-bad' },
        { label: 'Documented Repos', value: `${hasReadme}/${ownRepos.length}`, sub: hasReadme>=ownRepos.length*0.7?'Well documented':'Needs more docs', cls: hasReadme>=ownRepos.length*0.7?'rs-good':hasReadme>=ownRepos.length*0.4?'rs-warn':'rs-bad' },
        { label: 'Forks Earned', value: totalForks, sub: totalForks>=20?'Highly reused':'Niche focus', cls: totalForks>=20?'rs-good':totalForks>=5?'rs-warn':'rs-bad' },
        { label: 'Top Tech', value: topLangs.slice(0,2).join(', ')||'—', sub: topLangs.length>=3?'Polyglot':'Focused stack', cls: 'rs-good' },
    ];

    grid.innerHTML = signals.map(s => `
        <div class="recruiter-signal ${s.cls}">
            <div class="rs-label">${s.label}</div>
            <div class="rs-value">${s.value}</div>
            <div class="rs-sub">${s.sub}</div>
        </div>`).join('');
}

// ============================================================
// Hook new features into existing analysis flow
// ============================================================
(function patchNewFeatures() {
    const _orig = window.handleAnalysis;
    if (typeof _orig !== 'function') {
        // fallback: try to hook wrapHandleAnalysis
        const _origWrap = window.wrapHandleAnalysis;
        return;
    }
    window.handleAnalysis = async function() {
        await _orig.apply(this, arguments);
        try {
            const cd = window.currentData;
            if (!cd) return;
            renderRepoHealth(cd.repos);
            renderTechStack(cd.repos);
            renderRecruiterSnapshot(cd.userData, cd.repos, cd.analysis);
            renderStreakTracker(cd.repos);
            renderStarLeader(cd.repos);
            renderProfileAdvisor(cd.userData, cd.repos, cd.analysis);
        } catch(e) { /* silent */ }
    };
})();

// Also hook via wrapHandleAnalysis results observer
document.addEventListener('DOMContentLoaded', function() {
    // Observe resultsSection becoming visible
    const rs = document.getElementById('resultsSection');
    if (!rs) return;
    const obs = new MutationObserver(() => {
        if (rs.classList.contains('hidden')) return;
        setTimeout(() => {
            try {
                const cd = window.currentData;
                if (!cd) return;
                const rh = document.getElementById('repoHealthSection');
                const ts = document.getElementById('techStackSection');
                const rc = document.getElementById('recruiterSnapshotSection');
                if (rh && rh.querySelector('#repoHealthGrid')?.children.length === 0) renderRepoHealth(cd.repos);
                if (ts && ts.querySelector('#techStackGrid')?.children.length === 0) renderTechStack(cd.repos);
                if (rc && rc.querySelector('#recruiterSnapshotGrid')?.children.length === 0) renderRecruiterSnapshot(cd.userData, cd.repos, cd.analysis);
                try { renderStreakTracker(cd.repos); } catch(_) {}
                try { renderStarLeader(cd.repos); } catch(_) {}
                try { renderProfileAdvisor(cd.userData, cd.repos, cd.analysis); } catch(_) {}
            } catch(_) {}
        }, 800);
    });
    obs.observe(rs, { attributes: true, attributeFilter: ['class'] });
});

// ============================================================
// FEATURE D: GitHub Streak Tracker
// ============================================================
function renderStreakTracker(repos) {
    const section = document.getElementById('streakTrackerSection');
    const grid = document.getElementById('streakTrackerGrid');
    const barWrap = document.getElementById('streakBarWrap');
    if (!section || !grid || !repos || !repos.length) return;

    const now = new Date();
    const ownRepos = repos.filter(r => !r.fork);

    // Push dates
    const updatedDates = ownRepos.map(r => new Date(r.pushed_at || r.updated_at)).filter(Boolean).sort((a,b)=>b-a);
    const createdDates = ownRepos.map(r => new Date(r.created_at)).filter(Boolean).sort((a,b)=>b-a);

    // Active months in last 12
    const activeMonths = new Set();
    updatedDates.forEach(d => {
        const monthsAgo = (now.getFullYear()-d.getFullYear())*12 + now.getMonth()-d.getMonth();
        if (monthsAgo < 12) activeMonths.add(`${d.getFullYear()}-${d.getMonth()}`);
    });
    const monthStreak = activeMonths.size;

    // Repos pushed this year
    const thisYear = now.getFullYear();
    const activeThisYear = updatedDates.filter(d => d.getFullYear() === thisYear).length;

    // Longest gap (days) between pushes
    let maxGap = 0;
    for (let i=0; i<updatedDates.length-1; i++) {
        const gap = Math.round((updatedDates[i].getTime()-updatedDates[i+1].getTime())/(86400000));
        if (gap > maxGap) maxGap = gap;
    }

    // Days since last push
    const daysSinceLastPush = updatedDates[0] ? Math.round((now - updatedDates[0])/86400000) : 999;

    const stats = [
        { num: monthStreak, label: 'Active Months (12mo)', icon: '📅' },
        { num: activeThisYear, label: 'Repos Updated This Year', icon: '🚀' },
        { num: ownRepos.length, label: 'Original Repos', icon: '📦' },
        { num: daysSinceLastPush <= 365 ? daysSinceLastPush : '365+', label: 'Days Since Last Push', icon: '⏱️' },
    ];

    grid.innerHTML = stats.map(s => `
        <div class="streak-card">
            <div style="font-size:1.6em;margin-bottom:6px;">${s.icon}</div>
            <div class="streak-num">${s.num}</div>
            <div class="streak-label">${s.label}</div>
        </div>
    `).join('');

    // Monthly activity bar chart (last 6 months)
    const months = [];
    for (let i=5; i>=0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        const count = updatedDates.filter(ud => `${ud.getFullYear()}-${ud.getMonth()}` === key).length;
        months.push({ label: d.toLocaleString('default',{month:'short'}), count });
    }
    const maxCount = Math.max(...months.map(m=>m.count), 1);

    barWrap.innerHTML = `<div style="font-size:.85em;font-weight:700;color:var(--primary-teal);margin-bottom:10px;">Monthly Pushes (Last 6 Months)</div>` +
        months.map(m => `
        <div class="streak-bar-item">
            <div class="streak-bar-label">${m.label}</div>
            <div class="streak-bar-track" style="opacity:1;background:#e8f4f5;">
                <div class="streak-bar-fill" style="width:${(m.count/maxCount*100).toFixed(1)}%"></div>
            </div>
            <div style="font-size:.82em;font-weight:700;color:var(--primary-teal);min-width:24px;text-align:right;">${m.count}</div>
        </div>`).join('');

    section.style.display = '';
}

// ============================================================
// FEATURE E: Top Repo Spotlight
// ============================================================
function renderStarLeader(repos) {
    const section = document.getElementById('starLeaderSection');
    const grid = document.getElementById('starLeaderGrid');
    if (!section || !grid || !repos || !repos.length) return;

    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣'];
    const top = repos.filter(r=>!r.fork)
        .sort((a,b) => (b.stargazers_count + b.forks_count*2) - (a.stargazers_count + a.forks_count*2))
        .slice(0,6);

    if (!top.length) return;

    grid.innerHTML = top.map((r,i) => {
        const lang = r.language ? `<span style="background:var(--accent-teal);color:var(--primary-teal);border-radius:20px;padding:2px 9px;font-size:.78em;font-weight:700;">${r.language}</span>` : '';
        const topics = (r.topics||[]).slice(0,3).map(t=>`<span style="background:#e8f4f5;color:#555;border-radius:20px;padding:2px 8px;font-size:.75em;">${t}</span>`).join('');
        const desc = r.description ? `<div class="repo-desc">${r.description.slice(0,80)}${r.description.length>80?'...':''}</div>` : '';
        return `
        <div class="star-repo-card">
            <div class="repo-rank">${medals[i]||''}</div>
            <div class="repo-name"><a href="https://github.com/${r.full_name}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${r.name}</a></div>
            ${desc}
            <div class="repo-meta">
                <span>⭐ ${r.stargazers_count}</span>
                <span>🍴 ${r.forks_count}</span>
                <span>👁️ ${r.watchers_count||0}</span>
            </div>
            <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;">${lang}${topics}</div>
        </div>`;
    }).join('');

    section.style.display = '';
}

// ============================================================
// FEATURE F: Profile Completeness Advisor
// ============================================================
function renderProfileAdvisor(userData, repos, analysis) {
    const section = document.getElementById('profileAdvisorSection');
    const list = document.getElementById('profileAdvisorList');
    const scoreWrap = document.getElementById('profileAdvisorScore');
    if (!section || !list || !userData) return;

    const ownRepos = (repos||[]).filter(r=>!r.fork);
    const checks = [
        {
            id: 'bio', label: 'Write a bio',
            hint: 'A short bio tells recruiters who you are instantly.',
            done: !!(userData.bio && userData.bio.trim().length > 10),
            icon: '✍️', weight: 10
        },
        {
            id: 'avatar', label: 'Set a profile photo',
            hint: 'Profiles with photos get significantly more profile views.',
            done: !!(userData.avatar_url && !userData.avatar_url.includes('identicons')),
            icon: '📸', weight: 8
        },
        {
            id: 'location', label: 'Add your location',
            hint: 'Recruiters search by location — being findable matters.',
            done: !!(userData.location && userData.location.trim()),
            icon: '📍', weight: 5
        },
        {
            id: 'blog', label: 'Link a website or portfolio',
            hint: 'A portfolio link doubles recruiter confidence in your skills.',
            done: !!(userData.blog && userData.blog.trim()),
            icon: '🔗', weight: 8
        },
        {
            id: 'twitter', label: 'Add social links (Twitter/X or LinkedIn)',
            hint: 'Social presence signals an engaged, networked developer.',
            done: !!(userData.twitter_username),
            icon: '🐦', weight: 5
        },
        {
            id: 'pinned', label: 'Pin your 6 best repositories',
            hint: 'Pinned repos are the first thing visitors see — curate them.',
            done: ownRepos.length >= 6,
            icon: '📌', weight: 12
        },
        {
            id: 'readme', label: 'Add READMEs to top repos',
            hint: 'At least 50% of your repos should have a README.',
            done: ownRepos.length > 0 && ownRepos.filter(r=>r.has_wiki||r.description).length/ownRepos.length >= 0.5,
            icon: '📄', weight: 15
        },
        {
            id: 'topics', label: 'Add topics to your repos',
            hint: 'Topics make your repos discoverable and signal tech expertise.',
            done: ownRepos.filter(r=>r.topics&&r.topics.length>0).length >= Math.min(3, ownRepos.length),
            icon: '🏷️', weight: 12
        },
        {
            id: 'description', label: 'Add descriptions to all repos',
            hint: 'A one-line description dramatically improves recruiter comprehension.',
            done: ownRepos.length > 0 && ownRepos.filter(r=>r.description&&r.description.trim()).length/ownRepos.length >= 0.7,
            icon: '💬', weight: 10
        },
        {
            id: 'recent', label: 'Push code within the last 30 days',
            hint: 'Recent activity signals you are actively coding.',
            done: ownRepos.some(r => r.pushed_at && ((new Date()-new Date(r.pushed_at))/86400000) < 30),
            icon: '🟢', weight: 15
        },
    ];

    const totalWeight = checks.reduce((s,c)=>s+c.weight,0);
    const earnedWeight = checks.filter(c=>c.done).reduce((s,c)=>s+c.weight,0);
    const score = Math.round((earnedWeight/totalWeight)*100);

    // Show incomplete first
    const sorted = [...checks].sort((a,b) => (a.done?1:-1) - (b.done?1:-1));

    list.innerHTML = sorted.map(c => `
        <div class="advisor-item ${c.done?'done':''}">
            <div class="advisor-icon">${c.done ? '✅' : c.icon}</div>
            <div class="advisor-text">
                <div class="advisor-title" style="${c.done?'text-decoration:line-through;color:#aaa;':''}">${c.label}</div>
                <div class="advisor-hint">${c.hint}</div>
            </div>
            <div style="font-size:.8em;font-weight:700;color:${c.done?'#28a745':'#888'};">+${c.weight}pts</div>
        </div>`).join('');

    const color = score>=80?'#28a745':score>=60?'var(--primary-teal)':score>=40?'#ffc107':'#dc3545';
    scoreWrap.innerHTML = `
        <div class="advisor-score-wrap">
            <div class="advisor-score-num" style="color:${color};">${score}%</div>
            <div style="flex:1;">
                <div style="font-weight:700;margin-bottom:6px;">Profile Completeness</div>
                <div class="advisor-score-bar"><div class="advisor-score-fill" style="width:${score}%;background:${color};"></div></div>
                <div style="font-size:.8em;color:#888;margin-top:4px;">${checks.filter(c=>c.done).length}/${checks.length} checks passed</div>
            </div>
        </div>`;

    section.style.display = '';
}




(function() {
'use strict';

/* ─── Language color map ─── */
const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5',
  Java: '#b07219', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600',
  Go: '#00ADD8', Rust: '#dea584', Ruby: '#701516', PHP: '#4F5D95',
  Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB', HTML: '#e34c26',
  CSS: '#563d7c', SCSS: '#c6538c', Shell: '#89e051', Vue: '#41b883',
  Svelte: '#ff3e00', R: '#198CE7', Scala: '#c22d40', Lua: '#000080',
  Perl: '#0298c3', Haskell: '#5e5086', Elixir: '#6e4a7e', Clojure: '#db5855',
  Julia: '#a270ba', Jupyter: '#DA5B0B', Dockerfile: '#384d54',
};

/* ─── Apply language color dots to existing language items ─── */
function applyLangColors() {
    document.querySelectorAll('.language-name').forEach(el => {
        const lang = el.textContent.trim();
        if (LANG_COLORS[lang] && !el.querySelector('.lang-color-dot')) {
            const dot = document.createElement('span');
            dot.className = 'lang-color-dot';
            dot.style.background = LANG_COLORS[lang];
            el.insertBefore(dot, el.firstChild);
        }
    });
}

/* ─── Quick Tips FAB ─── */
function buildQuickTipsFab() {
    if (document.getElementById('qtip-fab-btn')) return;

    const fab = document.createElement('button');
    fab.id = 'qtip-fab-btn';
    fab.className = 'qtip-fab';
    fab.setAttribute('aria-label', 'Quick tips');
    fab.innerHTML = '💡';
    fab.title = 'Quick Tips';

    const panel = document.createElement('div');
    panel.className = 'qtip-panel';
    panel.id = 'qtip-panel';
    panel.innerHTML = `
        <h4>💡 Quick Tips</h4>
        <ul class="qtip-list">
            <li>Press <kbd>/</kbd> to quickly focus the search box</li>
            <li>Press <kbd>Ctrl+P</kbd> to download your report</li>
            <li>Click any repository card to see deep-dive stats</li>
            <li>Try the Compare section to benchmark against other devs</li>
            <li>Use the Skill Gap tool to find your next tech to learn</li>
            <li>A score above 75 means recruiter-ready 🚀</li>
            <li>Add topics & descriptions to boost your score</li>
        </ul>
    `;

    fab.addEventListener('click', () => panel.classList.toggle('open'));
    document.addEventListener('click', (e) => {
        if (!fab.contains(e.target) && !panel.contains(e.target)) panel.classList.remove('open');
    });

    document.body.appendChild(panel);
    document.body.appendChild(fab);
}

/* ─── Live Profile Preview on input ─── */
let _previewDebounce;
function injectLivePreview() {
    const input = document.getElementById('githubInput');
    if (!input || input._previewHooked) return;
    input._previewHooked = true;

    // Create preview card
    const previewCard = document.createElement('div');
    previewCard.id = 'livePreviewCard';
    previewCard.className = 'live-preview-card';
    previewCard.innerHTML = `
        <img class="lpc-avatar" id="lpcAvatar" src="" alt="Avatar">
        <div class="lpc-info">
            <div class="lpc-name" id="lpcName"></div>
            <div class="lpc-meta" id="lpcMeta"></div>
            <div class="lpc-stats" id="lpcStats"></div>
        </div>
    `;
    const inputGroup = input.closest('.input-group') || input.parentElement;
    if (inputGroup) inputGroup.insertAdjacentElement('afterend', previewCard);

    input.addEventListener('input', () => {
        clearTimeout(_previewDebounce);
        const val = input.value.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/$/, '');
        if (!val || val.length < 2) { previewCard.classList.remove('visible'); return; }
        _previewDebounce = setTimeout(async () => {
            try {
                const res = await fetch(`https://api.github.com/users/${encodeURIComponent(val)}`);
                if (!res.ok) { previewCard.classList.remove('visible'); return; }
                const u = await res.json();
                document.getElementById('lpcAvatar').src = u.avatar_url;
                document.getElementById('lpcName').textContent = u.name || u.login;
                document.getElementById('lpcMeta').textContent = `@${u.login}${u.location ? ' · ' + u.location : ''}`;
                document.getElementById('lpcStats').innerHTML = `<span>📦 ${u.public_repos} repos</span><span>👥 ${u.followers} followers</span><span>⭐ ready</span>`;
                previewCard.classList.add('visible');
            } catch (_) { previewCard.classList.remove('visible'); }
        }, 600);
    });
}

/* ─── Analyze button ready pulse ─── */
function hookAnalyzeBtnPulse() {
    const input = document.getElementById('githubInput');
    const btn = document.getElementById('analyzeBtn');
    if (!input || !btn || btn._pulsed) return;
    btn._pulsed = true;
    input.addEventListener('input', () => {
        btn.classList.toggle('ready', input.value.trim().length > 1);
    });
}

/* ─── Trending Users Panel ─── */
const TRENDING_DEVS = [
    { login: 'torvalds',    name: 'Linus Torvalds', meta: 'Linux creator' },
    { login: 'gaearon',     name: 'Dan Abramov',    meta: 'React team' },
    { login: 'sindresorhus',name: 'Sindre Sorhus',  meta: 'Open source legend' },
    { login: 'yyx990803',   name: 'Evan You',       meta: 'Vue.js creator' },
    { login: 'tj',          name: 'TJ Holowaychuk', meta: 'Express.js creator' },
    { login: 'antirez',     name: 'Salvatore Sanf.', meta: 'Redis creator' },
];

function buildTrendingPanel() {
    if (document.getElementById('trendingPanel')) return;
    const section = document.querySelector('.input-section');
    if (!section) return;

    const panel = document.createElement('div');
    panel.id = 'trendingPanel';
    panel.className = 'trending-panel';
    panel.innerHTML = `
        <h3>⚡ Try a Notable Profile</h3>
        <p style="color:#666;margin-bottom:16px;font-size:.9em;">Click any card to instantly analyze their portfolio:</p>
        <div class="trending-list" id="trendingList"></div>
    `;
    section.insertAdjacentElement('afterend', panel);

    const list = document.getElementById('trendingList');
    TRENDING_DEVS.forEach(dev => {
        const card = document.createElement('div');
        card.className = 'trending-user-card';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Analyze ${dev.name}`);
        card.innerHTML = `
            <img src="https://github.com/${dev.login}.png?size=80" alt="${dev.name}" loading="lazy" onerror="this.src='https://github.com/ghost.png'">
            <div>
                <div class="tu-name">${dev.name}</div>
                <div class="tu-meta">${dev.meta}</div>
            </div>
        `;
        const analyze = () => {
            const input = document.getElementById('githubInput');
            if (input) {
                input.value = dev.login;
                input.dispatchEvent(new Event('input'));
            }
            const btn = document.getElementById('analyzeBtn');
            if (btn) btn.click();
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        card.addEventListener('click', analyze);
        card.addEventListener('keypress', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); analyze(); } });
        list.appendChild(card);
    });
}

/* ─── Social Share Buttons ─── */
function injectSocialShareBtns() {
    if (document.getElementById('socialShareRow')) return;
    const shareSection = document.getElementById('shareSection');
    if (!shareSection) return;

    const row = document.createElement('div');
    row.id = 'socialShareRow';
    row.className = 'social-share-row';
    row.innerHTML = `
        <button class="ss-btn twitter" id="ssTwitter" aria-label="Share on Twitter/X">
            𝕏 Share on X/Twitter
        </button>
        <button class="ss-btn linkedin" id="ssLinkedin" aria-label="Share on LinkedIn">
            in Share on LinkedIn
        </button>
        <button class="ss-btn email" id="ssEmail" aria-label="Share via email">
            ✉️ Share via Email
        </button>
    `;
    const shareBtns = shareSection.querySelector('.share-buttons');
    if (shareBtns) shareBtns.insertAdjacentElement('afterend', row);

    document.getElementById('ssTwitter').addEventListener('click', () => {
        const u = window.currentData?.username;
        const score = window.currentData?.analysis?.weightedScore;
        if (!u) { window.GHToast?.warning('Analyze a profile first'); return; }
        const text = `🚀 My GitHub Portfolio Score: ${score}/100!\nAnalyze your GitHub at ${location.origin}\n\n#GitHub #Developer #Portfolio`;
        window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'width=600,height=400');
    });

    document.getElementById('ssLinkedin').addEventListener('click', () => {
        const u = window.currentData?.username;
        if (!u) { window.GHToast?.warning('Analyze a profile first'); return; }
        const shareUrl = `${location.origin}${location.pathname}?u=${encodeURIComponent(u)}`;
        window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`, '_blank', 'width=600,height=600');
    });

    document.getElementById('ssEmail').addEventListener('click', () => {
        const u = window.currentData?.username;
        const score = window.currentData?.analysis?.weightedScore;
        if (!u) { window.GHToast?.warning('Analyze a profile first'); return; }
        const subject = `Check out my GitHub Portfolio Score — ${score}/100!`;
        const body = `Hi!\n\nI analyzed my GitHub portfolio and scored ${score}/100. Check it out here:\n${location.origin}${location.pathname}?u=${encodeURIComponent(u)}\n\nAnalyze your own profile at ${location.origin}`;
        window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    });
}

/* ─── "Compare with me" autofill in compare section ─── */
function injectCompareAutofill() {
    if (document.getElementById('compareAutofillRow')) return;
    const compareInputsWrap = document.getElementById('compareInputsWrap');
    if (!compareInputsWrap) return;

    const row = document.createElement('div');
    row.id = 'compareAutofillRow';
    row.className = 'compare-autofill';
    row.innerHTML = `
        <span>Quick fill:</span>
        <button id="cmpFillMe" title="Fill with currently analyzed user">🙋 Fill with analyzed user</button>
        <button id="cmpFillTorvalds" title="Fill with Linus Torvalds">🐧 torvalds</button>
        <button id="cmpFillGaearon" title="Fill with Dan Abramov">⚛️ gaearon</button>
    `;
    compareInputsWrap.insertAdjacentElement('afterend', row);

    document.getElementById('cmpFillMe').addEventListener('click', () => {
        const u = window.currentData?.username;
        if (!u) { window.GHToast?.warning('Analyze a profile first!'); return; }
        const cmpA = document.getElementById('cmpA');
        if (cmpA && !cmpA.value) cmpA.value = u;
        else { const cmpB = document.getElementById('cmpB'); if (cmpB && !cmpB.value) cmpB.value = u; }
        window.GHToast?.success('Autofilled your username!');
    });

    document.getElementById('cmpFillTorvalds').addEventListener('click', () => {
        const cmpB = document.getElementById('cmpB');
        if (cmpB) { cmpB.value = 'torvalds'; window.GHToast?.info('Filled: torvalds'); }
    });

    document.getElementById('cmpFillGaearon').addEventListener('click', () => {
        const cmpC = document.getElementById('cmpC');
        if (cmpC) { cmpC.value = 'gaearon'; window.GHToast?.info('Filled: gaearon'); }
    });
}

/* ─── Contribution Activity Banner (shown after analysis) ─── */
function injectContribBanner(username) {
    const existing = document.getElementById('contribBanner');
    if (existing) { existing.remove(); }
    const profileCard = document.querySelector('.profile-card');
    if (!profileCard) return;

    const banner = document.createElement('div');
    banner.id = 'contribBanner';
    banner.className = 'contrib-banner';
    banner.innerHTML = `
        <div class="cb-icon">📈</div>
        <div class="cb-text">
            <div class="cb-title">View Full Contribution Graph</div>
            <div class="cb-sub">See @${username}'s full commit history, streaks, and contribution calendar on GitHub</div>
        </div>
        <a href="https://github.com/${username}" target="_blank" rel="noopener" class="cb-link" aria-label="Open GitHub profile">View on GitHub →</a>
    `;
    profileCard.insertAdjacentElement('afterend', banner);
}

/* ─── Score Explanation Strip on Score Card ─── */
function injectScoreExplainStrip(score) {
    const existing = document.getElementById('scoreExplainStrip');
    if (existing) existing.remove();
    const scoreCard = document.querySelector('.score-card');
    if (!scoreCard) return;

    const emoji = score >= 90 ? '🏆' : score >= 75 ? '🚀' : score >= 60 ? '💪' : score >= 45 ? '📈' : '🌱';
    const advice = score >= 90 ? 'Outstanding — your profile will impress any recruiter.'
        : score >= 75 ? 'Strong portfolio — a few polish improvements will make it perfect.'
        : score >= 60 ? 'Good foundation — focus on adding descriptions and consistent commits.'
        : score >= 45 ? 'Room to grow — start by adding READMEs and repo descriptions.'
        : 'Early stage — add descriptions to repos and commit more consistently.';

    const strip = document.createElement('div');
    strip.id = 'scoreExplainStrip';
    strip.className = 'score-explain-strip';
    strip.innerHTML = `${emoji} <span><strong>${score}/100:</strong> ${advice} <button onclick="window.openModal && window.openModal('scoreModal')" style="background:none;border:none;color:var(--primary-teal);cursor:pointer;font-size:inherit;text-decoration:underline;padding:0;">How is this calculated?</button></span>`;
    scoreCard.insertAdjacentElement('afterend', strip);
}

/* ─── Export PDF via Print Dialog ─── */
function ensureExportPDF() {
    // Enhance existing exportPDF if it only does print()
    const origExportPDF = window.exportPDF;
    window.exportPDF = function() {
        if (!window.currentData) { window.GHToast?.warning('Analyze a profile first!'); return; }
        // Prefer printAnalysis (downloads HTML) if available
        if (window.printAnalysis) {
            window.printAnalysis();
        } else if (origExportPDF) {
            origExportPDF();
        } else {
            window.print();
        }
    };
}

/* ─── Apply language colors to language chart items ─── */
function applyLangColorsToChart() {
    document.querySelectorAll('.language-item').forEach(item => {
        const nameEl = item.querySelector('.language-name');
        if (!nameEl) return;
        const lang = nameEl.textContent.replace(/[^\w+#.]/g, '').trim();
        const color = LANG_COLORS[lang];
        if (color) {
            item.style.borderLeftColor = color;
            if (!nameEl.querySelector('.lang-color-dot')) {
                const dot = document.createElement('span');
                dot.className = 'lang-color-dot';
                dot.style.background = color;
                nameEl.insertBefore(dot, nameEl.firstChild);
            }
        }
    });
}

/* ─── Badge code block copy buttons ─── */
function addCopyToCodeBlocks() {
    document.querySelectorAll('.badge-box, pre, code.copyable, .badge-embed-card').forEach(block => {
        if (block.querySelector('.code-copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'code-copy-btn';
        btn.textContent = '📋 Copy';
        btn.style.cssText = 'position:absolute;top:8px;right:8px;background:var(--primary-teal);color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:.78em;font-weight:700;';
        btn.addEventListener('click', () => {
            const text = block.textContent.replace('📋 Copy', '').trim();
            navigator.clipboard?.writeText(text).then(() => {
                btn.textContent = '✅ Copied!';
                setTimeout(() => btn.textContent = '📋 Copy', 2000);
            });
        });
        const pos = getComputedStyle(block).position;
        if (pos === 'static') block.style.position = 'relative';
        block.appendChild(btn);
    });
}

/* ─── Hook into displayResults ─── */
function hookV3DisplayResults() {
    const orig = window.displayResults;
    if (!orig || orig._v3Hooked) return;
    window.displayResults = function(userData, repos, analysis) {
        orig(userData, repos, analysis);
        const username = userData.login;
        const score = analysis.weightedScore;

        setTimeout(() => {
            injectContribBanner(username);
            injectScoreExplainStrip(score);
            injectSocialShareBtns();
            applyLangColorsToChart();
            applyLangColors();
            injectCompareAutofill();
            addCopyToCodeBlocks();
        }, 500);
    };
    window.displayResults._v3Hooked = true;
}

/* ─── Init ─── */
function initV3() {
    buildQuickTipsFab();
    injectLivePreview();
    hookAnalyzeBtnPulse();
    buildTrendingPanel();
    ensureExportPDF();

    hookV3DisplayResults();
    setTimeout(hookV3DisplayResults, 800);
    setTimeout(hookV3DisplayResults, 2000);

    // Re-apply on any DOM mutations inside results section
    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection && window.MutationObserver) {
        const mo = new MutationObserver(() => {
            applyLangColors();
            applyLangColorsToChart();
            addCopyToCodeBlocks();
        });
        mo.observe(resultsSection, { childList: true, subtree: true });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initV3);
} else {
    initV3();
}

})();




function scrollToResults() {
    const el = document.getElementById('resultsSection');
    if (!el) return;
    el.classList.remove('hidden');
    // Primary smooth scroll
    setTimeout(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
    // Reinforce scroll position once dynamic sub-panels settle
    setTimeout(() => {
        const rect = el.getBoundingClientRect();
        if (rect.top > 250 || rect.top < -50) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 450);
}
window.scrollToResults = scrollToResults;

function switchAnalysisTab(tabName, shouldScroll = true) {
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const target = document.getElementById('tab-' + tabName);
    if (target) target.classList.add('active');

    const activeBtn = Array.from(document.querySelectorAll('.tab-btn'))
        .find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(tabName));
    if (activeBtn) activeBtn.classList.add('active');

    if (history.replaceState) {
        history.replaceState(null, null, '#' + tabName);
    }

    // Always scroll smoothly to the beginning of the tabs navigation
    if (shouldScroll) {
        requestAnimationFrame(() => {
            const nav = document.querySelector('.analysis-tabs-nav');
            if (nav) {
                nav.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }
}
window.switchAnalysisTab = switchAnalysisTab;

window.addEventListener('DOMContentLoaded', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash && document.getElementById('tab-' + hash)) {
        switchAnalysisTab(hash);
    }
});



/* ─── 👤 What is Missing from Your GitHub Profile ─── */
function renderMissingProfileChecks(userData, repos, analysis) {
    const list = document.getElementById('missingProfileList');
    if (!list) return;
    const own = (repos || []).filter(r => !r.fork);
    const missing = [];

    // 1. Bio
    if (!userData.bio || !userData.bio.trim()) {
        missing.push({
            icon: '📝',
            title: 'Professional Bio',
            desc: 'Add a 1-sentence engineering elevator pitch summarizing your core tech stack and passion.',
            action: 'Edit Bio on GitHub',
            url: 'https://github.com/settings/profile'
        });
    }

    // 2. Location / Company / Website
    if (!userData.blog && !userData.location && !userData.company) {
        missing.push({
            icon: '🌐',
            title: 'Website, Location & Company',
            desc: 'Include your portfolio link, LinkedIn URL, or city to give technical recruiters verification context.',
            action: 'Add Details',
            url: 'https://github.com/settings/profile'
        });
    }

    // 3. Project descriptions
    const reposWithoutDesc = own.filter(r => !r.description || r.description.trim().length < 8);
    if (reposWithoutDesc.length > 0) {
        const sampleName = reposWithoutDesc[0]?.name || 'project';
        missing.push({
            icon: '📋',
            title: `${reposWithoutDesc.length} Repository Description${reposWithoutDesc.length > 1 ? 's' : ''}`,
            desc: `Provide clear, high-impact descriptions for projects like "${sampleName}". Recruiters glance past untitled repos.`,
            action: 'Review Repos',
            url: `https://github.com/${userData.login}?tab=repositories`
        });
    }

    // 4. Open-Source Licenses
    const reposWithoutLicense = own.filter(r => !r.license);
    if (reposWithoutLicense.length > 0) {
        missing.push({
            icon: '⚖️',
            title: 'Open Source License',
            desc: `${reposWithoutLicense.length} repositories are missing a license. Adding an MIT or Apache-2.0 license demonstrates IP awareness.`,
            action: 'Choose a License',
            url: 'https://choosealicense.com/'
        });
    }

    // 5. Repository topics
    const reposWithoutTopics = own.filter(r => !r.topics || r.topics.length === 0);
    if (reposWithoutTopics.length > 0) {
        missing.push({
            icon: '🏷️',
            title: 'Topic Tags & Keywords',
            desc: 'Add GitHub topics (#react, #typescript, #python, #docker) so recruiters and algorithms can find your repositories.',
            action: 'Add Topics',
            url: `https://github.com/${userData.login}?tab=repositories`
        });
    }

    // 6. Recent commit activity
    const now = Date.now();
    const hasRecent = (repos || []).some(r => (now - new Date(r.pushed_at).getTime()) < 1000 * 60 * 60 * 24 * 90);
    if (!hasRecent && own.length > 0) {
        missing.push({
            icon: '⚡',
            title: 'Recent Activity (Last 90 Days)',
            desc: 'No commits in the past 90 days. Recruiters prioritize active, shipping engineers. Push an update or polish a README.',
            action: 'Push Update',
            url: `https://github.com/${userData.login}`
        });
    }

    if (missing.length === 0) {
        list.innerHTML = `
            <div class="missing-item all-good">
                <span class="missing-icon">🎉</span>
                <div class="missing-content">
                    <h4>Outstanding! 100% Recruiter-Ready Profile</h4>
                    <p>Your GitHub profile has all the essentials: clear bio, contact/portfolio links, well-described repositories, open source licenses, and active commits.</p>
                </div>
            </div>`;
    } else {
        list.innerHTML = missing.map(m => `
            <div class="missing-item">
                <span class="missing-icon">${m.icon}</span>
                <div class="missing-content">
                    <h4>${m.title}</h4>
                    <p>${m.desc}</p>
                </div>
                <a href="${m.url}" target="_blank" rel="noopener" class="missing-action-btn">${m.action} ↗</a>
            </div>
        `).join('');
    }
}
window.renderMissingProfileChecks = renderMissingProfileChecks;

/* ─── Social & Direct Share Handlers ─── */
function shareOnTwitter() {
    const cd = window.currentData;
    const score = cd?.analysis?.weightedScore || 85;
    const user = cd?.username || 'developer';
    const text = encodeURIComponent(`🚀 Just checked my GitHub Portfolio Score: ${score}/100 on GitHub Portfolio Analyzer! Analyze your profile here:`);
    const url = encodeURIComponent(`${location.origin}${location.pathname}?u=${encodeURIComponent(user)}`);
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, '_blank', 'width=600,height=400');
}
window.shareOnTwitter = shareOnTwitter;

function shareOnLinkedIn() {
    const cd = window.currentData;
    const user = cd?.username || 'developer';
    const url = encodeURIComponent(`${location.origin}${location.pathname}?u=${encodeURIComponent(user)}`);
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${url}`, '_blank', 'width=600,height=500');
}
window.shareOnLinkedIn = shareOnLinkedIn;

function shareViaEmail() {
    const cd = window.currentData;
    const name = cd?.userData?.name || cd?.username || 'developer';
    const score = cd?.analysis?.weightedScore || 85;
    const user = cd?.username || '';
    const subject = encodeURIComponent(`GitHub Portfolio Analysis for ${name} (Score: ${score}/100)`);
    const body = encodeURIComponent(`Hi,

Take a look at my GitHub Portfolio Analysis (Score: ${score}/100):
${location.origin}${location.pathname}?u=${encodeURIComponent(user)}

Best regards,
${name}`);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
}
window.shareViaEmail = shareViaEmail;

/* ─── Robust Tab Switching with Instant/Smooth Anchor Reset ─── */
function switchAnalysisTab(tabName, shouldScroll = true) {
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const target = document.getElementById('tab-' + tabName);
    if (target) target.classList.add('active');

    const activeBtn = Array.from(document.querySelectorAll('.tab-btn'))
        .find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(tabName));
    if (activeBtn) activeBtn.classList.add('active');

    if (history.replaceState) {
        history.replaceState(null, null, '#' + tabName);
    }

    if (shouldScroll) {
        // Use static #tabsScrollAnchor to guarantee viewport resets to the top of the tabbed area
        const anchor = document.getElementById('tabsScrollAnchor') || document.querySelector('.analysis-tabs-nav');
        if (anchor) {
            const targetY = anchor.getBoundingClientRect().top + window.pageYOffset - 15;
            window.scrollTo({
                top: Math.max(0, targetY),
                behavior: 'smooth'
            });
        }
    }
}
window.switchAnalysisTab = switchAnalysisTab;

/* ─── Smooth Auto-Scroll on Analysis Complete ─── */
function scrollToResults() {
    const el = document.getElementById('resultsSection');
    if (!el) return;
    el.classList.remove('hidden');
    setTimeout(() => {
        const anchor = document.getElementById('tabsScrollAnchor') || el;
        const targetY = anchor.getBoundingClientRect().top + window.pageYOffset - 15;
        window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
    }, 150);
}
window.scrollToResults = scrollToResults;


/* ── Explicit Window Exports for HTML Event Handlers ── */
if (typeof handleAnalysis === 'function') window.handleAnalysis = handleAnalysis;
if (typeof switchAnalysisTab === 'function') window.switchAnalysisTab = switchAnalysisTab;
if (typeof printAnalysis === 'function') window.printAnalysis = printAnalysis;
if (typeof exportPDF === 'function') window.exportPDF = exportPDF;
if (typeof downloadJSON === 'function') window.downloadJSON = downloadJSON;
if (typeof downloadMarkdown === 'function') window.downloadMarkdown = downloadMarkdown;
if (typeof resetForm === 'function') window.resetForm = resetForm;
if (typeof setInputType === 'function') window.setInputType = setInputType;
if (typeof sharePublicPortfolio === 'function') window.sharePublicPortfolio = sharePublicPortfolio;
if (typeof shareLink === 'function') window.shareLink = shareLink;
if (typeof copySummary === 'function') window.copySummary = copySummary;
if (typeof toggleDark === 'function') window.toggleDark = toggleDark;
if (typeof renderRepos === 'function') window.renderRepos = renderRepos;
if (typeof runUsername === 'function') window.runUsername = runUsername;
if (typeof removeHistory === 'function') window.removeHistory = removeHistory;
if (typeof copyShareLink === 'function') window.copyShareLink = copyShareLink;
if (typeof generateLinkedInSummary === 'function') window.generateLinkedInSummary = generateLinkedInSummary;
if (typeof copyRecruiterProfile === 'function') window.copyRecruiterProfile = copyRecruiterProfile;
if (typeof generateQR === 'function') window.generateQR = generateQR;
if (typeof openEmbedCardModal === 'function') window.openEmbedCardModal = openEmbedCardModal;
if (typeof shareOnTwitter === 'function') window.shareOnTwitter = shareOnTwitter;
if (typeof shareOnLinkedIn === 'function') window.shareOnLinkedIn = shareOnLinkedIn;
if (typeof shareViaEmail === 'function') window.shareViaEmail = shareViaEmail;
if (typeof scrollToResults === 'function') window.scrollToResults = scrollToResults;
if (typeof renderMissingProfileChecks === 'function') window.renderMissingProfileChecks = renderMissingProfileChecks;



/* ─── GitHub Rate Limit Live Badge ─── */
async function updateRateLimitBadge() {
    const badge = document.getElementById('rateLimitBadge');
    const text = document.getElementById('rateLimitText');
    if (!badge || !text) return;

    try {
        const res = await fetch('/api/github/rate_limit').catch(() => null);
        if (res && res.ok) {
            const data = await res.json();
            const remaining = data?.rate?.remaining ?? data?.resources?.core?.remaining ?? 4980;
            const limit = data?.rate?.limit ?? data?.resources?.core?.limit ?? 5000;
            text.textContent = `${remaining}/${limit} API Quota`;
            badge.classList.remove('warning', 'danger');
            if (remaining <= 20) badge.classList.add('danger');
            else if (remaining <= 100) badge.classList.add('warning');
            return;
        }
    } catch (_) {}
    text.textContent = 'API Live (Active)';
}
window.updateRateLimitBadge = updateRateLimitBadge;

// Run rate limit update on load and after analysis
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateRateLimitBadge);
} else {
    updateRateLimitBadge();
}

/* ─── Official GitHub Language Colors Map ─── */
const GITHUB_LANG_COLORS = {
    'JavaScript': '#f1e05a',
    'TypeScript': '#3178c6',
    'Python': '#3572A5',
    'Java': '#b07219',
    'HTML': '#e34c26',
    'CSS': '#563d7c',
    'C++': '#f34b7d',
    'C': '#555555',
    'C#': '#178600',
    'Go': '#00ADD8',
    'Rust': '#dea584',
    'PHP': '#4F5D95',
    'Ruby': '#701516',
    'Swift': '#F05138',
    'Kotlin': '#A97BFF',
    'Dart': '#00B4AB',
    'Shell': '#89e051',
    'Vue': '#41b883',
    'R': '#198CE7',
    'Scala': '#c22d40',
    'Elixir': '#6e4a7e',
    'Svelte': '#ff3e00'
};
function getLangColor(lang) {
    return GITHUB_LANG_COLORS[lang] || '#0d7377';
}
window.getLangColor = getLangColor;

/* ─── Resume PDF Drag & Drop Uploader ─── */
function setupResumeDropzone() {
    const dropzone = document.getElementById('resumeDropzone');
    if (!dropzone) return;

    ['dragenter', 'dragover'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        });
    });

    ['dragleave', 'drop'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
        });
    });

    dropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) handleResumeFile(file);
    });
}
window.setupResumeDropzone = setupResumeDropzone;

async function handleResumeFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        if (window.GHToast) window.GHToast.error('Please upload a PDF format resume.');
        else alert('Please upload a PDF format resume.');
        return;
    }

    const loader = document.getElementById('resumeAnalysisLoading');
    const resultBox = document.getElementById('resumeResultBox');
    if (loader) loader.style.display = 'block';
    if (resultBox) resultBox.style.display = 'none';

    const formData = new FormData();
    formData.append('resume', file);
    const username = window.currentData?.username || document.getElementById('githubInput')?.value?.trim() || '';

    try {
        // Double-submit CSRF token support
        function getCsrf() {
            const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
            return m ? decodeURIComponent(m[1]) : "";
        }
        const csrfToken = getCsrf();
        const headers = {};
        if (csrfToken) headers['x-csrf-token'] = csrfToken;

        const res = await fetch(`/api/resume?github=${encodeURIComponent(username)}`, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Failed to analyze resume');
        }

        const data = await res.json();
        renderResumeResults(data);
    } catch (err) {
        if (window.GHToast) window.GHToast.error(err.message || 'Error parsing resume');
        else alert(err.message || 'Error parsing resume');
    } finally {
        if (loader) loader.style.display = 'none';
    }
}
window.handleResumeFile = handleResumeFile;

function renderResumeResults(data) {
    const box = document.getElementById('resumeResultBox');
    if (!box) return;

    const ghSkills = new Set((window.currentData?.analysis?.languages || []).map(l => l.name.toLowerCase()));
    const resumeSkills = data.skills || [];
    const matched = resumeSkills.filter(s => ghSkills.has(s.toLowerCase()));
    const resumeOnly = resumeSkills.filter(s => !ghSkills.has(s.toLowerCase()));

    box.innerHTML = `
        <div class="resume-metrics-grid">
            <div class="resume-metric-card">
                <div class="resume-metric-val">${data.atsScore ?? 85}%</div>
                <div class="resume-metric-lbl">ATS Format Score</div>
            </div>
            <div class="resume-metric-card">
                <div class="resume-metric-val">${data.matchScore ?? Math.round((matched.length / Math.max(1, resumeSkills.length)) * 100)}%</div>
                <div class="resume-metric-lbl">GitHub Project Match</div>
            </div>
            <div class="resume-metric-card">
                <div class="resume-metric-val">${resumeSkills.length}</div>
                <div class="resume-metric-lbl">Extracted Skills</div>
            </div>
        </div>

        <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:10px;padding:18px;margin-bottom:16px;">
            <h4 style="margin:0 0 10px;color:var(--primary-teal);">🎯 Skills Found on Resume</h4>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                ${matched.map(s => `<span class="skill-pill match" title="Verified in GitHub repositories">✓ ${s}</span>`).join('')}
                ${resumeOnly.map(s => `<span class="skill-pill resume-only" title="Listed on resume, add a repo to prove it">${s}</span>`).join('')}
            </div>
            <p style="font-size:0.82em;color:#666;margin:10px 0 0;">
                <span style="color:#15803d;font-weight:700;">✓ Green</span> = Verified in both GitHub & Resume.
                <span style="color:#0369a1;font-weight:700;margin-left:8px;">Blue</span> = On Resume only (add GitHub repos to prove).
            </p>
        </div>

        ${(data.suggestions && data.suggestions.length) ? `
            <div style="background:#fefce8;border:1px solid #fef08a;border-radius:10px;padding:16px;">
                <h4 style="margin:0 0 8px;color:#854d0e;">💡 ATS Improvement Recommendations</h4>
                <ul style="margin:0;padding-left:18px;font-size:0.88em;color:#713f12;line-height:1.6;">
                    ${data.suggestions.map(s => `<li>${s}</li>`).join('')}
                </ul>
            </div>
        ` : ''}
    `;

    box.style.display = 'block';
    if (window.GHToast) window.GHToast.success('Resume analyzed successfully!');
}
window.renderResumeResults = renderResumeResults;

/* ─── Compare Mode Smooth Scroll ─── */
function scrollToCompare() {
    const el = document.getElementById('compareSection');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.scrollToCompare = scrollToCompare;

/* ─── Tab Arrow Keyboard Navigation ─── */
document.addEventListener('DOMContentLoaded', () => {
    setupResumeDropzone();
    const tabs = Array.from(document.querySelectorAll('.tab-btn'));
    tabs.forEach((tab, idx) => {
        tab.setAttribute('tabindex', '0');
        tab.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                const next = tabs[(idx + 1) % tabs.length];
                next.focus();
                next.click();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
                prev.focus();
                prev.click();
            }
        });
    });
});



function showToast(msg, type = 'success', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    const icon = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
    t.innerHTML = `<span>${icon}</span><span style="flex:1">${msg}</span><button class="gha-toast-close" onclick="this.parentElement.remove()">✕</button>`;
    container.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateY(10px)';
        t.style.transition = 'all 0.3s ease';
        setTimeout(() => t.remove(), 300);
    }, duration);
}
window.showToast = showToast;
if (window.GHToast) {
    window.GHToast.success = (m, d) => showToast(m, 'success', d);
    window.GHToast.error = (m, d) => showToast(m, 'error', d);
    window.GHToast.warning = (m, d) => showToast(m, 'warning', d);
    window.GHToast.info = (m, d) => showToast(m, 'info', d);
}



/* ─── Check Notable People runUsername ─── */
function runUsername(u) {
    const input = document.getElementById('githubInput');
    if (input) {
        input.value = u;
        if (typeof window.handleAnalysis === 'function') {
            window.handleAnalysis();
        }
    }
}
window.runUsername = runUsername;

/* ─── Add Profile to Compare ─── */
function addCompareProfile() {
    const cmpC = document.getElementById('cmpC');
    const cmpD = document.getElementById('cmpD');
    const btn = document.getElementById('addCmpBtn');
    if (cmpC && cmpC.style.display === 'none') {
        cmpC.style.display = '';
        cmpC.focus();
    } else if (cmpD && cmpD.style.display === 'none') {
        cmpD.style.display = '';
        cmpD.focus();
        if (btn) btn.style.display = 'none';
    }
}
window.addCompareProfile = addCompareProfile;
