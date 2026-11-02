# Media WASM builds

PDQ uses the vendored Meta reference RGB/luma/DCT implementation. The wrapper
exports the reference 256-bit hex word order and the original 0–100 Quality. TGS
uses Samsung rlottie, compiled without threads, image-loading modules or
caching. Both run only inside disposable Deno workers, not through native FFI.
Their WASI shim has no filesystem or network access. TGS renders frame 0 and
composites premultiplied ARGB onto white before hashing.

`versions.json` pins the upstream revisions and Emscripten version. Install and
activate that Emscripten version, then run:

```sh
EMSDK_ROOT=/path/to/emsdk bash tools/build_media.sh
sha256sum -c assets/SHA256SUMS
```

The build vendors the small PDQ core, fetches exactly the pinned rlottie commit,
and emits `assets/pdq.wasm` and `assets/rlottie.wasm`. These files and workers
are embedded in the compiled bot. Runtime needs only `/usr/bin/ffmpeg` and
`/usr/bin/ffprobe` for static image/WebM decoding; no compiler, Emscripten,
rlottie shared library or startup download is needed.

The test RGB golden vector was computed with the unmodified reference pipeline
and native `g++ -O3 -ffp-contract=off`; disabling fused operations matches WASM
floating-point semantics. Fixtures contain generated patterns only. Never change
the preprocessing or algorithm without changing `MEDIA_VERSION`, regenerating
fixtures/reference outputs and documenting migration of saved PDQ entries.

See `vendor/PDQ-LICENSE` and `vendor/RLOTTIE-LICENSE` for upstream notices.
