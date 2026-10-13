// TEST ONLY. A stand-in for the gateway's OAuth routes over an in-memory Better Auth, for auth/tests/oauth-fake.test.ts.
import { createServer } from "node:http";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

const origin = process.env.PUBLIC_ORIGIN!;
const db: Record<string, Record<string, unknown>[]> = {
  user: [],
  session: [],
  account: [],
  verification: [],
};
const auth = betterAuth({
  database: memoryAdapter(db),
  logger: { disabled: true },
  secret: "oauth-fake-fixture-secret-0123456789abcdef",
  baseURL: origin,
  basePath: "/api/auth",
  trustedOrigins: [origin],
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    },
  },
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", origin);
  const start = /^\/auth\/sign-in\/([a-z]+)$/.exec(url.pathname);
  try {
    if (start && request.method === "GET") {
      const result = await auth.api.signInSocial({
        body: {
          provider: start[1] as "google" | "discord",
          callbackURL: "/done",
          errorCallbackURL: "/signin",
          newUserCallbackURL: "/done",
        },
        asResponse: true,
      });
      const { url: to } = (await result.json()) as { url: string };
      response.writeHead(302, {
        location: to,
        "set-cookie": result.headers.getSetCookie(),
      });
      return response.end();
    }
    if (
      url.pathname.startsWith("/api/auth/callback/") &&
      request.method === "GET"
    ) {
      const result = await auth.handler(
        new Request(`${origin}${request.url}`, {
          headers: { cookie: request.headers.cookie || "" },
        })
      );
      response.writeHead(result.status, {
        location: result.headers.get("location") || "",
        "set-cookie": result.headers.getSetCookie(),
      });
      return response.end();
    }
    if (url.pathname === "/fixture/state") {
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: request.headers.cookie || "" }),
      });
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(
        JSON.stringify({
          user: session
            ? {
                email: session.user.email,
                emailVerified: session.user.emailVerified,
                name: session.user.name,
                image: session.user.image,
              }
            : null,
          users: db.user.map((u) => ({
            email: u.email,
            emailVerified: u.emailVerified,
          })),
          accounts: db.account.map((a) => ({
            providerId: a.providerId,
            accountId: a.accountId,
            userEmail: db.user.find((u) => u.id === a.userId)?.email,
          })),
        })
      );
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.name : "error");
  }
});
server.listen(Number(process.env.FIXTURE_PORT), "127.0.0.1", () =>
  process.stdout.write("READY\n")
);
