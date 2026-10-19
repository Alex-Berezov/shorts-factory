import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientOptions, createDb } from "../src/client.js";

const URL = "postgres://sf:sf@localhost:5442/shorts_factory_test";

/**
 * The driver itself, behind a spy that only records its calls: the cases
 * below read the options on the client it returns, and the last one checks
 * what `createDb` handed it.
 */
const driver = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("postgres", async (importOriginal) => {
  const actual = await importOriginal<{
    default: (...args: unknown[]) => unknown;
  }>();
  const spy = (...args: unknown[]): unknown => {
    driver.calls.push(args);
    return actual.default(...args);
  };
  return { ...actual, default: spy };
});

beforeEach(() => {
  driver.calls = [];
});

/**
 * Options of the postgres-js client, asserted on the client itself rather than
 * on the argument we passed: what matters is that the driver received them.
 * Creating a client opens no socket, so this is a unit test.
 */
describe("createDb", () => {
  it("bounds how long a connection attempt may take", () => {
    // Without it the wait is whatever the operating system decides - minutes
    // on a host that drops packets - and a migration or a worker job has no
    // deadline of its own to fall back on (docs/TECH_DEBT.md, 08.09.2026).
    expect(createDb(URL).$client.options.connect_timeout).toBe(10);
  });

  it("lets a caller choose a shorter one", () => {
    expect(
      createDb(URL, { connectTimeoutSec: 2 }).$client.options.connect_timeout,
    ).toBe(2);
  });

  it("keeps the pool size a caller asked for", () => {
    expect(createDb(URL, { max: 2 }).$client.options.max).toBe(2);
  });

  it.each([
    ["the defaults", undefined],
    ["options of a caller", { max: 3, connectTimeoutSec: 4 }],
  ])(
    "hands the driver exactly the options every client of the package shares, with %s",
    (_name, opts) => {
      // The raw client of the test fixture opens with `clientOptions` too;
      // a bound or a default set here and not there would split the two.
      createDb(URL, opts);
      expect(driver.calls).toHaveLength(1);
      expect(driver.calls[0]).toEqual([URL, clientOptions(opts)]);
    },
  );
});
