import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { chromium } from "@playwright/test";

function processTree(browserPid) {
  const parents = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch (error) {
      // Unrelated processes can exit while /proc is enumerated.
      if (error.code === "ENOENT" || error.code === "ESRCH") continue;
      throw error;
    }
    // The parenthesized command can itself contain spaces and closing parentheses.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const parentPid = Number(fields[1]);
    if (!Number.isInteger(parentPid))
      throw new Error(`Cannot read parent PID from /proc/${entry}/stat`);
    parents.set(Number(entry), parentPid);
  }
  const pids = [browserPid];
  for (const parent of pids) {
    for (const [pid, parentPid] of parents) {
      if (parentPid === parent) pids.push(pid);
    }
  }
  return pids;
}

function namespaces(pid) {
  return {
    pid: readlinkSync(`/proc/${pid}/ns/pid`),
    user: readlinkSync(`/proc/${pid}/ns/user`),
  };
}

async function main() {
  if (process.platform !== "linux")
    throw new Error(
      `unsupported platform: ${process.platform}; Linux /proc is required`
    );

  let browserServer;
  try {
    // Match playwright.config.ts; never retry with the sandbox disabled.
    browserServer = await chromium.launchServer({
      chromiumSandbox: true,
      headless: true,
      timeout: 30_000,
    });
    const browserPid = browserServer.process().pid;
    if (!Number.isInteger(browserPid))
      throw new Error("Browser PID is unavailable");
    const browser = await chromium.connect(browserServer.wsEndpoint(), {
      timeout: 30_000,
    });
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>sandbox preflight</title>", {
      timeout: 10_000,
    });
    if ((await page.evaluate(() => 1 + 1)) !== 2)
      throw new Error("Renderer evaluation failed");

    const pids = processTree(browserPid);
    const renderers = [];
    for (const pid of pids) {
      // An unreadable or vanished descendant fails closed rather than hiding flags.
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmdline) throw new Error(`Empty command line for PID ${pid}`);
      for (const flag of ["--no-sandbox", "--disable-setuid-sandbox"]) {
        if (cmdline.includes(flag))
          throw new Error(`Forbidden flag ${flag} in PID ${pid}`);
      }
      if (cmdline.split("\0").includes("--type=renderer")) renderers.push(pid);
    }
    const browserNamespaces = namespaces(browserPid);
    console.log(
      `Browser PID=${browserPid} pid_ns=${browserNamespaces.pid} user_ns=${browserNamespaces.user}; inspected PIDs=${pids.join(",")}; no forbidden flags`
    );
    if (!renderers.length) throw new Error("No renderer descendant found");

    const evidence = [];
    for (const pid of renderers) {
      const rendererNamespaces = namespaces(pid);
      const differentPid = rendererNamespaces.pid !== browserNamespaces.pid;
      const differentUser = rendererNamespaces.user !== browserNamespaces.user;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const seccomp = /^Seccomp:\s+(\d+)$/m.exec(status)?.[1] ?? "unknown";
      console.log(
        `Renderer PID=${pid} pid_ns=${rendererNamespaces.pid} (different=${differentPid}) user_ns=${rendererNamespaces.user} (different=${differentUser}) Seccomp=${seccomp}`
      );
      if (differentPid) evidence.push(`PID ${pid}: different PID namespace`);
      if (differentUser) evidence.push(`PID ${pid}: different user namespace`);
      if (seccomp === "2") evidence.push(`PID ${pid}: Seccomp=2`);
    }
    if (!evidence.length)
      throw new Error(
        "No positive renderer sandbox evidence: namespaces match and Seccomp is not 2"
      );
    console.log(`Chromium sandbox preflight passed: ${evidence.join("; ")}`);
  } finally {
    // Closing the server also closes the connected browser and its descendants.
    await browserServer?.close();
  }
}

main().catch((error) => {
  console.error("Chromium sandbox preflight FAILED:", error);
  process.exitCode = 1;
});
