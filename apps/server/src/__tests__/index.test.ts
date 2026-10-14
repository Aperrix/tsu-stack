import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The entrypoint starts the HTTP listener on import; the tests only exercise `app`.
vi.mock("@hono/node-server", () => {
  return { serve: vi.fn() };
});

async function loadApp(options: { enableDocs: boolean }) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:1/tsu-stack-test");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-at-least-32-characters-long");
  vi.stubEnv("VITE_SERVER_URL", "http://localhost:5000/server");
  vi.stubEnv("VITE_WEB_URL", "http://localhost:3000/web");
  vi.stubEnv("ENABLE_OPEN_API_DOCS", String(options.enableDocs));
  return import("#@/index");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAPI documentation", () => {
  it.each([
    "/server/docs",
    "/server/docs/spec.json",
    "/server/auth/open-api/generate-schema",
    "/server/auth/reference"
  ])("does not serve %s when ENABLE_OPEN_API_DOCS is false", async (path) => {
    const { app } = await loadApp({ enableDocs: false });

    expect((await app.request(path)).status).toBe(404);
  });

  it("keeps serving the API routes when the documentation is disabled", async () => {
    const { app } = await loadApp({ enableDocs: false });

    expect((await app.request("/server/health/live")).status).toBe(200);
  });

  it.each(["/server/docs", "/server/docs/spec.json", "/server/auth/open-api/generate-schema"])(
    "serves %s when ENABLE_OPEN_API_DOCS is true",
    async (path) => {
      const { app } = await loadApp({ enableDocs: true });

      expect((await app.request(path)).status).toBe(200);
    }
  );
});
