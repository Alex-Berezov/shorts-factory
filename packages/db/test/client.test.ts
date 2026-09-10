import { describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";

const URL = "postgres://sf:sf@localhost:5442/shorts_factory_test";

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
});
