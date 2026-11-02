#!/usr/bin/env bash
set -euo pipefail
# Requires the pinned Emscripten SDK in EMSDK_ROOT (emsdk install/activate 6.0.13).
repo_root=$(cd "$(dirname "$0")/.." && pwd)
: "${EMSDK_ROOT:?set EMSDK_ROOT to the emsdk directory}"
sdk_root="$EMSDK_ROOT"
source "$sdk_root/emsdk_env.sh" >/dev/null 2>&1
export EMSDK_ROOT="$sdk_root"
cd "$repo_root"
mkdir -p assets
em++ -O3 -std=c++17 -I native/vendor native/pdq.cpp native/vendor/pdq/cpp/hashing/pdqhashing.cpp native/vendor/pdq/cpp/hashing/torben.cpp native/vendor/pdq/cpp/downscaling/downscaling.cpp -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=536870912 -sEXPORTED_FUNCTIONS='["_malloc","_free","_pdq_hash_rgb"]' --no-entry -o assets/pdq.wasm
build_root=$(mktemp -d)
trap 'rm -rf "$build_root"' EXIT
rlottie_revision=$(python3 -c 'import json; print(json.load(open("native/versions.json"))["rlottie"])')
git init -q "$build_root/rlottie"
git -C "$build_root/rlottie" fetch --depth 1 https://github.com/Samsung/rlottie.git "$rlottie_revision"
git -C "$build_root/rlottie" checkout -q FETCH_HEAD
emcmake cmake -S "$build_root/rlottie" -B "$build_root/build" -DBUILD_SHARED_LIBS=OFF -DLOTTIE_MODULE=OFF -DLOTTIE_THREAD=OFF -DLOTTIE_CACHE=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_root/build" --target rlottie -j 2
em++ -O3 -std=c++17 -I "$build_root/rlottie/inc" native/tgs_frame.cpp "$build_root/build/librlottie.a" -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=536870912 -sEXPORTED_FUNCTIONS='["_malloc","_free","_render_tgs","_tgs_width","_tgs_height"]' --no-entry -o assets/rlottie.wasm
bash tools/build_decoder.sh
cp native/vendor/PDQ-LICENSE assets/PDQ-LICENSE
cp native/vendor/RLOTTIE-LICENSE assets/RLOTTIE-LICENSE
chmod 0644 assets/*
sha256sum assets/*.wasm > assets/SHA256SUMS
