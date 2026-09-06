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
      "postgresql://sf:sf@localhost:5442/shorts_factory_test",
    );
    expect(env.REDIS_URL).toBe("redis://localhost:6389/1");
  });

  it("purges schema keys absent from .env.test instead of leaking the shell", () => {
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });
});
