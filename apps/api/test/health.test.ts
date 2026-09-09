import { HealthResponseSchema } from "@sf/contracts";
import { closeDb, createDb } from "@sf/db";
import { describe, expect, it } from "vitest";
import { createHealthProbes } from "../src/lib/health.js";
import { AUTH_HEADER, buildTestApp } from "./helpers.js";

/** A port nothing listens on, so the probe fails instead of hanging on DNS. */
const CLOSED_DB_URL = "postgres://sf:sf@127.0.0.1:1/nowhere";

async function healthOf(report: {
  db: "up" | "down";
  redis: "up" | "down";
}): Promise<{ statusCode: number; status: string }> {
  const app = buildTestApp({ report });
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    return {
      statusCode: res.statusCode,
      status: HealthResponseSchema.parse(JSON.parse(res.payload)).status,
    };
  } finally {
    await app.close();
  }
}

describe("GET /health", () => {
  it("answers 200 while both dependencies answer", async () => {
    expect(await healthOf({ db: "up", redis: "up" })).toEqual({
      statusCode: 200,
      status: "ok",
    });
  });

  it("answers 503 when the database is down", async () => {
    // The status code carries the verdict on its own: a container healthcheck
    // and `depends_on` in Compose do not read the body.
    expect(await healthOf({ db: "down", redis: "up" })).toEqual({
      statusCode: 503,
      status: "degraded",
    });
  });

  it("answers 503 when Redis is down", async () => {
    expect(await healthOf({ db: "up", redis: "down" })).toEqual({
      statusCode: 503,
      status: "degraded",
    });
  });

  it("answers 503 when both are down", async () => {
    expect(await healthOf({ db: "down", redis: "down" })).toEqual({
      statusCode: 503,
      status: "degraded",
    });
  });

  it("tells nothing about the build or the dependencies", async () => {
    const app = buildTestApp({
      buildInfo: { version: "9.9.9-secret", commit: "deadbee" },
      report: { db: "down", redis: "up" },
    });
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/health" });

      expect(res.payload).not.toContain("9.9.9-secret");
      expect(res.payload).not.toContain("deadbee");
      expect(res.payload).not.toContain("db");
    } finally {
      await app.close();
    }
  });
});

describe("GET /system/status", () => {
  it("reports the build, the uptime and both checks", async () => {
    const app = buildTestApp({
      buildInfo: { version: "1.2.3", commit: "abc1234" },
      report: { db: "up", redis: "down" },
    });
    await app.ready();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/system/status",
        headers: { authorization: AUTH_HEADER },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toMatchObject({
        build: { version: "1.2.3", commit: "abc1234" },
        checks: { db: "up", redis: "down" },
      });
    } finally {
      await app.close();
    }
  });

  it("reports an unknown build as null rather than inventing a version", async () => {
    const app = buildTestApp({ buildInfo: { version: null, commit: null } });
    await app.ready();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/system/status",
        headers: { authorization: AUTH_HEADER },
      });

      expect(JSON.parse(res.payload)).toMatchObject({
        build: { version: null, commit: null },
      });
    } finally {
      await app.close();
    }
  });
});

describe("createHealthProbes", () => {
  it("reports a dependency that never answers as down", async () => {
    const db = createDb(CLOSED_DB_URL);
    const probes = createHealthProbes({
      db,
      // A socket that is open but silent never settles the promise; without a
      // deadline this call - and with it /health - would never return.
      redis: { ping: () => new Promise<string>(() => {}) },
      timeoutMs: 50,
    });

    try {
      expect(await probes.check()).toEqual({ db: "down", redis: "down" });
    } finally {
      await closeDb(db);
    }
  });
});
