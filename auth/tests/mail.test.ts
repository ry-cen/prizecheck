import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
let relay: Server;
let endpoint: string;
let reject = false;
let envelope: unknown;
beforeAll(async () => {
  relay = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    envelope = JSON.parse(body);
    expect(request.headers.authorization).toBe("Bearer local-relay-secret");
    response.writeHead(reject ? 503 : 202);
    response.end();
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(relay.address() as { port: number }).port}/send`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});
async function deliver() {
  const child = spawn(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import { deliverCode,pool } from './auth/src/auth.ts'; try { await deliverCode('recipient@example.test','123456'); } catch { process.exitCode=1; } finally { await pool.end(); }",
    ],
    {
      env: {
        ...process.env,
        MAIL_MODE: "http",
        MAIL_RELAY_URL: endpoint,
        MAIL_RELAY_TOKEN: "local-relay-secret",
        MAIL_FROM: "Tracker <codes@example.test>",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.once("exit", resolve));
  return { status, output };
}
it("delivers the code through the configurable HTTP email boundary", async () => {
  expect((await deliver()).status).toBe(0);
  expect(envelope).toEqual({
    from: "Tracker <codes@example.test>",
    to: "recipient@example.test",
    subject: "Your sign-in code",
    text: "Your sign-in code is 123456. It expires in 5 minutes.",
  });
});
it("rejects relay failure without logging the code, recipient or credentials", async () => {
  reject = true;
  const result = await deliver();
  expect(result.status).toBe(1);
  expect(result.output).not.toMatch(
    /123456|recipient@example.test|local-relay-secret/
  );
});
// slow (wall-clock): waits out the relay's real 5 s timeout (AbortSignal.timeout(5000) in auth/src/auth.ts has no test seam).
it(
  "times out an unresponsive email relay without exposing payloads",
  { tags: ["slow"] },
  async () => {
    relay.removeAllListeners("request");
    relay.on("request", () => {
      /* real boundary accepts connection but never answers */
    });
    const result = await deliver();
    expect(result.status).toBe(1);
    expect(result.output).not.toMatch(
      /123456|recipient@example.test|local-relay-secret/
    );
    relay.closeAllConnections();
  }
);
