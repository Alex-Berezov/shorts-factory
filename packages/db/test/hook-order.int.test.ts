import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keepDatabase, useTestDb } from "../test-support/fixture.js";

/**
 * The order the integration files of the api and the worker lean on, as
 * vitest really runs it: `useTestDb` is called first and registers its hooks
 * first, the file's own `afterAll` comes after it and still reaches the
 * database through the handle. That holds only when the `afterAll` hooks run
 * as a stack - the last registered first - which the preset asks for
 * (`sequence.hooks`, `vitest.preset.ts`); `test/vitest-preset.test.ts` holds
 * every config to that setting, this file holds vitest to its meaning.
 *
 * The check is the hook registered before the fixture: in a stack it runs
 * last, once the file has reached the database and the fixture has closed the
 * handle. Under any other order it runs first, or the file meets a closed
 * handle, and the file is red either way.
 */
const reached: string[] = [];

afterAll(() => {
  expect(reached).toEqual(["the file reached the database"]);
  expect(() => db()).toThrow("the test database is not open");
});

// The database as it is: this file writes nothing and resets nothing.
const db = useTestDb({ beforeAll, afterAll }, { prepare: keepDatabase });

afterAll(async () => {
  const rows = await db().$client<{ one: number }[]>`select 1 as one`;
  expect(rows).toEqual([{ one: 1 }]);
  reached.push("the file reached the database");
});

describe("the hooks of an integration file", () => {
  it("give the cases an open handle", async () => {
    const rows = await db().$client<{ one: number }[]>`select 1 as one`;

    expect(rows).toEqual([{ one: 1 }]);
  });
});
