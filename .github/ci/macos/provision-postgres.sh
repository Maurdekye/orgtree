#!/usr/bin/env bash
# The bundled PostgreSQL for macOS: EnterpriseDB's binaries zip (same vendor
# and version as the Windows pin), verified, cut down to what the engine runs
# (bin, lib without static archives, share, the two licence files) and thinned
# to arm64. The libraries load each other through @loader_path/../lib, so the
# folder is relocatable.
# Usage: provision-postgres.sh <download dir> <output dir, e.g. engine/postgresql>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
download="$1"; out="$2"
pin() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$here/postgres-pin.json" "$1"; }
url="$(pin url)"; bytes="$(pin bytes)"; sha="$(pin sha256)"
zip="$download/$(basename "$url")"
mkdir -p "$download"
[ -f "$zip" ] || curl -fsSL --retry 3 -o "$zip" "$url"
[ "$(stat -f %z "$zip")" = "$bytes" ] || { echo "PostgreSQL zip size mismatch"; exit 1; }
echo "$sha  $zip" | shasum -a 256 -c -

rm -rf "$out" "$download/pgsql"
unzip -q "$zip" 'pgsql/bin/*' 'pgsql/lib/*' 'pgsql/share/*' \
  pgsql/server_license.txt pgsql/commandlinetools_3rd_party_licenses.txt -d "$download"
find "$download/pgsql/lib" -name '*.a' -delete
mkdir -p "$(dirname "$out")"
mv "$download/pgsql" "$out"

# arm64 only: every universal Mach-O file loses its x86_64 slice.
while IFS= read -r -d '' f; do
  if lipo -info "$f" 2>/dev/null | grep -q 'Architectures in the fat file'; then
    lipo "$f" -thin arm64 -output "$f.thin" && mv "$f.thin" "$f"
  fi
done < <(find "$out" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.so' \) -print0)

for tool in postgres pg_ctl initdb psql pg_controldata; do
  [ -x "$out/bin/$tool" ] || { echo "missing $out/bin/$tool"; exit 1; }
done
lipo -info "$out/bin/postgres"
"$out/bin/postgres" --version
du -sh "$out"
