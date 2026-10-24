#!/usr/bin/env bash
# The iPhone app in a simulator (.github/workflows/phone-check.yml): builds a copy of the app that
# checks itself when it starts (tests/mobile/ios-selftest.js, with test-fixtures/sample.pdf), runs
# it on the newest iPhone simulator and takes screenshots when the checks ask (test-output/mobile).
# Needs a Mac with Xcode, after `npm run build` and `node scripts/make-fixtures.mjs`.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=test-output/mobile
mkdir -p "$out"

# The test copy: the web app, the checks and the PDFs they open, logging in every build.
npx cap sync ios
public=ios/App/App/public
cp tests/mobile/ios-selftest.js "$public/selftest.js"
cp test-fixtures/sample.pdf test-fixtures/card.pdf "$public/"
sed -i '' 's#</body>#<script src="selftest.js"></script></body>#' "$public/index.html"
node -e '
  const fs = require("fs");
  const file = "ios/App/App/capacitor.config.json";
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.loggingBehavior = "production";
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
'
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath test-output/ios-build CODE_SIGNING_ALLOWED=NO -quiet
app=test-output/ios-build/Build/Products/Debug-iphonesimulator/App.app

# The first iPhone of the newest iOS the simulator has.
device=$(xcrun simctl list devices available -j | node -e '
  const { devices } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const version = (runtime) => (runtime.match(/iOS-([\d-]+)/)?.[1] ?? "0").split("-").map(Number);
  const newest = Object.keys(devices).filter((r) => /iOS/.test(r))
    .sort((a, b) => { const [x, y] = [version(a), version(b)]; return y[0] - x[0] || (y[1] ?? 0) - (x[1] ?? 0); });
  for (const runtime of newest) {
    const phone = devices[runtime].find((d) => /^iPhone \d/.test(d.name)) ?? devices[runtime].find((d) => /^iPhone/.test(d.name));
    if (phone) { console.log(phone.udid); console.error(`${phone.name}, ${runtime.split(".").pop()}`); break; }
  }
')
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b > /dev/null
xcrun simctl install "$device" "$app"
log="$out/ios-app.log"
xcrun simctl launch --console-pty "$device" app.doxxta.mobile > "$log" 2>&1 &
sleep 2
# The checks and this script talk through files in the app's Documents/selftest (see ios-selftest.js).
talk="$(xcrun simctl get_app_container "$device" app.doxxta.mobile data)/Documents/selftest"

# Screenshots when the checks ask for them, until they're done (at most 10 minutes).
for _ in $(seq 1200); do
  for request in "$talk"/ios-*; do
    [ -e "$request" ] || continue
    xcrun simctl io "$device" screenshot "$out/$(basename "$request").png" > /dev/null 2>&1
    rm -f "$request"
  done
  [ -e "$talk/done" ] && break
  sleep 0.5
done
xcrun simctl terminate "$device" app.doxxta.mobile > /dev/null 2>&1 || true

results=$(cat "$talk/results.txt" 2> /dev/null || true)
failed=$(cat "$talk/done" 2> /dev/null || true)
echo "iPhone app"
echo "$results" | sed 's/^/  /'
if [ -z "$failed" ]; then
  echo "The checks didn't finish. The app's log:"
  tail -n 60 "$log"
  failed=1
  results="$results"$'\n'"✗ the checks didn't finish:"$'\n'"$(tail -n 40 "$log")"
fi

# Notes on the GitHub Actions run: the results, and small screenshots when asked for.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  escape() { node -e 'process.stdout.write(process.argv[1].replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"))' "$1"; }
  echo "::notice title=iPhone app check::$(escape "$results")"
  if [ -n "${SCREENSHOT_NOTES:-}" ]; then
    for png in "$out"/ios-*.png; do
      [ -e "$png" ] || continue
      # As big as fits in a note (4096 characters).
      for size in 480 420 360 320 280 240 200 160 120; do
        sips -Z "$size" -s format jpeg -s formatOptions 50 "$png" --out "${png%.png}.jpg" > /dev/null
        data=$(base64 -i "${png%.png}.jpg" | tr -d '\n')
        [ "${#data}" -le 3970 ] && break
      done
      echo "::notice title=Screenshot $(basename "${png%.png}")::data:image/jpeg;base64,$data"
    done
  fi
fi
[ "$failed" = 0 ] && echo "All passed" || { echo "$failed failed"; exit 1; }
