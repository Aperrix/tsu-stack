import { type WideEvent } from "evlog";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { honoLogIngestionMiddleware } from "#@/server/hono/middleware";
import { initLogger } from "#@/server/index";

const events: WideEvent[] = [];

beforeAll(() => {
  initLogger({
    drain: (context) => {
      events.push(context.event);
    },
    pretty: false,
    silent: true
  });
});

beforeEach(() => {
  events.length = 0;
});

function createApp() {
  const app = new Hono();
  app.post("/ingest", honoLogIngestionMiddleware({ maxPayloadBytes: 1024 }));
  app.onError((error, c) =>
    error instanceof HTTPException ? error.getResponse() : c.text("error", 500)
  );
  return app;
}

function clientEvent(extra: Record<string, string> = {}) {
  return {
    event: {
      environment: "test",
      level: "info",
      service: "web__client",
      timestamp: "2026-01-01T00:00:00.000Z",
      ...extra
    }
  };
}

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return createApp().request("/ingest", {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST"
  });
}

describe("honoLogIngestionMiddleware", () => {
  it("emits the events of a valid batch as client events", async () => {
    const response = await post(JSON.stringify([clientEvent(), clientEvent()]));

    expect(response.status).toBe(204);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ service: "web__client", source: "client" });
  });

  it("rejects a body whose declared length is over the limit", async () => {
    const response = await post("[]", { "content-length": "4096" });

    expect(response.status).toBe(413);
    expect(events).toHaveLength(0);
  });

  it("rejects a chunked body over the limit, which carries no content length", async () => {
    const chunk = new TextEncoder().encode(JSON.stringify([clientEvent({ pad: "A".repeat(600) })]));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      }
    });

    // `duplex` is required by the runtime for streamed bodies but missing from the DOM typings.
    const init: RequestInit & { duplex: "half" } = {
      body: stream,
      duplex: "half",
      headers: { "content-type": "application/json" },
      method: "POST"
    };

    const response = await createApp().request(new Request("http://localhost/ingest", init));

    expect(response.status).toBe(413);
    expect(events).toHaveLength(0);
  });

  it("rejects the content types a cross-site form can send without a preflight", async () => {
    const response = await post(JSON.stringify([clientEvent()]), { "content-type": "text/plain" });

    expect(response.status).toBe(415);
    expect(events).toHaveLength(0);
  });

  it("ignores batches over the event limit", async () => {
    const response = await post(JSON.stringify(Array.from({ length: 51 }, () => clientEvent())), {
      "content-length": "100"
    });

    expect(response.status).toBe(204);
    expect(events).toHaveLength(0);
  });

  it("rejects invalid JSON", async () => {
    expect((await post("{not json")).status).toBe(400);
  });
});
