import { describe, expect, it } from "vitest";
import { clientsOf } from "../test-support/redis-clients.js";

describe("clientsOf", () => {
  it("reads the id, the database, the library and the name of each client", () => {
    expect(
      clientsOf(
        "id=7 addr=127.0.0.1:1 name=bull:c3lzdGVt db=2 lib-name=ioredis lib-ver=5.11.1\nid=8 addr=127.0.0.1:2 name= db=0 lib-name= lib-ver=\n",
      ),
    ).toEqual([
      { id: 7, db: "2", lib: "ioredis", name: "bull:c3lzdGVt" },
      { id: 8, db: "0", lib: "", name: "" },
    ]);
  });

  it("does not take the library name for the name of the client", () => {
    expect(clientsOf("id=7 db=2 lib-name=ioredis\n")).toEqual([
      { id: 7, db: "2", lib: "ioredis", name: "" },
    ]);
  });

  it.each([
    ["without an id", "addr=127.0.0.1:1 db=2 lib-name=ioredis"],
    ["with an id that is no number", "id=x addr=127.0.0.1:1 db=2"],
    ["without a db", "id=7 addr=127.0.0.1:1 lib-name=ioredis"],
  ])("throws, with the line, on a line %s", (_what, line) => {
    expect(() => clientsOf(`${line}\n`)).toThrow(JSON.stringify(line));
  });
});
