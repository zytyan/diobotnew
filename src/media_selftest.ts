import { MediaService, pdqRgb } from "./media.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";

/** Offline deployment check: exercises embedded WASM workers and permitted decoders. */
export async function mediaSelfTest() {
  const rgb = new Uint8Array(128 * 128 * 3);
  let i = 0;
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      for (
        const c of [
          (x * 2 + y) % 256,
          y * 2 % 256,
          (Math.floor(x / 16) + Math.floor(y / 16)) % 2 * 200,
        ]
      ) rgb[i++] = c;
    }
  }
  const expected =
    "aaa2a8e822aa8adfaa22a8ffaa2a8add2a226faa5aaa7688d52a774a5dd27536";
  const result = await pdqRgb(
    { rgb, width: 128, height: 128 },
    AbortSignal.timeout(10000),
  );
  if (result.hash !== expected || result.quality !== 100) {
    throw new Error("PDQ reference self-test failed");
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      v: "5.5.7",
      fr: 30,
      ip: 0,
      op: 60,
      w: 64,
      h: 64,
      ddd: 0,
      assets: [],
      layers: [],
    }),
  );
  const rendered = await pdqRgb({ json }, AbortSignal.timeout(10000));
  if (rendered.quality !== 0) {
    throw new Error("Lottie first-frame self-test failed");
  }
  const header = new TextEncoder().encode("P6\n128 128\n255\n");
  const image = new Uint8Array(header.length + rgb.length);
  image.set(header);
  image.set(rgb, header.length);
  const store = new Store(":memory:");
  try {
    const service = new MediaService(
      store.media,
      {
        getFile: () =>
          Promise.resolve({
            file_id: "selftest",
            file_unique_id: "selftest",
            file_path: "selftest",
          }),
      },
      loadConfig({ BOT_TOKEN: "99:selftest", TELEGRAM_ENV: "test" }),
      () => Promise.resolve(new Response(image)),
    );
    const decoded = await service.hash({
      kind: "image",
      format: "image",
      file: "selftest",
      unique: "selftest",
      aliases: ["selftest"],
    });
    if (decoded.hash !== expected) {
      throw new Error("Embedded media decoder self-test failed");
    }
  } finally {
    store.close();
  }
  console.log(
    "媒体自检通过：PDQ WASM、TGS/rlottie WASM、图片/WebM解码 WASM、嵌入资源及Worker。",
  );
}
