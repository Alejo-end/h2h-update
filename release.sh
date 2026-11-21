#!/bin/zsh
# Builds the firmware and puts it on the web page as the newest version.
# Usage: ./release.sh "What changed, in one or two sentences"
# It reads FW_VERSION from MIDI2HOST.ino, so change that date first.
set -e
HERE=${0:A:h}
CODE=$HERE/..
FQBN=rp2040:rp2040:seeed_xiao_rp2040:usbstack=tinyusb
VER=$(sed -n 's/^#define FW_VERSION "\(.*\)"/\1/p' "$CODE/MIDI2HOST/MIDI2HOST.ino")
[[ -n $VER ]] || { echo "FW_VERSION not found in MIDI2HOST.ino"; exit 1; }
NOTES=${1:-}
TMP=$(mktemp -d)
OUT=$HERE/firmware/$VER
mkdir -p "$OUT" "$TMP/normal" "$TMP/blue/MIDI2HOST"

echo "Building $VER"
arduino-cli compile --fqbn $FQBN --output-dir "$TMP/normal" "$CODE/MIDI2HOST" | tail -2
sed 's|^//#define FORCE_ROLE_M2$|#define FORCE_ROLE_M2|' "$CODE/MIDI2HOST/MIDI2HOST.ino" > "$TMP/blue/MIDI2HOST/MIDI2HOST.ino"
grep -q '^#define FORCE_ROLE_M2$' "$TMP/blue/MIDI2HOST/MIDI2HOST.ino" || { echo "could not set FORCE_ROLE_M2"; exit 1; }
arduino-cli compile --fqbn $FQBN --output-dir "$TMP/blue/build" "$TMP/blue/MIDI2HOST" | tail -2

cp "$TMP/normal/MIDI2HOST.ino.uf2" "$OUT/h2h-$VER.uf2"
cp "$TMP/blue/build/MIDI2HOST.ino.uf2" "$OUT/h2h-$VER-force-blue.uf2"
cp "$TMP/normal/MIDI2HOST.ino.uf2" "$CODE/MIDI2HOST_XIAO_RP2040.uf2"
cp "$TMP/blue/build/MIDI2HOST.ino.uf2" "$CODE/MIDI2HOST_XIAO_RP2040_force-blue.uf2"
rm -rf "$TMP"

python3 - "$HERE/firmware/manifest.json" "$VER" "$NOTES" <<'PY'
import json, sys, os
path, ver, notes = sys.argv[1:4]
m = json.load(open(path)) if os.path.exists(path) else {"releases": []}
m["releases"] = [r for r in m["releases"] if r["version"] != ver]
m["releases"].insert(0, {
    "version": ver,
    "notes": notes,
    "files": {"normal": f"{ver}/h2h-{ver}.uf2", "force_blue": f"{ver}/h2h-{ver}-force-blue.uf2"},
})
m["latest"] = ver
json.dump(m, open(path, "w"), indent=2)
print("manifest:", ver, "is the latest of", len(m["releases"]), "releases")
PY
echo "Done. Upload the web folder (or push it) to publish $VER."
