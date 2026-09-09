import { HEALTH_ANSWER_STATUSES } from "@sf/contracts";
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
  components: z.object({ schemas: z.record(z.unknown()) }).optional(),
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

  it("names the error envelope in the components of the document", async () => {
    // Without a named component the envelope is either absent - a generated
    // client types failures by hand - or inlined once per status, which is
    // the same shape under a dozen names.
    const document = await fetchDocument();
    const schemas = document.components?.schemas ?? {};

    expect(Object.keys(schemas)).not.toHaveLength(0);
    expect(schemas.ErrorBody).toMatchObject({
      properties: {
        error: {
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            requestId: { type: "string" },
          },
          required: ["code", "message", "requestId"],
        },
      },
    });
  });

  it.each(["/health", "/system/status"])(
    "declares the failures of %s with that one envelope",
    async (path) => {
      const document = await fetchDocument();
      const responses = document.paths[path]?.get?.responses ?? {};

      // Wildcards rather than a list: the error handler answers with the
      // statuses of the whole class - 401 here, 429 for a budget failure, 414
      // for a url the router refused.
      for (const statusClass of ["4XX", "5XX"]) {
        expect(
          responses[statusClass]?.content?.["application/json"].schema,
        ).toEqual({ $ref: "#/components/schemas/ErrorBody" });
      }
    },
  );

  it("answers /health on the statuses the contract names, and on no others", async () => {
    // The one place both ends of this route agree: `@sf/api-client` reads the
    // same list to tell an answer of `/health` from a failure of it. A status
    // the route learned to answer with and the contract does not name would
    // reach the client as a contract failure - on the card an operator looks
    // at during the incident that produced it.
    const document = await fetchDocument();
    const responses = document.paths["/health"]?.get?.responses ?? {};
    const exact = Object.keys(responses)
      .filter((status) => /^\d+$/.test(status))
      .sort();

    expect(exact).toEqual([...HEALTH_ANSWER_STATUSES].map(String).sort());
  });

  it("keeps both shapes on the 503 of /health", async () => {
    // The wildcard covers the class, but this status carries `{status}` as
    // well: an exact key that lost to the wildcard would document - and
    // serialize - the wrong body on the one route a healthcheck reads, and an
    // exact key that pushed the wildcard out would answer a failure on that
    // status with the health shape, which fails to serialize at all.
    const document = await fetchDocument();
    const health = document.paths["/health"]?.get;

    expect(
      health?.responses["503"]?.content?.["application/json"].schema,
    ).toMatchObject({
      anyOf: [
        { properties: { status: { enum: ["ok", "degraded"] } } },
        { $ref: "#/components/schemas/ErrorBody" },
      ],
    });
  });

  it("documents /system/status", async () => {
    const document = await fetchDocument();

    expect(document.paths["/system/status"]?.get).toBeDefined();
  });

  it("declares the version of the build it was served by", async () => {
    // The same instance reports `APP_VERSION` through /system/status; a
    // hardcoded number here would make a client generated from this document
    // believe a version this build never was.
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
