#!/usr/bin/env bash
# Builds kiosk/build/homehq.apk without Gradle. Needs JDK 17 + Android build-tools 34 + platform 34:
#   brew install --cask android-commandlinetools
#   sdkmanager --sdk_root=$ANDROID_HOME "build-tools;34.0.0" "platforms;android-34"
# Set KIOSK_KEYSTORE and KIOSK_KEYSTORE_PASSWORD_FILE to the personal app's private signing files.
# Follow README.md for offline asset preparation and app updates.
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
BT="$ANDROID_HOME/build-tools/34.0.0"
JAR="$ANDROID_HOME/platforms/android-34/android.jar"
KS="${KIOSK_KEYSTORE:?Set KIOSK_KEYSTORE to the brymon68 app signing key}"
KS_PASS_FILE="${KIOSK_KEYSTORE_PASSWORD_FILE:?Set KIOSK_KEYSTORE_PASSWORD_FILE to its private password file}"
KEY_PASS_FILE="${KIOSK_KEY_PASSWORD_FILE:-$KS_PASS_FILE}"
KEY_ALIAS="${KIOSK_KEY_ALIAS:-homehq-brymon68}"
for signing_input in "$KS" "$KS_PASS_FILE" "$KEY_PASS_FILE"; do
  if [[ "$signing_input" != /* || ! -f "$signing_input" || ! -r "$signing_input" ]]; then
    echo "Signing key and password files must be existing readable absolute paths." >&2
    exit 1
  fi
done
# apksigner reuses the store password by default; reading the same file twice
# consumes a second line, so supply a key password only from a separate file.
SIGNING_ARGS=(--ks "$KS" --ks-key-alias "$KEY_ALIAS" --ks-pass "file:$KS_PASS_FILE")
if [[ "$KEY_PASS_FILE" != "$KS_PASS_FILE" ]]; then
  SIGNING_ARGS+=(--key-pass "file:$KEY_PASS_FILE")
fi

rm -rf build && mkdir -p build/gen build/classes
python3 fetch-dependencies.py
CAMERA_LIBS=(lib/Java-WebSocket-1.6.0.jar lib/slf4j-api-2.0.13.jar lib/slf4j-nop-2.0.13.jar)
CAMERA_CP=$(IFS=:; echo "${CAMERA_LIBS[*]}")

ASSETS=()
if [ "${BUNDLE_DASHBOARD:-1}" = "1" ]; then
  if [ ! -f ../dist/index.html ]; then
    echo "Build the dashboard first: npm run build -- --base=./" >&2
    exit 1
  fi
  mkdir -p build/assets/dashboard
  cp -R ../dist/. build/assets/dashboard/
  cp THIRD-PARTY-NOTICES.txt build/assets/dashboard/
  ASSETS=(-A build/assets)
fi

"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml build/res.zip \
  --java build/gen --min-sdk-version 23 --target-sdk-version 23 --version-code 31 --version-name 1.30 "${ASSETS[@]}"

javac -nowarn -source 8 -target 8 -classpath "$JAR:$CAMERA_CP" -d build/classes \
  src/com/brymon68/homehq/*.java build/gen/com/brymon68/homehq/R.java

# Build-tools 34's D8 crashes on the SLF4J enum metadata. Use the pinned Google
# compiler for dexing only; the existing SDK still packages and signs the APK.
java -cp lib/r8-8.7.18.jar com.android.tools.r8.D8 --min-api 23 --lib "$JAR" --output build $(find build/classes -name '*.class') "${CAMERA_LIBS[@]}"
(cd build && zip -qj base.apk classes.dex)
"$BT/zipalign" -f 4 build/base.apk build/aligned.apk

"$BT/apksigner" sign "${SIGNING_ARGS[@]}" \
  --out build/homehq.apk build/aligned.apk
"$BT/apksigner" verify build/homehq.apk
echo "Built kiosk/build/homehq.apk"
