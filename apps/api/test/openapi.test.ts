import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppInstance } from "../src/app.js";
import { AUTH_HEADER, buildTestApp } from "./helpers.js";

/**
 * Only what the test asserts on: the point is that the Zod schema of a route
 * reached the document, not that the whole OpenAPI shape is re-typed here.
 */
const DocumentSchema = z.object({
  openapi: z.string(),
  info: z.object({ version: z.string() }),
  paths: z.record(
    z.object({
      get: z
        .object({
          responses: z.record(
            z.object({
              content: z
                .object({
                  "application/json": z.object({
                    schema: z.record(z.unknown()),
                  }),
                })
                .optional(),
            }),
          ),
        })
        .optional(),
    }),
  ),
});

describe("OpenAPI document", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function fetchDocument(): Promise<z.infer<typeof DocumentSchema>> {
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
    return DocumentSchema.parse(JSON.parse(res.payload));
  }

  it("documents the response schema of /health, not just its path", async () => {
    const document = await fetchDocument();
    const health = document.paths["/health"]?.get;

    expect(health).toBeDefined();
    // Without the json schema transform the paths are listed with no shape at
    // all - a document that looks alive and describes nothing.
    expect(
      health?.responses["200"]?.content?.["application/json"].schema,
    ).toMatchObject({
      properties: { status: { enum: ["ok", "degraded"] } },
    });
    expect(health?.responses["503"]).toBeDefined();
  });

  it("documents /system/status", async () => {
    const document = await fetchDocument();

    expect(document.paths["/system/status"]?.get).toBeDefined();
  });

  it("declares the version of the build it was served by", async () => {
    // The same instance reports `APP_VERSION` through /system/status; a
    // hardcoded number here makes the generated client of E0-07 believe a
    // version this build never was.
    const document = await fetchDocument();

    expect(document.info.version).toBe("0.0.1-test");
  });

  it("says the version is unknown rather than inventing one", async () => {
    const anonymous = buildTestApp({
      buildInfo: { version: null, commit: null },
    });
    await anonymous.ready();

    try {
      const res = await anonymous.inject({
        method: "GET",
        url: "/openapi.json",
        headers: { authorization: AUTH_HEADER },
      });

      expect(DocumentSchema.parse(JSON.parse(res.payload)).info.version).toBe(
        "unknown",
      );
    } finally {
      await anonymous.close();
    }
  });

  it("does not document the route that serves the document", async () => {
    const document = await fetchDocument();

    expect(document.paths["/openapi.json"]).toBeUndefined();
  });

  it("serves the browsable documentation", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/docs/",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});
