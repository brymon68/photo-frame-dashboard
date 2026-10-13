#!/usr/bin/env bash
# Builds kiosk/build/homehq.apk without Gradle. Needs JDK 17 + Android build-tools 34 + platform 34:
#   brew install --cask android-commandlinetools
#   sdkmanager --sdk_root=$ANDROID_HOME "build-tools;34.0.0" "platforms;android-34"
# Set KIOSK_KEYSTORE to the retained signing key used for the installed app.
# Install on the tablet: adb install -r kiosk/build/homehq.apk
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
BT="$ANDROID_HOME/build-tools/34.0.0"
JAR="$ANDROID_HOME/platforms/android-34/android.jar"
KS="${KIOSK_KEYSTORE:?Set KIOSK_KEYSTORE to the retained signing key used for the installed app}"
if [[ "$KS" != /* || ! -f "$KS" || ! -r "$KS" ]]; then
  echo "KIOSK_KEYSTORE must be an absolute path to the existing readable signing key." >&2
  exit 1
fi

rm -rf build && mkdir -p build/gen build/classes

ASSETS=()
if [ "${BUNDLE_DASHBOARD:-0}" = "1" ]; then
  if [ ! -f ../dist/index.html ]; then
    echo "Build the dashboard first: npm run build -- --base=./" >&2
    exit 1
  fi
  mkdir -p build/assets/dashboard
  cp -R ../dist/. build/assets/dashboard/
  ASSETS=(-A build/assets)
fi

"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml build/res.zip \
  --java build/gen --min-sdk-version 23 --target-sdk-version 23 --version-code 13 --version-name 1.12 "${ASSETS[@]}"

javac -nowarn -source 8 -target 8 -classpath "$JAR" -d build/classes \
  src/com/wesbos/homehq/*.java build/gen/com/wesbos/homehq/R.java

"$BT/d8" --min-api 23 --lib "$JAR" --output build $(find build/classes -name '*.class')
(cd build && zip -qj base.apk classes.dex)
"$BT/zipalign" -f 4 build/base.apk build/aligned.apk

"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out build/homehq.apk build/aligned.apk
echo "Built kiosk/build/homehq.apk"
