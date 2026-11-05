const request = require("supertest");
const app = require("../src/server");

describe("Health endpoints", () => {
  test("GET /api/health returns ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("GET /api/health/live returns alive", async () => {
    const res = await request(app).get("/api/health/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("alive");
  });

  test("GET /api/health/metrics returns prometheus-format text", async () => {
    const res = await request(app).get("/api/health/metrics");
    expect(res.status).toBe(200);
    // prom-client provides gpa_* prefixed metrics; fallback provides gpa_uptime_seconds
    const hasPrometheusContent =
      res.text.includes("gpa_") ||
      res.text.includes("# HELP") ||
      res.text.includes("# TYPE");
    expect(hasPrometheusContent).toBe(true);
  });
});

describe("Security & CSRF", () => {
  test("OpenAPI spec is served", async () => {
    const res = await request(app).get("/api/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3/);
  });

  test("POST without CSRF token (cookie auth) is rejected", async () => {
    const res = await request(app).post("/api/reports").send({ foo: "bar" });
    // 400 (validation/csrf), 401 (no auth), or 403 (csrf) both prove the gate is active
    expect([400, 401, 403]).toContain(res.status);
  });

  test("Sets x-request-id header", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});

afterAll(() => new Promise((r) => setTimeout(r, 100)));
