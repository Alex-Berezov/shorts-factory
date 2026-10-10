import { describe, expect, it } from "vitest";

import { EnvSchema } from "../src/schema.js";
import SERVER_SECRET_KEYS from "../src/server-secrets.json" with {
  type: "json",
};

/**
 * Keys of the schema that are not secrets: what they hold is printed on
 * `/system`, set in a compose file in the clear or is a number. Spelled out
 * here, so a new key has to be put on one side or the other.
 */
const PUBLIC_KEYS = [
  "NODE_ENV",
  "MEDIA_DIR",
  "APP_VERSION",
  "GIT_COMMIT",
  "API_PORT",
  "WEB_PORT",
  "LOG_LEVEL",
  "WORKER_CONCURRENCY",
  "GOOGLE_OAUTH_REDIRECT_URL",
  "YT_UNITS_DAILY_SOFT_CAP",
  "GEMINI_DAILY_BUDGET_USD",
  "TTS_MONTHLY_BUDGET_USD",
];

describe("server secrets", () => {
  const schemaKeys = Object.keys(EnvSchema.shape);

  it("names only keys of the schema, each once", () => {
    for (const key of SERVER_SECRET_KEYS) {
      expect(schemaKeys).toContain(key);
    }
    expect(new Set(SERVER_SECRET_KEYS).size).toBe(SERVER_SECRET_KEYS.length);
  });

  it("classifies every key of the schema as secret or public", () => {
    expect([...SERVER_SECRET_KEYS, ...PUBLIC_KEYS].sort()).toEqual(
      [...schemaKeys].sort(),
    );
  });

  it("counts the password, the connection strings and the api keys as secrets", () => {
    expect(SERVER_SECRET_KEYS).toEqual(
      expect.arrayContaining([
        "ADMIN_PASSWORD",
        "DATABASE_URL",
        "REDIS_URL",
        "TOKEN_ENCRYPTION_KEY",
        "GOOGLE_CLIENT_SECRET",
        "YOUTUBE_API_KEY",
        "GEMINI_API_KEY",
      ]),
    );
  });
});
