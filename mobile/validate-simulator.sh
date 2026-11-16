#!/bin/bash
# Hosted macOS only. Uses existing Xcode/Simulator permissions; never changes security settings.
set -euo pipefail
simulator_id=""
fixture_pid=""
native_pid=""
cleanup() {
  if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [ -n "$native_pid" ]; then kill "$native_pid" 2>/dev/null || true; wait "$native_pid" 2>/dev/null || true; fi
  if [ -n "$simulator_id" ]; then
    xcrun simctl shutdown "$simulator_id" || true
    xcrun simctl delete "$simulator_id" || true
  fi
}
trap cleanup EXIT
runtime=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; rows=[r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r["identifier"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-")]; assert rows, "No installed iOS runtime"; print(sorted(rows,key=lambda r:tuple(map(int,r["version"].split("."))))[-1]["identifier"])')
device_type=$(xcrun simctl list devicetypes -j | python3 -c 'import json,sys; rows=[r for r in json.load(sys.stdin)["devicetypes"] if r["name"] == "iPhone 17"]; assert rows, "No iPhone 17 device type"; print(rows[0]["identifier"])')
simulator_id=$(xcrun simctl create PrizecheckFixture "$device_type" "$runtime")
echo "Simulator: $simulator_id ($runtime)"
xcrun simctl boot "$simulator_id"
xcrun simctl bootstatus "$simulator_id" -b
xcrun simctl install "$simulator_id" .scratch/ios-derived/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch "$simulator_id" app.prizecheck.prototype
node mobile/fixture-browser.mjs > .scratch/ios-fixture.log 2>&1 &
fixture_pid=$!
# Readiness is deadline-based and never emits the pending state or fixture page body.
python3 - <<'PY'
import time, urllib.request
until = time.monotonic() + 15
while True:
    try:
        with urllib.request.urlopen('http://127.0.0.1:4319/sign-in?state=' + 'a' * 64, timeout=1) as response:
            assert response.status == 200
        break
    except OSError:
        if time.monotonic() >= until:
            raise
        time.sleep(0.1)
PY
# Assert the fixture still has only a loopback listener; do not alter ATS or network settings.
lsof -nP -iTCP:4319 -sTCP:LISTEN
test "$(lsof -nP -a -p "$fixture_pid" -iTCP:4319 -sTCP:LISTEN -Fn | sed -n 's/^n//p')" = "127.0.0.1:4319"
# The native sign-in stub: in-memory, no credentials, loopback 4320 only.
node mobile/native-fixture.mjs > .scratch/ios-native-fixture.log 2>&1 &
native_pid=$!
python3 - <<'PY'
import time, urllib.request
until = time.monotonic() + 15
while True:
    try:
        with urllib.request.urlopen('http://127.0.0.1:4320/auth/native/start?challenge=' + 'a' * 43 + '&state=' + 'b' * 43, timeout=1) as response:
            assert response.status == 200
        break
    except OSError:
        if time.monotonic() >= until:
            raise
        time.sleep(0.1)
PY
lsof -nP -iTCP:4320 -sTCP:LISTEN
test "$(lsof -nP -a -p "$native_pid" -iTCP:4320 -sTCP:LISTEN -Fn | sed -n 's/^n//p')" = "127.0.0.1:4320"
set -o pipefail
xcodebuild -project mobile/ios/App/App.xcodeproj -scheme FixtureValidation \
  -configuration Debug -destination "platform=iOS Simulator,id=$simulator_id" \
  -derivedDataPath .scratch/ios-derived -resultBundlePath .scratch/ios-ui.xcresult \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  CODE_SIGNING_ALLOWED=NO test-without-building | tee .scratch/ios-ui.log
xcrun xcresulttool get test-results summary --path .scratch/ios-ui.xcresult
