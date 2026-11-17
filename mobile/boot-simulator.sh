#!/bin/bash
# Hosted macOS only. Starts the fixture simulator booting early so the boot overlaps npm ci and the
# compile. It does not wait for boot to finish; validate-simulator.sh runs bootstatus and cleans up.
# Never changes security, ATS or network settings.
set -euo pipefail
runtime=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; rows=[r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r["identifier"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-")]; assert rows, "No installed iOS runtime"; print(sorted(rows,key=lambda r:tuple(map(int,r["version"].split("."))))[-1]["identifier"])')
device_type=$(xcrun simctl list devicetypes -j | python3 -c 'import json,sys; rows=[r for r in json.load(sys.stdin)["devicetypes"] if r["name"] == "iPhone 17"]; assert rows, "No iPhone 17 device type"; print(rows[0]["identifier"])')
simulator_id=$(xcrun simctl create PrizecheckFixture "$device_type" "$runtime")
mkdir -p .scratch
echo "$simulator_id" > .scratch/ios-simulator-id
echo "Simulator: $simulator_id ($runtime)"
xcrun simctl boot "$simulator_id"
