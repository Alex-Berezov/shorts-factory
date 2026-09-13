import type { Provider } from "@sf/core";
import { describe, expectTypeOf, it } from "vitest";
import type { apiUsageLogRepo } from "../src/repos/api-usage-log.js";

/**
 * The seal of the narrowing that closed the TECH_DEBT entry of 06.09.2026: the
 * column is free `text`, so nothing at runtime tells `"youtube-data"` from
 * `"youtube_data"` - the aggregate simply answers 0 and the budget guard of
 * E0-09 lets the call through. Only the compiler can refuse the typo, and only
 * while every entry point of the repository asks for a `Provider`.
 *
 * These are compiler assertions, so they fail in `pnpm typecheck` as well as
 * in `pnpm test` (`test` is part of the tsconfig `include` of this package).
 */
describe("apiUsageLogRepo provider", () => {
  it("is a Provider in the aggregate", () => {
    expectTypeOf<
      Parameters<typeof apiUsageLogRepo.sumUsage>[1]["providers"]
    >().toEqualTypeOf<readonly Provider[]>();
  });

  it("is a Provider in the inserted entry", () => {
    expectTypeOf<
      Parameters<typeof apiUsageLogRepo.insert>[1]["provider"]
    >().toEqualTypeOf<Provider>();
  });
});
