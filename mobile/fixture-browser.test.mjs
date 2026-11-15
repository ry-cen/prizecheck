import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fixtureBrowser } from "./fixture-browser.mjs";

test("loopback browser fixture returns only fixed demo outcomes, with no credentials or cookies", async () => {
  const server = fixtureBrowser().listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = "a".repeat(64);
    const response = await fetch(`${base}/sign-in?state=${state}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(
      response.headers.get("content-security-policy"),
      /default-src 'none'/
    );
    const body = await response.text();
    for (const result of ["success", "cancelled", "error"]) {
      assert.ok(
        body.includes(
          `prizecheck-prototype://auth/return?state=${state}&amp;result=${result}`
        )
      );
    }
    assert.doesNotMatch(body, /<input|<form|<script|\/api\//i);
    for (const path of [
      "/sign-in",
      "/api/collection",
      "/sign-in?state=%22%3E%3Cscript%3E",
    ]) {
      assert.equal((await fetch(`${base}${path}`)).status, 400);
    }
    assert.equal(
      (await fetch(`${base}/sign-in?state=${state}`, { method: "POST" }))
        .status,
      400
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
