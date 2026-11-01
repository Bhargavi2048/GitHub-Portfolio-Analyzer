const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
const { metrics } = require("../utils/metrics");

const GH = "https://api.github.com";

function headers() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-portfolio-analyzer",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function gh(pathname, extraHeaders = {}) {
  const key = `gh:${pathname}`;
  const hit = cache.get(key);
  if (hit) {
    metrics?.cacheHits?.inc();
    return hit;
  }
  metrics?.cacheMisses?.inc();

  const start = Date.now();
  const res = await fetch(`${GH}${pathname}`, { headers: { ...headers(), ...extraHeaders } });
  const durationSec = (Date.now() - start) / 1000;
  const statusLabel = res.ok ? "ok" : String(res.status);

  // Record GitHub API latency
  const endpoint = pathname.split("?")[0].replace(/\/[^/]+$/, "/:id").slice(0, 60);
  metrics?.githubApiLatency?.observe({ endpoint, status: statusLabel }, durationSec);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status === 404 ? 404 : res.status === 403 ? 429 : 502;
    throw err;
  }
  const data = await res.json();
  cache.set(key, data);
  return data;
}

async function fetchProfile(username) {
  return gh(`/users/${encodeURIComponent(username)}`);
}
async function fetchRepos(username) {
  const repos = await gh(`/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`);
  return repos.filter((r) => !r.fork && !r.archived);
}
async function fetchEvents(username) {
  try {
    return await gh(`/users/${encodeURIComponent(username)}/events/public?per_page=100`);
  } catch {
    return [];
  }
}

/**
 * Fetch README for a single repo via the GitHub API.
 * Returns true if a README exists, false otherwise.
 */
async function repoHasReadme(username, repoName) {
  try {
    const data = await gh(`/repos/${encodeURIComponent(username)}/${encodeURIComponent(repoName)}/readme`);
    return !!(data && data.content);
  } catch {
    return false;
  }
}

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function computeScore(d) {
  const r = d.repos.length || 1;
  const activity = clamp(Math.log10(d.activitySum + 1) * 35 + Math.min(d.repos.length, 30));
  const quality = clamp((d.withLicense / r) * 50 + (d.withTopics / r) * 50);
  const impact = clamp(Math.log10(d.totalStars + 1) * 30 + Math.log10(d.profile.followers + 1) * 20);
  const diversity = clamp(d.languages.length * 12);
  const documentation = clamp(((d.withReadme / r) * 70) + (d.profile.bio ? 30 : 0));

  const total = Math.round(
    activity * 0.25 + quality * 0.2 + impact * 0.25 + diversity * 0.15 + documentation * 0.15
  );
  const ats = clamp(
    (d.profile.bio ? 18 : 0) +
      (d.profile.blog ? 12 : 0) +
      (d.profile.location ? 6 : 0) +
      (d.profile.name ? 6 : 0) +
      Math.min(d.languages.length * 4, 24) +
      Math.min(d.withReadme * 2, 20) +
      Math.min(d.withTopics * 1.5, 14)
  );

  const rank =
    total >= 85 ? "S" : total >= 70 ? "A" : total >= 55 ? "B" : total >= 40 ? "C" : "D";

  return {
    total,
    ats: Math.round(ats),
    pillars: {
      activity: Math.round(activity),
      quality: Math.round(quality),
      impact: Math.round(impact),
      diversity: Math.round(diversity),
      documentation: Math.round(documentation),
    },
    rank,
  };
}

async function analyze(username) {
  const [profile, repos, events] = await Promise.all([
    fetchProfile(username),
    fetchRepos(username),
    fetchEvents(username),
  ]);

  const totalStars = repos.reduce((s, r) => s + r.stargazers_count, 0);
  const totalForks = repos.reduce((s, r) => s + r.forks_count, 0);

  const langCount = new Map();
  for (const r of repos) if (r.language) langCount.set(r.language, (langCount.get(r.language) || 0) + 1);
  const languages = [...langCount.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const months = {};
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`] = 0;
  }
  for (const e of events) {
    if (e.type === "PushEvent") {
      const k = e.created_at.slice(0, 7);
      if (k in months) months[k]++;
    }
  }
  const activityByMonth = Object.entries(months).map(([month, commits]) => ({
    month: month.slice(5),
    commits,
  }));
  const activitySum = Object.values(months).reduce((a, b) => a + b, 0);

  const topRepos = [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 6);

  // Use the real GitHub README API for top 6 repos (not a byte-size heuristic)
  const top6ReadmeChecks = await Promise.allSettled(
    topRepos.map((r) => repoHasReadme(username, r.name))
  );
  const top6WithReadme = top6ReadmeChecks.filter((r) => r.status === "fulfilled" && r.value).length;

  // Overall withReadme uses size heuristic for all repos (avoids N+1 API calls on large profiles)
  const withReadme = repos.filter((r) => r.size > 5).length;
  const withLicense = repos.filter((r) => !!r.license).length;
  const withTopics = repos.filter((r) => r.topics && r.topics.length > 0).length;

  // Attach real hasReadme flag to each top repo
  const enrichedTopRepos = topRepos.map((r, i) => ({
    ...r,
    hasReadme: top6ReadmeChecks[i]?.status === "fulfilled" ? top6ReadmeChecks[i].value : r.size > 5,
  }));

  const score = computeScore({
    profile,
    repos,
    totalStars,
    languages,
    activitySum,
    withReadme,
    withLicense,
    withTopics,
  });

  // Track analyze request in Prometheus
  metrics?.analyzeRequests?.inc({ status: "success" });

  return {
    profile,
    repos,
    stats: {
      totalStars,
      totalForks,
      languages,
      activityByMonth,
      topRepos: enrichedTopRepos,
      withReadme,
      withLicense,
      withTopics,
      top6WithReadme,
    },
    score,
  };
}

async function fetchRepoCommits(username, repoName, limit = 15) {
  try {
    const commits = await gh(`/repos/${encodeURIComponent(username)}/${encodeURIComponent(repoName)}/commits?per_page=${limit}`);
    return Array.isArray(commits)
      ? commits.map((c) => ({
          sha: c.sha ? c.sha.slice(0, 7) : "",
          message: c.commit?.message || "",
          author: c.commit?.author?.name || c.author?.login || "",
          date: c.commit?.author?.date || "",
          verified: !!c.commit?.verification?.verified,
        }))
      : [];
  } catch {
    return [];
  }
}

async function fetchRepoPulls(username, repoName, limit = 10) {
  try {
    const pulls = await gh(`/repos/${encodeURIComponent(username)}/${encodeURIComponent(repoName)}/pulls?state=all&per_page=${limit}`);
    return Array.isArray(pulls)
      ? pulls.map((p) => ({
          id: p.number,
          title: p.title,
          state: p.state,
          hasBody: !!(p.body && p.body.length > 30),
          comments: p.comments || 0,
          created_at: p.created_at,
        }))
      : [];
  } catch {
    return [];
  }
}

module.exports = { gh, fetchProfile, fetchRepos, fetchRepoCommits, fetchRepoPulls, analyze, cache, computeScore };
