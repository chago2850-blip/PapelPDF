#!/usr/bin/env bash
# Construye los .dmg de macOS (Intel y Apple Silicon) desde Linux, sin una Mac.
#  - electron-builder empaqueta PapelPDF.app
#  - rcodesign le pone una firma ad-hoc (macOS la exige en Apple Silicon)
#  - mkfs.hfsplus + hfsplus/dmg (libdmg-hfsplus de Mozilla) crean la imagen .dmg
# Requisitos: RCODESIGN, HFSPLUS y DMG apuntando a los binarios; hfsprogs instalado.
# En una Mac basta con: npm run dist:mac
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RCODESIGN:?ruta a rcodesign}" "${HFSPLUS:?ruta a hfsplus}" "${DMG:?ruta a dmg}"
VER=$(node -p "require('./package.json').version")

npx electron-builder --mac dir --x64 --arm64 -c.mac.identity=null

for pair in "mac:x64" "mac-arm64:arm64"; do
  dir=${pair%%:*}; arch=${pair##*:}
  app="dist/$dir/PapelPDF.app"
  [ -d "$app" ] || { echo "falta $app"; exit 1; }
  echo "== firmando (ad-hoc) $app"
  "$RCODESIGN" sign "$app" >/dev/null
  stage=$(mktemp -d)
  cp -a "$app" "$stage/"
  size=$(( $(du -sm "$stage" | cut -f1) * 13 / 10 + 30 ))
  img="dist/PapelPDF-$arch.hfs"
  rm -f "$img"
  dd if=/dev/zero of="$img" bs=1M count="$size" status=none
  mkfs.hfsplus -v "PapelPDF" "$img" >/dev/null
  "$HFSPLUS" "$img" -s clone_link addall "$stage" >/dev/null
  "$HFSPLUS" "$img" symlink /Applications /Applications >/dev/null
  out="dist/PapelPDF-$VER-$arch.dmg"
  "$DMG" build "$img" "$out" >/dev/null
  rm -rf "$stage" "$img"
  echo "== listo $out ($(du -h "$out" | cut -f1))"
done
