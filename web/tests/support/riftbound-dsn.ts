// TEST ONLY. The one place the Riftbound stack builds database addresses. A libpq or pg URL can retarget itself through
// its query (host, hostaddr, dbname, port, service...), so the stack never passes the stack's URL through: it rebuilds
// one from user, password, a loopback host, a port and a database name, and rejects an input that carries anything else.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TARGET_PARAMS = new Set([
  "host",
  "hostaddr",
  "dbname",
  "database",
  "port",
  "service",
  "user",
  "password",
  "options",
  "passfile",
  "servicefile",
  "target_session_attrs",
]);

export class DsnRejected extends Error {}

/** The parts of `raw` the stack may use, or a DsnRejected that names the reason and never the URL. */
export function approvedParts(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DsnRejected("the database address is not a URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
    throw new DsnRejected("the database address is not a PostgreSQL URL");
  if (!LOOPBACK.has(url.hostname))
    throw new DsnRejected("the database host is not loopback");
  for (const key of url.searchParams.keys()) {
    // One fixed message: a key can carry anything, an encoded "=" included, and must never reach a diagnostic.
    if (TARGET_PARAMS.has(key.toLowerCase()) || key.toLowerCase() !== "sslmode")
      throw new DsnRejected("unsupported database URL parameter");
  }
  return {
    username: url.username,
    password: url.password,
    hostname: url.hostname,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}

/** A canonical loopback DSN for `database` (default: the input's own), with no query parameters. */
export function canonicalDsn(raw: string, database?: string): string {
  const parts = approvedParts(raw);
  const url = new URL("postgresql://placeholder/");
  url.username = parts.username;
  url.password = parts.password;
  url.hostname = parts.hostname;
  url.port = parts.port;
  url.pathname = "/" + encodeURIComponent(database ?? parts.database);
  return url.toString();
}
