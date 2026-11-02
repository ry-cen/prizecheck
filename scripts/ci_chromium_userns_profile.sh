#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# B1: this proposal applies only when the AppArmor userns restriction is active.
restriction_file=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
[[ -f "$restriction_file" ]] || fail "AppArmor userns restriction not present"
restriction=$(cat "$restriction_file")
[[ "$restriction" == 1 ]] || fail "restriction not active: proposal prerequisite not met; cause remains unconfirmed"

# Verification item 5: sudo installation must not leave root-owned checkout/cache files.
for ownership_path in "$GITHUB_WORKSPACE" node_modules "$HOME/.npm"; do
  stat -c 'Ownership: %n uid=%u gid=%g mode=%a' "$ownership_path"
  root_owned=$(find "$ownership_path" -user root -print -quit)
  [[ -z "$root_owned" ]] || fail "Root-owned path is forbidden: $root_owned"
done

# B2: resolve exactly one binary, then validate its literal path and entire ownership chain.
found=$(find "$PLAYWRIGHT_BROWSERS_PATH" -path '*/chrome-headless-shell-linux64/chrome-headless-shell' -type f)
mapfile -t candidates <<< "$found"
[[ -n "$found" && ${#candidates[@]} -eq 1 ]] || fail "Expected exactly one Playwright headless Chromium binary"
candidate=${candidates[0]}
[[ ! -L "$candidate" ]] || fail "Chromium binary must not be a symlink: $candidate"
binary=$(readlink -f -- "$candidate")
[[ "$binary" =~ ^/opt/ms-playwright/chromium_headless_shell-[0-9]+/chrome-headless-shell-linux64/chrome-headless-shell$ ]] || fail "Unexpected Chromium binary path: $binary"
[[ -f "$binary" && ! -L "$binary" ]] || fail "Chromium binary must be a regular file, not a symlink: $binary"

check_root_path() {
  local checked_path=$1 uid mode
  uid=$(stat -c %u -- "$checked_path")
  mode=$(stat -c %a -- "$checked_path")
  [[ "$uid" == 0 ]] || fail "Path must be root-owned: $checked_path (uid=$uid)"
  (( (8#$mode & 0022) == 0 )) || fail "Path must not be group- or other-writable: $checked_path (mode=$mode)"
}

check_root_path "$binary"
directory=$(dirname -- "$binary")
while true; do
  [[ -d "$directory" && ! -L "$directory" ]] || fail "Expected a real directory: $directory"
  check_root_path "$directory"
  if [[ "$directory" == / ]]; then
    break
  fi
  directory=$(dirname -- "$directory")
done

# B3/B5: write only this named profile, without a wildcard attachment or optional includes.
profile=/etc/apparmor.d/prizecheck-playwright-chromium
[[ ! -L "$profile" ]] || fail "AppArmor profile must not be a symlink: $profile"
sudo tee "$profile" > /dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>

profile prizecheck-playwright-chromium $binary flags=(unconfined) {
  userns,
}
EOF
sudo chown root:root "$profile"
sudo chmod 0644 "$profile"

# B4: require the exact loaded profile and log the approved runtime evidence.
sudo apparmor_parser -r "$profile"
profiles=$(sudo cat /sys/kernel/security/apparmor/profiles)
if ! loaded_line=$(grep -Fx 'prizecheck-playwright-chromium (unconfined)' <<< "$profiles"); then
  fail "AppArmor profile was not loaded: prizecheck-playwright-chromium (unconfined)"
fi
printf 'AppArmor userns restriction=%s\nChromium binary=%s\n' "$restriction" "$binary"
sha256sum "$binary"
cat "$profile"
printf 'Loaded AppArmor profile: %s\n' "$loaded_line"
