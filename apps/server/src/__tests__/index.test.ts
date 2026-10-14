import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type * as DbModule from "@tsu-stack/db";

// The entrypoint starts the HTTP listener on import; the tests only exercise `app`.
vi.mock("@hono/node-server", () => {
  return { serve: vi.fn() };
});

vi.mock("@tsu-stack/db", async (importOriginal) => {
  const original = await importOriginal<typeof DbModule>();
  return { ...original, checkIsDbReady: vi.fn().mockResolvedValue(false) };
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

describe("error responses", () => {
  it("masks the message of unexpected errors", async () => {
    const { app } = await loadApp({ enableDocs: false });
    app.get("/boom", () => {
      throw new Error(
        'Failed query: select * from "user" where "email" = $1\nparams: victim@example.com'
      );
    });

    const response = await app.request("/server/boom");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "Internal Server Error" });
  });

  it("keeps the guidance of structured errors", async () => {
    const { app } = await loadApp({ enableDocs: false });
    const { createError } = await import("@tsu-stack/logger/server");
    app.get("/payment", () => {
      throw createError({
        fix: "Try another card",
        message: "Payment failed",
        status: 402,
        why: "Card declined"
      });
    });

    const response = await app.request("/server/payment");

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      fix: "Try another card",
      message: "Payment failed",
      why: "Card declined"
    });
  });

  it("keeps the status and message of HTTP exceptions", async () => {
    const { app } = await loadApp({ enableDocs: false });
    app.get("/teapot", () => {
      throw new HTTPException(418, { message: "Short and stout" });
    });

    const response = await app.request("/server/teapot");

    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({ message: "Short and stout" });
  });

  it("reports an unavailable database on the readiness check with a 503", async () => {
    const { app } = await loadApp({ enableDocs: false });

    const response = await app.request("/server/health/ready");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { checks: { database: { status: "unhealthy" } } }
    });
  });
});
