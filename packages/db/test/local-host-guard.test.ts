import { describe, expect, it } from "vitest";
import { assertLocalHost } from "./local-host-guard.js";

/**
 * `resetTestDatabase` drops schemas, so the name of the database is not the
 * only thing that has to be checked: CI (E0-12) and a future VPS can host a
 * database called `shorts_factory_test` as well. A unit test on purpose - the
 * guard must be checked by `pnpm test`, not only with Compose up.
 */
describe("integration test database guard", () => {
  it("refuses a DATABASE_URL pointing at another machine", () => {
    expect(() =>
      assertLocalHost(
        "postgresql://sf:sf@db.example.com:5432/shorts_factory_test",
      ),
    ).toThrow(/db\.example\.com/);
  });

  it("allows the local Postgres of infra/docker-compose.yml", () => {
    expect(() =>
      assertLocalHost("postgresql://sf:sf@localhost:5442/shorts_factory_test"),
    ).not.toThrow();
    expect(() =>
      assertLocalHost("postgresql://sf:sf@127.0.0.1:5442/shorts_factory_test"),
    ).not.toThrow();
    expect(() =>
      assertLocalHost("postgresql://sf:sf@[::1]:5442/shorts_factory_test"),
    ).not.toThrow();
  });
});
