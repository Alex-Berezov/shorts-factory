import { Socket } from "node:net";
import { REQUEST_ID_HEADER } from "@sf/contracts";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import type { ConnectionError } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../src/lib/app-instance.js";
import {
  type RefusedSocket,
  answerClientError,
} from "../src/plugins/error-handler.js";
import { buildTestApp, parseErrorBody } from "./helpers.js";

/** Bigger than Node's default `maxHeaderSize` (16 KB). */
const OVERSIZED_HEADER_VALUE = "a".repeat(20 * 1024);

/** A request with headers over the limit, refused by Node's parser. */
const OVERSIZED_REQUEST = `GET /health HTTP/1.1\r\nHost: localhost\r\nX-Padding: ${OVERSIZED_HEADER_VALUE}\r\n\r\n`;

/** A raw HTTP response, split into the parts a test reads. */
interface RawResponse {
  statusLine: string;
  headers: Record<string, string>;
  body: string;
}

/** Splits one raw HTTP/1.1 response into its parts. */
function parseRaw(raw: string): RawResponse {
  const [head = "", body = ""] = raw.split("\r\n\r\n");
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return { statusLine, headers, body };
}

/**
 * Writes the requests to one connection as they are, each one after the
 * server has started answering the one before, and returns everything read
 * until the server closed the connection. `app.inject` cannot be used here:
 * it never goes through Node's parser, and the failures under test happen
 * inside it.
 */
function sendRaw(port: number, ...requests: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    const pending = [...requests];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const next = pending.shift();
      if (next !== undefined) {
        socket.write(next);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.connect(port, "127.0.0.1", () => {
      const first = pending.shift();
      if (first !== undefined) {
        socket.write(first);
      }
    });
  });
}

describe("a request Node refuses on the socket", () => {
  const recorder = recordingLogger();
  let app: AppInstance;
  let port: number;

  beforeAll(async () => {
    app = buildTestApp({ logger: recorder.log });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the test server is not listening on a tcp port");
    }
    port = address.port;
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers headers over the size limit with 431 in the envelope", async () => {
    recorder.clear();
    const res = parseRaw(await sendRaw(port, OVERSIZED_REQUEST));

    expect(res.statusLine).toBe("HTTP/1.1 431 Request Header Fields Too Large");
    const { error } = parseErrorBody(res.body);
    expect(error).toMatchObject({
      code: "REQUEST_HEADER_FIELDS_TOO_LARGE",
      message: "Request Header Fields Too Large",
    });
    expect(res.headers[REQUEST_ID_HEADER]).toBe(error.requestId);
    expect(res.headers.connection).toBe("close");
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.body).not.toContain("statusCode");

    // One short line for the operator: the status, the code and the id, not
    // the error of the parser and not the kilobytes the caller sent.
    const entries = recorder.entries();
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "request rejected",
        status: 431,
        code: "REQUEST_HEADER_FIELDS_TOO_LARGE",
        requestId: error.requestId,
      }),
    ]);
    expect(entries[0]).not.toHaveProperty("err");
    expect(recorder.raw()).not.toContain(OVERSIZED_HEADER_VALUE.slice(0, 100));
  });

  it("answers bytes that are not HTTP with 400 in the envelope", async () => {
    const res = parseRaw(await sendRaw(port, "THIS IS NOT HTTP\r\n\r\n"));

    expect(res.statusLine).toBe("HTTP/1.1 400 Bad Request");
    const { error } = parseErrorBody(res.body);
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Bad Request",
    });
    expect(res.headers[REQUEST_ID_HEADER]).toBe(error.requestId);
  });

  it("answers on a keep-alive connection that has served a request before", async () => {
    const raw = await sendRaw(
      port,
      "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n",
      OVERSIZED_REQUEST,
    );

    // The first answer, then the refusal of the second request - not a
    // connection closed without a word because bytes had gone out on it.
    expect(raw.startsWith("HTTP/1.1 200 OK")).toBe(true);
    const refusal = raw.indexOf("HTTP/1.1 431 Request Header Fields Too Large");
    expect(refusal).toBeGreaterThan(0);
    const { error } = parseErrorBody(parseRaw(raw.slice(refusal)).body);
    expect(error.code).toBe("REQUEST_HEADER_FIELDS_TOO_LARGE");
  });

  /**
   * Sends a megabyte of headers in one write and returns what came back,
   * with the number of times Node raised `clientError` for it.
   */
  async function sendFlood(): Promise<{ raw: string; raised: number }> {
    const request = `GET /health HTTP/1.1\r\nHost: localhost\r\nX-Padding: ${"a".repeat(1024 * 1024)}\r\n\r\n`;
    let raised = 0;
    const count = (): void => {
      raised += 1;
    };
    app.server.on("clientError", count);
    try {
      const raw = await new Promise<string>((resolve) => {
        const client = new Socket();
        const chunks: Buffer[] = [];
        client.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        // The server closes the connection with most of the request unsent;
        // what matters is what had arrived by then.
        client.on("error", () => {});
        client.on("close", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        client.connect(port, "127.0.0.1", () => {
          client.write(request);
        });
      });
      return { raw, raised };
    } finally {
      app.server.off("clientError", count);
    }
  }

  it("answers once while the rest of the refused request is still arriving", async () => {
    // The server reads the flood in chunks: the first one breaks the limit,
    // and the failed parser raises the same error again for every chunk read
    // after it - while the refusal is still on its way out. Whether a chunk
    // is read before the refusal is flushed depends on how much of the flood
    // the system had delivered by then, so the case repeats until it has.
    let sent = { raw: "", raised: 0 };
    for (let attempt = 0; attempt < 10 && sent.raised < 2; attempt += 1) {
      recorder.clear();
      sent = await sendFlood();
    }

    expect(sent.raised).toBeGreaterThan(1);
    const res = parseRaw(sent.raw);
    expect(res.statusLine).toBe("HTTP/1.1 431 Request Header Fields Too Large");
    const { error } = parseErrorBody(res.body);
    expect(recorder.entries()).toEqual([
      expect.objectContaining({
        msg: "request rejected",
        status: 431,
        requestId: error.requestId,
      }),
    ]);
  });
});

/** A socket that records what the handler did to it. */
class RecordingSocket implements RefusedSocket {
  destroyed = false;
  writable = true;
  /** What was sent with `end`, and the callback that runs once it is flushed. */
  ended: { data: string; flushed: () => void } | null = null;
  /** The argument of every `destroy` call, in order. */
  destroyCalls: Array<Error | undefined> = [];
  /** The response Node keeps in flight on the socket, when there is one. */
  _httpMessage: unknown = null;

  end(data: string, callback: () => void): this {
    this.ended = { data, flushed: callback };
    // As on a real socket: nothing more can be written once it is ended,
    // and it stays open until the data is flushed.
    this.writable = false;
    return this;
  }

  destroy(error?: Error): this {
    this.destroyCalls.push(error);
    this.destroyed = true;
    return this;
  }
}

/** The error Node hands to `clientError`, with the given code. */
function connectionError(code: string): ConnectionError {
  return Object.assign(new Error(`socket failure ${code}`), {
    code,
    bytesParsed: 0,
    rawPacket: { type: "Buffer", data: [] },
  });
}

/**
 * The branches a real socket reaches only by chance - a reset, a socket
 * already gone, a response half way out - and the timeout, which takes
 * `requestTimeout` to happen for real.
 */
describe("answerClientError", () => {
  it("answers a request that took too long to arrive with 408 in the envelope", () => {
    const { log, entries } = recordingLogger();
    const socket = new RecordingSocket();

    answerClientError(connectionError("ERR_HTTP_REQUEST_TIMEOUT"), socket, log);

    const sent = socket.ended?.data ?? "";
    expect(sent.startsWith("HTTP/1.1 408 Request Timeout\r\n")).toBe(true);
    const res = parseRaw(sent);
    const { error } = parseErrorBody(res.body);
    expect(error).toMatchObject({
      code: "REQUEST_TIMEOUT",
      message: "Request Timeout",
    });
    expect(res.headers[REQUEST_ID_HEADER]).toBe(error.requestId);
    expect(entries()).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "request rejected",
        status: 408,
        code: "REQUEST_TIMEOUT",
        requestId: error.requestId,
      }),
    ]);
  });

  it("answers the request once when Node raises the error again before the flush", () => {
    const { log, entries } = recordingLogger();
    const socket = new RecordingSocket();
    const err = connectionError("HPE_HEADER_OVERFLOW");

    // The next chunk of the same oversized request: the socket is ended but
    // not flushed yet, and no longer writable.
    answerClientError(err, socket, log);
    answerClientError(err, socket, log);

    expect(entries()).toEqual([
      expect.objectContaining({ msg: "request rejected", status: 431 }),
    ]);
    expect(socket.destroyCalls).toEqual([]);
    socket.ended?.flushed();
    expect(socket.destroyCalls).toEqual([undefined]);
  });

  it("answers a Node code that is also a name on every object with 400", () => {
    const { log } = recordingLogger();
    const socket = new RecordingSocket();

    answerClientError(connectionError("constructor"), socket, log);

    expect(parseRaw(socket.ended?.data ?? "").statusLine).toBe(
      "HTTP/1.1 400 Bad Request",
    );
  });

  it("closes the socket only once the response is flushed", () => {
    const { log } = recordingLogger();
    const socket = new RecordingSocket();

    answerClientError(connectionError("HPE_HEADER_OVERFLOW"), socket, log);

    // Destroying it at once would throw away what the socket had not handed
    // to the system yet.
    expect(socket.ended).not.toBeNull();
    expect(socket.destroyCalls).toEqual([]);
    socket.ended?.flushed();
    expect(socket.destroyCalls).toEqual([undefined]);
  });

  it("does nothing after a reset: nobody is there to answer", () => {
    const { log, entries } = recordingLogger();
    const socket = new RecordingSocket();

    answerClientError(connectionError("ECONNRESET"), socket, log);

    expect(socket.ended).toBeNull();
    expect(socket.destroyCalls).toEqual([]);
    expect(entries()).toEqual([]);
  });

  it("does nothing on a socket that is already destroyed", () => {
    const { log, entries } = recordingLogger();
    const socket = new RecordingSocket();
    socket.destroyed = true;

    answerClientError(connectionError("HPE_HEADER_OVERFLOW"), socket, log);

    expect(socket.ended).toBeNull();
    expect(socket.destroyCalls).toEqual([]);
    expect(entries()).toEqual([]);
  });

  it("closes a socket it can no longer write to without writing", () => {
    const { log, entries } = recordingLogger();
    const socket = new RecordingSocket();
    socket.writable = false;
    const err = connectionError("ERR_HTTP_REQUEST_TIMEOUT");

    answerClientError(err, socket, log);

    expect(socket.ended).toBeNull();
    expect(socket.destroyCalls).toEqual([err]);
    expect(entries()).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "request rejected",
        status: 408,
        code: "REQUEST_TIMEOUT",
      }),
    ]);
    // No response carries an id, so the line names none: an id nobody saw is
    // a false lead in the log.
    expect(entries()[0]).not.toHaveProperty("requestId");
  });

  it("writes nothing after a response that is half way out", () => {
    const { log, entries } = recordingLogger();
    const socket = new RecordingSocket();
    socket._httpMessage = { headersSent: true };
    const err = connectionError("HPE_HEADER_OVERFLOW");

    answerClientError(err, socket, log);

    // Bytes after a half-sent response would be read as part of it.
    expect(socket.ended).toBeNull();
    expect(socket.destroyCalls).toEqual([err]);
    expect(entries()).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "request rejected",
        status: 431,
        code: "REQUEST_HEADER_FIELDS_TOO_LARGE",
      }),
    ]);
    expect(entries()[0]).not.toHaveProperty("requestId");
  });
});
