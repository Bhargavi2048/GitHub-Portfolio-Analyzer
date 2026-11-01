require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const compression = require("compression");
const cookieParser = require("cookie-parser");

const { validateEnv } = require("./config/env");
const logger = require("./utils/logger");

validateEnv();

const connectDB = require("./config/db");
const errorHandler = require("./middleware/errorHandler");
const requestId = require("./middleware/requestId");
const securityHeaders = require("./middleware/securityHeaders");
const csrf = require("./middleware/csrf");
const { apiLimiter, uploadLimiter, aiLimiter } = require("./middleware/rateLimit");
const audit = require("./services/audit.service");

const authRoutes = require("./routes/auth.routes");
const analyzeRoutes = require("./routes/analyze.routes");
const aiRoutes = require("./routes/ai.routes");
const reportRoutes = require("./routes/report.routes");
const historyRoutes = require("./routes/history.routes");
const exportRoutes = require("./routes/export.routes");
const githubProxyRoutes = require("./routes/githubProxy.routes");
const resumeRoutes = require("./routes/resume.routes");
const discoverRoutes = require("./routes/discover.routes");
const publicRoutes = require("./routes/public.routes");
const healthRoutes = require("./routes/health.routes");
const adminRoutes = require("./routes/admin.routes");
const docsRoutes = require("./routes/docs.routes");
const badgeRoutes = require("./routes/badge.routes");
const leaderboardRoutes = require("./routes/leaderboard.routes");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(requestId);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  hsts: process.env.NODE_ENV === "production" ? { maxAge: 15552000, includeSubDomains: true, preload: true } : false,
}));
app.use(securityHeaders);
app.use(cors({
  origin: (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim()),
  credentials: true,
  exposedHeaders: ["x-request-id"],
}));
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());
app.use(csrf.issueToken);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev", {
  skip: (req) => req.path.startsWith("/api/health"),
}));

app.use("/api/badge", badgeRoutes);
app.use("/api/v1/badge", badgeRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/docs", docsRoutes);

app.use("/api", apiLimiter);
app.use("/api", csrf.verify);
app.use("/api", audit.middleware("api.request"));

function mount(base) {
  app.use(`${base}/auth`, authRoutes);
  app.use(`${base}/analyze`, analyzeRoutes);
  app.use(`${base}/ai`, aiLimiter, aiRoutes);
  app.use(`${base}/reports`, reportRoutes);
  app.use(`${base}/history`, historyRoutes);
  app.use(`${base}/export`, exportRoutes);
  app.use(`${base}/resume`, uploadLimiter, resumeRoutes);
  app.use(`${base}/discover`, discoverRoutes);
  app.use(`${base}/public`, publicRoutes);
  app.use(`${base}/github`, githubProxyRoutes);
  app.use(`${base}/admin`, adminRoutes);
  app.use(`${base}/leaderboard`, leaderboardRoutes);
}
mount("/api");
mount("/api/v1");

app.get("/api/health-legacy", (_req, res) =>
  res.json({ status: "ok", server: "running", ts: Date.now(), version: require("../package.json").version })
);

app.get("/p/:username", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "portfolio.html"))
);
app.get("/leaderboard", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "leaderboard.html"))
);

app.use(express.static(path.join(__dirname, "..", "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  },
  etag: true,
}));
app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use(errorHandler);

process.on("unhandledRejection", (e) => logger.error("unhandledRejection", { msg: e?.message, stack: e?.stack }));
process.on("uncaughtException", (e) => logger.error("uncaughtException", { msg: e?.message, stack: e?.stack }));

const PORT = process.env.PORT || 5000;

let server;
async function start() {
  await connectDB();
  server = app.listen(PORT, () => {
    logger.info(`🚀 GitHub Portfolio Analyzer running at http://localhost:${PORT}`);
    try {
      const { startWeeklyDigest } = require("./services/weeklyDigest.service");
      startWeeklyDigest();
    } catch (e) {
      logger.warn("weekly digest not started", { msg: e.message });
    }
  });
}

function shutdown(signal) {
  logger.info(`received ${signal}, shutting down`);
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
["SIGTERM", "SIGINT"].forEach((s) => process.on(s, () => shutdown(s)));

if (require.main === module) start().catch(e => { console.error(e); process.exit(1); });

module.exports = app;
