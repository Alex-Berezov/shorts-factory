import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards the two properties that made `@sf/db` unusable without a database
 * (D3): importing the package must neither open a connection nor parse the
 * environment. Both are asserted through the public entry point, because that
 * is what `apps/api`, `apps/worker` and the tests import.
 */

const clientEnd = vi.fn(async () => undefined);

/** Shape `drizzle(client)` touches: it patches type parsers on the client. */
function fakeClient() {
  return {
    options: {
      parsers: {} as Record<string, unknown>,
      serializers: {} as Record<string, unknown>,
    },
    end: clientEnd,
  };
}

const postgresFactory = vi.fn(() => fakeClient());

vi.mock("postgres", () => ({ default: postgresFactory }));

const TEST_URL = "postgresql://sf:sf@localhost:5442/shorts_factory_test";

beforeEach(() => {
  postgresFactory.mockClear();
  clientEnd.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("@sf/db entry point", () => {
  it("opens no connection until createDb is called", async () => {
    const { createDb } = await import("../src/index.js");

    expect(postgresFactory).toHaveBeenCalledTimes(0);

    createDb(TEST_URL);

    expect(postgresFactory).toHaveBeenCalledTimes(1);
    expect(postgresFactory).toHaveBeenCalledWith(TEST_URL, {
      max: 10,
      connect_timeout: 10,
    });
  });

  it("imports without DATABASE_URL in the environment", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.resetModules();

    await expect(import("../src/index.js")).resolves.toBeDefined();
  });

  it("closes the client the factory opened", async () => {
    const { closeDb, createDb } = await import("../src/index.js");

    await closeDb(createDb(TEST_URL));

    expect(clientEnd).toHaveBeenCalledTimes(1);
  });
});
