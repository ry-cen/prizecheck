import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { freePort } from "./support/gateway";
import { PLACEHOLDER_CREDENTIALS } from "./support/oauth-gateway.js";
import { waitForServer } from "./support/servers.js";

// The gateway's signal handling, in a real child process. Needs DATABASE_URL on a migrated database, as the other
// gateway tests do. While the switch is off the gateway keeps Node's default behaviour on SIGTERM.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

async function start(native: boolean) {
  const port = await freePort();
  const output: string[] = [];
  const child = spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
    env: {
      ...process.env,
      AUTH_PORT: String(port),
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      OWNER_EMAIL: "owner@example.test",
      SIGNUP_MODE: "owner-only",
      NODE_ENV: "test",
      EMAIL_SIGN_IN: "off",
      ...(native ? { NATIVE_SIGN_IN: "on" } : { NATIVE_SIGN_IN: undefined }),
      ...PLACEHOLDER_CREDENTIALS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  const ready = await waitForServer(
    [child],
    `http://127.0.0.1:${port}/auth/session`,
    (r) => r.ok
  );
  if (!ready) throw new Error("Gateway did not start");
  await ready.body?.cancel();
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))
  );
  return { child, exited, output, port };
}

describe("signals", () => {
  it("with the switch on, drains and exits 0 on SIGTERM, and a second signal of either kind changes nothing", async () => {
    const { child, exited, output } = await start(true);
    child.kill("SIGTERM");
    child.kill("SIGINT");
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
    // pg throws "Called end on pool more than once" if the pool were closed twice.
    expect(output.join("")).not.toMatch(/more than once|Error|unhandled/i);
  });

  it("with the switch off, keeps Node's default: the signal ends the process", async () => {
    const { child, exited } = await start(false);
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: null, signal: "SIGTERM" });
  });
});
