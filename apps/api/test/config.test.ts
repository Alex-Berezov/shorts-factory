import { env } from "@sf/config";
import { describe, expect, it } from "vitest";

/**
 * Canary: without `setupFiles` loading `.env.test`, importing `@sf/config`
 * throws on schema validation (DATABASE_URL/REDIS_URL are required) - this
 * test would fail to even run, catching a broken `.env.test` -> config wire.
 */
describe("@sf/config env wiring", () => {
  it("loads DATABASE_URL and REDIS_URL from .env.test", () => {
    expect(env.DATABASE_URL).toBe(
      "postgresql://sf:sf@localhost:5432/shorts_factory_test",
    );
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
  });
});
