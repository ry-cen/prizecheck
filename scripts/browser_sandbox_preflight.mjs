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

function userNamespace(pid) {
  return readlinkSync(`/proc/${pid}/ns/user`);
}

function seccomp(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^Seccomp:\s+(\d+)$/m.exec(status);
  if (!match) throw new Error(`Seccomp field missing for PID ${pid}`);
  return Number(match[1]);
}

function appArmorLabel(pid) {
  try {
    return readFileSync(`/proc/${pid}/attr/apparmor/current`, "utf8").replace(
      /\n$/,
      ""
    );
  } catch (error) {
    // Older kernels expose only attr/current; other read failures stay fatal.
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return readFileSync(`/proc/${pid}/attr/current`, "utf8").replace(/\n$/, "");
  }
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
    const browserUserNamespace = userNamespace(browserPid);
    const browserLabel = appArmorLabel(browserPid);
    const browserSeccomp = seccomp(browserPid);
    const expectedLabel = "prizecheck-playwright-chromium (unconfined)";
    console.log(
      `Browser PID=${browserPid} AppArmor=${JSON.stringify(browserLabel)} user_ns=${browserUserNamespace} Seccomp=${browserSeccomp}; inspected PIDs=${pids.join(",")}; no forbidden flags`
    );
    if (!renderers.length) throw new Error("No renderer descendant found");

    const sandboxedRenderers = [];
    for (const pid of renderers) {
      const rendererUserNamespace = userNamespace(pid);
      const differentUser = rendererUserNamespace !== browserUserNamespace;
      const rendererSeccomp = seccomp(pid);
      console.log(
        `Renderer PID=${pid} user_ns=${rendererUserNamespace} (different=${differentUser}) Seccomp=${rendererSeccomp}`
      );
      if (differentUser && rendererSeccomp === 2) sandboxedRenderers.push(pid);
    }
    const failures = [];
    if (browserLabel !== expectedLabel)
      failures.push(
        `AppArmor label condition failed: expected ${JSON.stringify(expectedLabel)}, got ${JSON.stringify(browserLabel)}`
      );
    if (browserSeccomp !== 0)
      failures.push(
        `Browser Seccomp prerequisite failed: expected 0, got ${browserSeccomp}; an inherited filter is not accepted`
      );
    if (!sandboxedRenderers.length)
      failures.push(
        "Renderer condition failed: no single renderer has both a different user namespace and Seccomp=2"
      );
    if (failures.length) throw new Error(failures.join("; "));
    console.log(
      `Chromium sandbox preflight passed: AppArmor label matched; browser Seccomp=0; renderer PIDs=${sandboxedRenderers.join(",")} have a different user namespace AND Seccomp=2; no forbidden flags`
    );
  } finally {
    // Closing the server also closes the connected browser and its descendants.
    await browserServer?.close();
  }
}

main().catch((error) => {
  console.error("Chromium sandbox preflight FAILED:", error);
  process.exitCode = 1;
});
