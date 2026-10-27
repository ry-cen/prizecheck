import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import {
  betterRequest,
  CLIENT_IP_HEADER,
  IP_ADDRESS_OPTION,
  relay,
  type RelayOptions,
} from "../src/betterRelay.js";
import { readFileSync } from "node:fs";

const origin = "http://localhost:5173";

describe("betterRequest", () => {
  const incoming = {
    method: "GET",
    url: "/api/auth/callback/google?code=abc%2F1&state=s%20t&iss=https%3A%2F%2Faccounts.google.com",
    headers: { cookie: "a=1; b=2", origin },
  };
  it("drops the query string unless the route opts in", () => {
    expect(
      betterRequest(origin, incoming, "/api/auth/callback/google").url
    ).toBe(`${origin}/api/auth/callback/google`);
  });
  it("forwards the query string exactly for a route that opts in", () => {
    expect(
      betterRequest(origin, incoming, "/api/auth/callback/google", undefined, {
        forwardQuery: true,
      }).url
    ).toBe(
      `${origin}/api/auth/callback/google?code=abc%2F1&state=s%20t&iss=https%3A%2F%2Faccounts.google.com`
    );
    expect(
      betterRequest(
        origin,
        { ...incoming, url: "/auth/sign-in/google" },
        "/api/auth/x",
        undefined,
        { forwardQuery: true }
      ).url
    ).toBe(`${origin}/api/auth/x`);
  });
  it("keeps the method, cookie, origin, JSON content type and body", async () => {
    const request = betterRequest(
      origin,
      { ...incoming, method: "POST", url: "/auth/verify-code" },
      "/api/auth/sign-in/email-otp",
      '{"x":1}'
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("cookie")).toBe("a=1; b=2");
    expect(request.headers.get("origin")).toBe(origin);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.text()).toBe('{"x":1}');
  });
});

describe("betterRequest client address", () => {
  const withPeer = (peer: string, headers: Record<string, string> = {}) => ({
    method: "POST",
    url: "/auth/verify-code",
    headers: { cookie: "a=1", ...headers },
    socket: { remoteAddress: peer },
  });
  // The limiter's address for a request, from the very option object auth.ts hands to Better Auth.
  const bucketIp = (request: Request) =>
    IP_ADDRESS_OPTION.ipAddressHeaders
      .map((name) => request.headers.get(name))
      .find(Boolean) ?? null;

  it("is the option auth.ts gives Better Auth", () => {
    expect(IP_ADDRESS_OPTION).toEqual({ ipAddressHeaders: [CLIENT_IP_HEADER] });
    expect(readFileSync("auth/src/auth.ts", "utf8")).toMatch(
      /ipAddress: IP_ADDRESS_OPTION,/
    );
  });

  it("gives different clients different limiter addresses", () => {
    const a = betterRequest(
      origin,
      withPeer("203.0.113.5"),
      "/api/auth/x",
      "{}"
    );
    const b = betterRequest(
      origin,
      withPeer("203.0.113.6"),
      "/api/auth/x",
      "{}"
    );
    expect(bucketIp(a)).toBe("203.0.113.5");
    expect(bucketIp(b)).toBe("203.0.113.6");
  });
  it("uses x-real-ip only from a trusted proxy", () => {
    const via = (peer: string) =>
      bucketIp(
        betterRequest(
          origin,
          withPeer(peer, { "x-real-ip": "198.51.100.9" }),
          "/api/auth/x",
          "{}"
        )
      );
    const before = process.env.TRUSTED_PROXY_IPS;
    process.env.TRUSTED_PROXY_IPS = "10.201.80.10";
    try {
      expect(via("10.201.80.10")).toBe("198.51.100.9");
      expect(via("203.0.113.5")).toBe("203.0.113.5");
    } finally {
      if (before === undefined) delete process.env.TRUSTED_PROXY_IPS;
      else process.env.TRUSTED_PROXY_IPS = before;
    }
  });
  it("ignores a client-supplied copy of the header", () => {
    const request = betterRequest(
      origin,
      withPeer("203.0.113.5", {
        [CLIENT_IP_HEADER]: "198.51.100.77",
        "x-forwarded-for": "198.51.100.78",
      }),
      "/api/auth/x",
      "{}"
    );
    expect(request.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.5");
    expect(request.headers.get("x-forwarded-for")).toBeNull();
  });
});

describe("betterRequest route options", () => {
  it("lets a route set the method and vouch with the gateway's own origin", async () => {
    const request = betterRequest(
      origin,
      {
        method: "GET",
        url: "/auth/sign-in/google",
        headers: { cookie: "a=1" },
      },
      "/api/auth/sign-in/social",
      "{}",
      { method: "POST", originHeader: origin }
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("origin")).toBe(origin);
    expect(request.headers.get("cookie")).toBe("a=1");
    expect(await request.text()).toBe("{}");
  });
});

describe("relay", () => {
  let base = "";
  let result: () => Response = () => new Response(null);
  let options: RelayOptions | undefined;
  const server = createServer(
    (_request, response: ServerResponse) =>
      void relay(response, result(), options)
  );
  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  const redirect = () => {
    const headers = new Headers({
      location: "/collection",
      "content-type": "application/json",
    });
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly; SameSite=Lax");
    headers.append("set-cookie", "state=; Max-Age=0; Path=/");
    return new Response("{}", { status: 302, headers });
  };
  it("drops Location by default and keeps status, cookies, content type and no-store", async () => {
    result = redirect;
    options = undefined;
    const response = await fetch(base, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([
      "session=abc; Path=/; HttpOnly; SameSite=Lax",
      "state=; Max-Age=0; Path=/",
    ]);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("{}");
  });
  it("passes Location for a route that opts in, with the same cookie and cache handling", async () => {
    result = redirect;
    options = { forwardLocation: true };
    const response = await fetch(base, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/collection");
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("falls back to a JSON content type and adds no Location when Better Auth sent none", async () => {
    result = () => new Response(null, { status: 200 });
    options = { forwardLocation: true };
    const response = await fetch(base, { redirect: "manual" });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
