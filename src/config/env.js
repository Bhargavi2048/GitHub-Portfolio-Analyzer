const logger = require("../utils/logger");

const schema = {
  required: ["JWT_SECRET"],
  recommended: [
    "JWT_REFRESH_SECRET", "GITHUB_TOKEN", "GEMINI_API_KEY", "OPENAI_API_KEY",
    "CORS_ORIGIN", "REDIS_URL", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
    "SMTP_HOST", "SENTRY_DSN",
  ],
  defaults: {
    PORT: "5000",
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    RATE_LIMIT_WINDOW_MS: "60000",
    RATE_LIMIT_MAX: "120",
    CACHE_TTL_SECONDS: "300",
    SQLITE_PATH: "./data/gpa.db",
  },
};

function validateEnv() {
  for (const [k, v] of Object.entries(schema.defaults)) {
    if (!process.env[k]) process.env[k] = v;
  }
  const missingRequired = schema.required.filter((k) => !process.env[k]);
  const missingRecommended = schema.recommended.filter((k) => !process.env[k]);

  if (missingRequired.length) {
    if (process.env.NODE_ENV === "production") {
      logger.error("FATAL: missing required env vars", { vars: missingRequired });
      process.exit(1);
    }
    logger.warn("Missing REQUIRED env vars (dev fallback used)", { vars: missingRequired });
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = "dev-only-insecure-secret-change-me";
  }
  if (missingRecommended.length) {
    logger.info("Missing optional env vars (features may be limited)", { vars: missingRecommended });
  }
  return { ok: missingRequired.length === 0 };
}

module.exports = { validateEnv, schema };
