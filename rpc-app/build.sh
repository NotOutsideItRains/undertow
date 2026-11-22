#!/bin/sh
# Builds the Windows .exe and the Linux AppImage into ./dist.
#   RUNTIME=/path/to/any/type-2.AppImage  (its launcher stub is reused; default: the first one found in ~/Downloads)
# The AppImage launcher stub is the open-source AppImage runtime (the first part of any type-2 AppImage, up to where its squashfs begins).
set -eu
cd "$(dirname "$0")"
VERSION="${VERSION:-1.0.0}"
# ORIGINS = the addresses of YOUR Undertow (main site and player, comma separated) that may talk to the app. CLIENT_ID = a Discord application ID of your own (optional; without it the app uses the shared "Monochrome Player" one, which anyone may use).
#   ORIGINS=https://music.example.com,https://player.example.com ./build.sh
ORIGINS="${ORIGINS:-http://localhost:7000}"
LDFLAGS="-s -w -X main.version=$VERSION -X main.defaultOrigins=$ORIGINS${CLIENT_ID:+ -X main.defaultClientID=$CLIENT_ID}"
export CGO_ENABLED=0
rm -rf dist build && mkdir -p dist build

echo "== tests"; go test -count=1 ./...

echo "== Windows"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS" -o dist/UndertowRPC-windows-amd64.exe .

echo "== Linux binary"
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS" -o build/undertow-rpc .

echo "== AppImage"
AD=build/AppDir
mkdir -p "$AD/usr/bin"
cp build/undertow-rpc "$AD/usr/bin/undertow-rpc"
rsvg-convert -w 256 -h 256 ../web/icon.svg -o "$AD/undertow-rpc.png"
ln -s undertow-rpc.png "$AD/.DirIcon"
cat > "$AD/undertow-rpc.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Undertow Presence
Comment=Shows what you're listening to in Undertow as your Discord status
Exec=undertow-rpc
Icon=undertow-rpc
Categories=AudioVideo;Audio;
Terminal=true
DESK
cat > "$AD/AppRun" <<'RUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/undertow-rpc" "$@"
RUN
chmod 755 "$AD/AppRun" "$AD/usr/bin/undertow-rpc"
mksquashfs "$AD" build/app.squashfs -root-owned -noappend -comp gzip -quiet
SRC="${RUNTIME:-}"
[ -n "$SRC" ] || SRC="$(ls "$HOME"/Downloads/ocenaudio*.AppImage 2>/dev/null | head -1)"
[ -f "$SRC" ] || { echo "No AppImage found to take the launcher stub from; set RUNTIME=..."; exit 1; }
# the stub ends where the ELF file ends (section headers last), and the squashfs ("hsqs") begins right there
OFF=$(python3 - "$SRC" <<'PY'
import struct, sys
with open(sys.argv[1], 'rb') as f:
    h = f.read(64)
    shoff = struct.unpack_from('<Q', h, 0x28)[0]
    ent, num = struct.unpack_from('<HH', h, 0x3A)
    end = shoff + ent * num
    f.seek(end)
    assert f.read(4) == b'hsqs', 'not a type-2 AppImage'
    print(end)
PY
)
head -c "$OFF" "$SRC" > dist/UndertowRPC-x86_64.AppImage
cat build/app.squashfs >> dist/UndertowRPC-x86_64.AppImage
chmod 755 dist/UndertowRPC-x86_64.AppImage
cp build/undertow-rpc dist/undertow-rpc-linux-amd64

( cd dist && sha256sum * > SHA256SUMS )
ls -la dist
