#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
: "${EMSDK_ROOT:?set EMSDK_ROOT to the emsdk directory}"
sdk_root="$EMSDK_ROOT"
source "$sdk_root/emsdk_env.sh" >/dev/null 2>&1
export EMSDK_ROOT="$sdk_root"
cd "$repo_root"
if [[ -n "${MEDIA_BUILD_ROOT:-}" ]]; then
  work_root="$MEDIA_BUILD_ROOT"
  mkdir -p "$work_root"
else
  work_root=$(mktemp -d)
  trap 'rm -rf "$work_root"' EXIT
fi
fetch_source() {
  local source_name="$1" source_url="$2" source_revision="$3"
  if [[ ! -d "$work_root/$source_name/.git" ]]; then
    git init -q "$work_root/$source_name"
    git -C "$work_root/$source_name" fetch --depth 1 "$source_url" "$source_revision"
    git -C "$work_root/$source_name" checkout -q FETCH_HEAD
  fi
  [[ $(git -C "$work_root/$source_name" rev-parse HEAD) == "$source_revision" ]]
}
ffmpeg_revision=$(python3 -c 'import json; print(json.load(open("native/versions.json"))["ffmpeg"])')
vpx_revision=$(python3 -c 'import json; print(json.load(open("native/versions.json"))["libvpx"])')
fetch_source ffmpeg https://github.com/FFmpeg/FFmpeg.git "$ffmpeg_revision"
fetch_source libvpx https://github.com/webmproject/libvpx.git "$vpx_revision"
mkdir -p "$work_root/vpx-build" "$work_root/ffmpeg-build" "$work_root/prefix"
cd "$work_root/vpx-build"
CC=emcc CXX=em++ AR=emar LD=emcc NM=emnm RANLIB=emranlib STRIP=emstrip "$work_root/libvpx/configure" --target=generic-gnu --prefix="$work_root/prefix" --disable-examples --disable-tools --disable-docs --disable-unit-tests --disable-multithread --disable-runtime-cpu-detect --disable-vp8-encoder --disable-vp9-encoder
make -j 2
make install
cd "$work_root/ffmpeg-build"
PKG_CONFIG_PATH="$work_root/prefix/lib/pkgconfig" "$work_root/ffmpeg/configure" \
  --prefix="$work_root/prefix" --cc=emcc --cxx=em++ --ar=emar --nm=emnm --ranlib=emranlib \
  --arch=wasm32 --target-os=none --enable-cross-compile --disable-asm --disable-inline-asm \
  --disable-everything --disable-autodetect --disable-network --disable-programs --disable-doc --disable-debug --disable-stripping \
  --disable-avdevice --disable-avfilter --disable-swresample --disable-postproc --disable-pthreads --disable-w32threads --disable-os2threads --disable-runtime-cpudetect \
  --enable-avformat --enable-avcodec --enable-avutil --enable-swscale --enable-libvpx --enable-zlib \
  --enable-demuxer=image_jpeg_pipe,image_png_pipe,image_webp_pipe,image_ppm_pipe,matroska \
  --enable-decoder=mjpeg,png,webp,ppm,libvpx_vp8,libvpx_vp9 \
  --extra-cflags="-O3 -sUSE_ZLIB=1 -I$work_root/prefix/include" \
  --extra-ldflags="-sUSE_ZLIB=1 -L$work_root/prefix/lib" --pkg-config-flags=--static
make -j 2
cd "$repo_root"
emcc -O3 -I "$work_root/ffmpeg" -I "$work_root/ffmpeg-build" native/media_decode.c \
  -Wl,--start-group "$work_root/ffmpeg-build/libavformat/libavformat.a" "$work_root/ffmpeg-build/libavcodec/libavcodec.a" "$work_root/ffmpeg-build/libswscale/libswscale.a" "$work_root/ffmpeg-build/libavutil/libavutil.a" "$work_root/prefix/lib/libvpx.a" -Wl,--end-group \
  -sUSE_ZLIB=1 -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=536870912 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_decode_media","_media_width","_media_height","_media_pixels","_media_orientation"]' --no-entry -o assets/media_decode.wasm
cp "$work_root/ffmpeg/COPYING.LGPLv2.1" assets/FFMPEG-LICENSE
cp "$work_root/libvpx/LICENSE" assets/LIBVPX-LICENSE
cp "$work_root/libvpx/PATENTS" assets/LIBVPX-PATENTS
zlib_license=$(find "$EMSDK_ROOT/upstream/emscripten/cache/ports/zlib" -name LICENSE -print -quit)
cp "$zlib_license" assets/ZLIB-LICENSE
python3 - <<'PYCODE'
from pathlib import Path
for name in ['FFMPEG-LICENSE', 'LIBVPX-LICENSE', 'LIBVPX-PATENTS', 'ZLIB-LICENSE']:
    p=Path('assets')/name
    p.write_text(p.read_text().rstrip()+'\n')
PYCODE
chmod 0644 assets/*
sha256sum assets/*.wasm > assets/SHA256SUMS
