import { describe, expect, it } from "vitest";

import {
  parseBasicPassword,
  passwordMatches,
  unauthorized,
} from "@/lib/basic-auth";

/** `Basic <base64 of user:password>`, utf-8 bytes as a browser sends them. */
function basic(credentials: string, scheme = "Basic"): string {
  return `${scheme} ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

describe("parseBasicPassword", () => {
  it("reads the password of a well-formed header", () => {
    expect(parseBasicPassword(basic("admin:s3cret"))).toBe("s3cret");
  });

  it("keeps every colon after the first one in the password", () => {
    expect(parseBasicPassword(basic("admin:a:b:c"))).toBe("a:b:c");
  });

  it("decodes a non-ascii password as utf-8", () => {
    expect(parseBasicPassword(basic("admin:пароль-ü"))).toBe("пароль-ü");
  });

  it("accepts the scheme in any case", () => {
    expect(parseBasicPassword(basic("admin:s3cret", "basic"))).toBe("s3cret");
    expect(parseBasicPassword(basic("admin:s3cret", "BASIC"))).toBe("s3cret");
  });

  it("ignores the user name", () => {
    expect(parseBasicPassword(basic("anyone:s3cret"))).toBe("s3cret");
    expect(parseBasicPassword(basic(":s3cret"))).toBe("s3cret");
  });

  it("refuses credentials without a colon", () => {
    expect(parseBasicPassword(basic("admins3cret"))).toBeNull();
  });

  it("refuses a token that is not base64", () => {
    expect(parseBasicPassword("Basic !!!not-base64!!!")).toBeNull();
    expect(parseBasicPassword("Basic YWRtaW46c2VjcmV0=====")).toBeNull();
  });

  it("refuses bytes that are not utf-8", () => {
    const latin1 = Buffer.from([0x61, 0x3a, 0xff, 0xfe]).toString("base64");
    expect(parseBasicPassword(`Basic ${latin1}`)).toBeNull();
  });

  it("refuses an empty password", () => {
    expect(parseBasicPassword(basic("admin:"))).toBeNull();
  });

  it("refuses another scheme, a bare scheme and no header", () => {
    expect(parseBasicPassword(basic("admin:s3cret", "Bearer"))).toBeNull();
    expect(parseBasicPassword("Basic")).toBeNull();
    expect(parseBasicPassword("")).toBeNull();
    expect(parseBasicPassword(null)).toBeNull();
  });
});

describe("passwordMatches", () => {
  it("accepts the same password", () => {
    expect(passwordMatches("s3cret", "s3cret")).toBe(true);
  });

  it("refuses a different password of the same length", () => {
    expect(passwordMatches("s3creT", "s3cret")).toBe(false);
  });

  it("refuses a password of another length without throwing", () => {
    expect(passwordMatches("s3cret-and-more", "s3cret")).toBe(false);
    expect(passwordMatches("", "s3cret")).toBe(false);
  });
});

describe("unauthorized", () => {
  it("asks for basic credentials and forbids caching", async () => {
    const response = unauthorized();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Basic realm="shorts-factory", charset="UTF-8"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(await response.text()).toBe("Unauthorized");
  });
});
