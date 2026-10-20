import { type Server, type Socket, connect, createServer } from "node:net";
import { testDatabaseUrl } from "./fixture.js";

/**
 * A TCP relay in front of the test Postgres, for the integration suites that
 * need a database that misbehaves on the wire rather than one that refuses
 * a query. Only integration files import it: the address it relays to is the
 * test database of the environment, passed through the same guard as the
 * fixture (`testDatabaseUrl`, `assertLocalTestPostgres`).
 */
export interface Relay {
  /** The test database URL with the host and the port of the relay. */
  readonly url: string;
  /**
   * Pulls the relay out: stops listening and drops every relayed socket, so
   * the query in flight loses its socket and the client's next reconnect is
   * refused - the "database went away" a caller can meet.
   */
  cut(): Promise<void>;
  /**
   * Goes silent without closing anything: every socket stays open and the
   * bytes written to either end are dropped instead of relayed - a half-open
   * connection, the one a changed address of Postgres or a reset of
   * conntrack/NAT leaves behind. A query sent now gets no answer and no error,
   * until something on the client side gives up on it. A connection opened
   * while frozen is accepted and hears nothing either.
   */
  freeze(): void;
  /**
   * Relays again from now on. What was dropped while frozen stays dropped: a
   * connection that lost bytes is as broken as it would be on a real network,
   * and only a new one is a working connection again.
   */
  thaw(): void;
}

/**
 * Opens a relay on a free port of `127.0.0.1` in front of the test database
 * (`testDatabaseUrl`). It relays until `freeze()` or `cut()`; a suite cuts
 * it in its `afterEach`, so no socket outlives the case.
 */
export async function openRelay(): Promise<Relay> {
  const target = testDatabaseUrl();
  const sockets = new Set<Socket>();
  let frozen = false;
  const server: Server = createServer((client) => {
    const upstream = connect({
      host: target.hostname,
      port: Number(target.port),
    });
    sockets.add(client).add(upstream);
    const relay = (from: Socket, to: Socket): void => {
      from.on("data", (chunk: Buffer) => {
        if (!frozen && !to.destroyed) {
          to.write(chunk);
        }
      });
    };
    relay(client, upstream);
    relay(upstream, client);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("relay has no port");
  }
  const url = testDatabaseUrl();
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    cut: async () => {
      const closed = new Promise<void>((done) => server.close(() => done()));
      for (const socket of sockets) {
        socket.destroy();
      }
      await closed;
    },
    freeze: () => {
      frozen = true;
    },
    thaw: () => {
      frozen = false;
    },
  };
}
