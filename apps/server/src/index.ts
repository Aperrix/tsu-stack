import { hostname } from "node:os";
import { join } from "node:path/posix";

import { serve } from "@hono/node-server";
import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { experimental_RethrowHandlerPlugin as RethrowHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { type ContentfulStatusCode } from "hono/utils/http-status";

import { createContext } from "@tsu-stack/api/lib/context/hono/create-context";
import { appRouter } from "@tsu-stack/api/routers/index";
import { auth, generateAuthOpenApiSchema } from "@tsu-stack/auth/index";
import { migrateDatabase } from "@tsu-stack/db";
import { ENV_SERVER } from "@tsu-stack/env/server/env";
import {
  type RequestLogger,
  createRequestLogger,
  isEvlogError,
  log,
  parseError
} from "@tsu-stack/logger/server";
import {
  honoLogIngestionMiddleware,
  honoLoggerMiddleware,
  type HonoLogVariables
} from "@tsu-stack/logger/server/hono/middleware";

import "#@/shared/lib/logger";

const serverHostname = hostname();

export const app = new Hono<HonoLogVariables>().basePath(
  new URL(ENV_SERVER.VITE_SERVER_URL).pathname
);

app.use(
  "/*",
  cors({
    allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    origin: [new URL(ENV_SERVER.VITE_WEB_URL).origin]
  })
);

app.use(
  "/*",
  honoLoggerMiddleware({
    exclude: ["**/health/**", "**/_logs/ingest"],
    enrich: (ctx) => {
      ctx.event.hostname = serverHostname;
    }
  })
);

app.post("/_logs/ingest", honoLogIngestionMiddleware());

app.onError((error, c) => {
  const requestLog = c.get("log");
  if (requestLog) {
    requestLog.error(error);
  } else {
    log.error({ event: "hono_global_error", error });
  }

  // Only errors thrown on purpose carry a message meant for clients. Anything else (database,
  // network, library errors) can expose SQL, bound parameters or internal hosts: log it above only.
  if (error instanceof HTTPException) {
    return c.json({ message: error.message }, error.status);
  }

  if (!isEvlogError(error)) {
    return c.json({ message: "Internal Server Error" }, 500);
  }

  const parsed = parseError(error);

  return c.json(
    {
      message: parsed.message,
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.why ? { why: parsed.why } : {}),
      ...(parsed.fix ? { fix: parsed.fix } : {}),
      ...(parsed.link ? { link: parsed.link } : {})
    },
    parsed.status as ContentfulStatusCode
  );
});

/**
 * Disable /auth/reference calls as they are handled by the OpenAPI generator
 * @see https://better-auth.com/docs/plugins/open-api#configuration
 */
app.on(["POST", "GET"], "/auth/reference", (c) =>
  ENV_SERVER.ENABLE_OPEN_API_DOCS
    ? c.redirect(`${ENV_SERVER.VITE_SERVER_URL}/docs#auth-api-reference`, 301)
    : c.notFound()
);

app.get("/auth/open-api/generate-schema", async (c) => {
  if (!ENV_SERVER.ENABLE_OPEN_API_DOCS) {
    return c.notFound();
  }

  // IMPORTANT: Need to explicitly do this instead of relying on the OpenAPI plugin's built-in schema generation
  // Otherwise, it will 404 with the /auth/* endpoint
  const schema = await generateAuthOpenApiSchema();
  return c.json(schema);
});

app.on(["POST", "GET"], "/auth/*", async (c) => auth.handler(c.req.raw));

export const openApiHandler = new OpenAPIHandler(appRouter, {
  interceptors: [
    onError((error, { context }) => {
      context.logger.set({ handler: "openapi" });
      context.logger.error(error instanceof Error ? error : String(error));
    })
  ],
  plugins: [
    new SmartCoercionPlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()]
    }),
    ...(ENV_SERVER.ENABLE_OPEN_API_DOCS
      ? [
          new OpenAPIReferencePlugin({
            docsConfig: () => {
              const apiBasePath = new URL(ENV_SERVER.VITE_SERVER_URL).pathname;
              return {
                content: undefined,
                metaData: {
                  description: "Documentation for the @tsu-stack/server API.",
                  title: "@tsu-stack/server API Documentation"
                },
                sources: [
                  {
                    title: "API Reference",
                    url: join(apiBasePath, "docs", "spec.json")
                  },
                  {
                    title: "Auth API Reference",
                    url: join(apiBasePath, "auth", "open-api", "generate-schema")
                  }
                ],
                theme: "deepSpace"
              };
            },
            docsPath: "/docs",
            schemaConverters: [new ZodToJsonSchemaConverter()],
            specGenerateOptions: {
              components: {
                securitySchemes: {
                  authCookie: {
                    description: `**(optional)** Session cookie from signing-in, required for protected endpoints [View Auth Reference](${ENV_SERVER.VITE_SERVER_URL}/docs#auth-api-reference)`,
                    in: "cookie",
                    name: "better_auth.session_token",
                    type: "apiKey"
                  }
                }
              },
              info: {
                description: `This is the API for @tsu-stack/server.\n## Usage\nFor authentication, you can sign in via the \`/sign-in\` endpoint in [the Auth Reference](${ENV_SERVER.VITE_SERVER_URL}/docs#auth-api-reference). Include the session cookie in subsequent requests to access protected endpoints.\n## Resources\n - [Official Website](${ENV_SERVER.VITE_WEB_URL})\n - [Auth API Reference](${ENV_SERVER.VITE_SERVER_URL}/docs#auth-api-reference)`,
                title: "@tsu-stack/server API",
                version: ENV_SERVER.SOURCE_COMMIT
              },
              servers: [
                {
                  description: "Primary API Server",
                  url: ENV_SERVER.VITE_SERVER_URL
                }
              ]
            },
            specPath: "/docs/spec.json"
          })
        ]
      : []),
    new RethrowHandlerPlugin({
      filter: (error) => !(error instanceof ORPCError)
    })
  ]
});

export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error, { context }) => {
      context.logger.set({ handler: "rpc" });
      context.logger.error(error instanceof Error ? error : String(error));
    })
  ],
  plugins: []
});

app.use("/*", async (c, next) => {
  // Routes excluded from request logging (health checks) have no request logger.
  const requestLog: RequestLogger | undefined = c.get("log");
  const context = await createContext({
    context: c,
    logger: requestLog ?? createRequestLogger({ method: c.req.method, path: c.req.path })
  });

  // oRPC at /rpc/*
  const rpcResult = await rpcHandler.handle(c.req.raw, {
    context,
    prefix: join(new URL(ENV_SERVER.VITE_SERVER_URL).pathname, "rpc") as `/${string}`
  });

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response);
  }

  // OpenAPI REST API at /* (and the docs at /docs/* when OpenAPIReferencePlugin is registered)
  const openApiResult = await openApiHandler.handle(c.req.raw, {
    context,
    prefix: new URL(ENV_SERVER.VITE_SERVER_URL).pathname as `/${string}`
  });

  if (openApiResult.matched) {
    return c.newResponse(openApiResult.response.body, openApiResult.response);
  }

  await next();
});

void (async () => {
  await migrateDatabase();

  serve(
    {
      fetch: app.fetch,
      port: 5000
    },
    (info) => {
      log.info(
        "server",
        `Server is running on http://localhost:${info.port}${new URL(ENV_SERVER.VITE_SERVER_URL).pathname}`
      );
    }
  );
})();
