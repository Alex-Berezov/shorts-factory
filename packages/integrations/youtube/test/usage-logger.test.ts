import type { UsageLogger } from "@sf/core";
import { describe, expectTypeOf, it } from "vitest";
import type { DataApiClient } from "../src/data-api.js";

/**
 * `UsageLogger` has exactly one home - `@sf/core` (D5). A local copy in this
 * package would keep `tsc` happy while the two shapes drifted apart, so the
 * assertion is on identity with the core type rather than on assignability:
 * `toEqualTypeOf` is checked by the compiler, which makes `pnpm typecheck`
 * fail as loudly as `pnpm test` does.
 */
describe("DataApiClient usage logger", () => {
  it("takes the UsageLogger of @sf/core", () => {
    expectTypeOf<
      ConstructorParameters<typeof DataApiClient>[1]
    >().toEqualTypeOf<UsageLogger>();
  });
});
