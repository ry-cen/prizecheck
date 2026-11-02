import type { LaunchOptions } from "@playwright/test";

// Playwright replaces fixture launch options, so every caller must apply this policy.
export function sandboxedLaunchOptions(
  extra: LaunchOptions = {}
): LaunchOptions {
  for (const arg of extra.args ?? []) {
    if (/^--(?:no|disable-setuid)-sandbox(?:=|$)/.test(arg))
      throw new Error(
        `Chromium sandbox cannot be disabled by launch argument: ${arg}`
      );
  }
  return {
    ...extra,
    ...(process.env.TEST_FONTCONFIG_FILE
      ? {
          env: {
            ...process.env,
            ...extra.env,
            FONTCONFIG_FILE: process.env.TEST_FONTCONFIG_FILE,
          },
        }
      : {}),
    // Callers cannot override the requirement to launch with Chromium's sandbox.
    chromiumSandbox: true,
  };
}
