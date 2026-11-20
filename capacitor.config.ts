import type { CapacitorConfig } from "@capacitor/cli";

// Packaged assets only. No remote server, navigation allowlist, native HTTP or cookies bridge.
const config: CapacitorConfig = {
  appId: "app.prizecheck.prototype",
  appName: "Prizecheck Prototype",
  webDir: "dist/ios",
  ios: { path: "mobile/ios" },
};
export default config;
