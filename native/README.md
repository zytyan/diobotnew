# Embedded media WASM builds

All runtime media work is embedded in the standalone bot. No external
executable, shared library, native FFI, child process, startup download or
temporary media file is required. Deno's `--allow-run` permission is not used.

- PDQ uses the vendored Meta reference RGB/luma/DCT implementation. The wrapper
  exports the reference 256-bit hex word order and original 0–100 Quality.
- TGS uses Samsung rlottie, built without threads, image-loading modules or
  caching. It renders frame 0 and composites premultiplied ARGB onto white.
- JPEG, PNG, WebP and WebM use a decode-only FFmpeg/libvpx WASM. Only image-pipe
  and Matroska demuxers, required decoders and RGB conversion are compiled.
  Encoders, programs, protocols, networking, devices and threading are disabled.
  The C wrapper reads bounded in-memory input, decodes the first video frame,
  preserves WebM VP9 alpha and returns RGBA. JavaScript composites onto white
  with the same rounding as the prior native decoder pipeline.

Each job runs in a disposable worker with a caller deadline. The WASM bindings
have no filesystem or network capability. WASM memory is limited to 512 MiB;
input size, pixel count and decompression limits remain in force.

`versions.json` pins all upstream revisions and the Emscripten SDK. Install and
activate that SDK, then build all assets:

```sh
EMSDK_ROOT=/path/to/emsdk bash tools/build_media.sh
sha256sum -c assets/SHA256SUMS
```

To rebuild only the media decoder:

```sh
EMSDK_ROOT=/path/to/emsdk bash tools/build_decoder.sh
```

`MEDIA_BUILD_ROOT` optionally retains source/build directories for incremental
development builds. The scripts verify fetched FFmpeg/libvpx revisions before
building. No system FFmpeg or FFprobe installation is needed to build the WASM,
run the tests or run the bot. The Emscripten SDK supplies the zlib port.

All emitted `.wasm` files and workers are embedded by `deno task compile`. Run
`./dist/diobot --check-media` for an offline smoke test of the compiled binary.

The PDQ RGB golden vector was computed with the unmodified reference pipeline
and native `g++ -O3 -ffp-contract=off`, matching WASM floating-point semantics.
Generated fixtures test JPEG, PNG, WebP, multi-frame WebM, VP9 alpha and TGS.
`tests/fixtures/media/native-baseline.json` records the old decoder's hashes and
Quality to verify compatibility with existing blacklist data. Changes to
preprocessing or hashing must account for stored PDQ entries and cache versions.

Corresponding source is reproducibly fetched from the exact upstream commits in
`versions.json` by the included build scripts. Decoder changes are in
`media_decode.c`; no upstream source patches are applied. FFmpeg is built under
LGPL-2.1-or-later with GPL/nonfree components disabled. Distribution includes
its license and the libvpx/zlib notices in `assets/`. PDQ and rlottie licenses
are also in `assets/` and `vendor/`.
