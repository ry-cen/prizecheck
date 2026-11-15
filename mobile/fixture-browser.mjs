import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

// Loopback-only, stateless, synthetic outcomes. Never imports the auth gateway or handles credentials.
export function fixtureBrowser() {
  return createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1:4319");
    const state = url.searchParams.get("state");
    response.setHeader("cache-control", "no-store");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    response.setHeader("referrer-policy", "no-referrer");
    if (
      request.method !== "GET" ||
      url.pathname !== "/sign-in" ||
      !/^[a-f0-9]{64}$/.test(state || "")
    ) {
      response.writeHead(400).end("Invalid demo request");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Prizecheck demo sign-in</title><h1>Demo sign-in</h1><p>Sample collection only. No account or credentials needed.</p>${["success", "cancelled", "error"].map((result) => `<p><a href="prizecheck-prototype://auth/return?state=${state}&amp;result=${result}">${{ success: "Continue to sample Collection", cancelled: "Cancel sign-in", error: "Simulate sign-in failure" }[result]}</a></p>`).join("")}</html>`
    );
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  fixtureBrowser().listen(4319, "127.0.0.1", () =>
    process.stdout.write("Demo browser listening on loopback port 4319\n")
  );
}
