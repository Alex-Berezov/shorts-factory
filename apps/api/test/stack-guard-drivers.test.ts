import { createDb } from "@sf/db";
import {
  TEST_STACK,
  assertLocalTestPostgres,
  assertLocalTestRedis,
} from "@sf/db/test-support/stack-guard";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

/**
 * The stack guard of the integration suites against the drivers that would
 * dial the address it lets through: postgres-js under `createDb` and ioredis,
 * on one table of addresses (L-025). The guard reads a URL with `new URL`;
 * what matters is where the driver goes, so a URL the guard passes must make
 * every installed driver dial the test stack - checked on the drivers, with
 * no socket opened, rather than on a description of a driver version.
 *
 * It lives here because this package depends on both drivers and on the
 * guard; `@sf/db` has no Redis client to check against.
 */

/** Where postgres-js would connect - read from the options it parsed. */
async function postgresTarget(
  url: string,
): Promise<{ hosts: string[]; ports: number[] }> {
  const client = createDb(url, { max: 1 }).$client;
  const target = {
    hosts: [...client.options.host],
    ports: [...client.options.port],
  };
  await client.end();
  return target;
}

/** Where ioredis would connect - read from the options it parsed. */
function redisTarget(url: string): { hosts: string[]; ports: number[] } {
  const client = new Redis(url, { lazyConnect: true });
  const target = {
    hosts: [client.options.host ?? ""],
    ports: [client.options.port ?? 0],
  };
  client.disconnect();
  return target;
}

/** The authority of the IPv6 loopback in `ADDRESSES`. */
const IPV6_LOOPBACK = "[::1]:{port}";

/**
 * The hosts of `target` that are a machine other than the test stack.
 * `unresolvable` is the host a driver makes of the IPv6 loopback when it
 * cannot read the literal - postgres-js makes `[` of it, a name nothing
 * resolves, so the driver fails to connect instead of reaching another
 * machine. It is excused for that one authority only: anywhere else it is a
 * host like any other.
 */
function foreignHosts(
  target: { hosts: string[] },
  authority: string,
  unresolvable: string | null,
): string[] {
  const local: readonly string[] = TEST_STACK.hosts;
  const excused = authority === IPV6_LOOPBACK ? unresolvable : null;
  return target.hosts.filter(
    (host) => host !== excused && !local.includes(host),
  );
}

/** Whether `check` lets `url` through. */
function passes(check: (url: string) => void, url: string): boolean {
  try {
    check(url);
    return true;
  } catch {
    return false;
  }
}

/** The authority of a URL, `{port}` standing for the port of the service. */
const ADDRESSES: readonly [authority: string, verdict: "pass" | "refuse"][] = [
  ["localhost:{port}", "pass"],
  ["127.0.0.1:{port}", "pass"],
  [IPV6_LOOPBACK, "pass"],
  // The drivers keep the case `new URL` folds: not letter for letter.
  ["LOCALHOST:{port}", "refuse"],
  ["db.example.com:{port}", "refuse"],
  // `new URL` reads localhost after the last `@`; postgres-js splits at the
  // first one and dials db.example.com.
  ["db.example.com,x@localhost:{port}", "refuse"],
  // postgres-js decodes this host into the list localhost, db.example.com.
  ["localhost%2Cdb.example.com:{port}", "refuse"],
  ["x@db.example.com@localhost:{port}", "refuse"],
  ["localhost:0{port}", "refuse"],
  // No port: the default one, usually another project's server.
  ["localhost", "refuse"],
];

const SERVICES = [
  {
    name: "Postgres",
    url: (authority: string) =>
      `postgresql://sf:sf@${authority.replace("{port}", TEST_STACK.postgresPort)}/${TEST_STACK.database}`,
    check: assertLocalTestPostgres,
    port: Number(TEST_STACK.postgresPort),
    target: postgresTarget,
    unresolvable: "[",
  },
  {
    name: "Redis",
    url: (authority: string) =>
      `redis://:secret@${authority.replace("{port}", TEST_STACK.redisPort)}/${TEST_STACK.envRedisDatabase}`,
    check: assertLocalTestRedis,
    port: Number(TEST_STACK.redisPort),
    target: async (url: string) => redisTarget(url),
    unresolvable: null,
  },
] as const;

describe("the stack guard against the drivers", () => {
  for (const service of SERVICES) {
    it.each(ADDRESSES)(
      `${service.name}: %s - the guard says %s`,
      async (authority, verdict) => {
        const url = service.url(authority);

        expect(passes(service.check, url) ? "pass" : "refuse").toBe(verdict);
      },
    );

    it(`${service.name}: every address the guard passes is dialled on the test stack`, async () => {
      const passed = ADDRESSES.map(([authority]) => ({
        authority,
        url: service.url(authority),
      })).filter(({ url }) => passes(service.check, url));

      expect(passed.length).toBeGreaterThan(0);
      for (const { authority, url } of passed) {
        const target = await service.target(url);
        expect({
          url,
          foreign: foreignHosts(target, authority, service.unresolvable),
        }).toEqual({
          url,
          foreign: [],
        });
        expect({ url, ports: target.ports }).toEqual({
          url,
          ports: target.ports.map(() => service.port),
        });
      }
    });
  }

  it("refuses addresses on which new URL and postgres-js disagree", async () => {
    // The refusals above are only worth something while the driver really
    // does go elsewhere on them.
    for (const authority of [
      "db.example.com,x@localhost:{port}",
      "localhost%2Cdb.example.com:{port}",
    ]) {
      const url = SERVICES[0].url(authority);
      expect(
        foreignHosts(await postgresTarget(url), authority, "["),
        url,
      ).toContain("db.example.com");
      expect(new URL(url).hostname, url).not.toBe("db.example.com");
    }
  });
});
