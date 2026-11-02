import { orientRgb, rgbaRgb, type RgbFrame } from "./media_pixels.ts";

/** Memory-only WASI bindings: no file descriptors, filesystem or networking. */
export async function decodeMedia(
  bytes: Uint8Array,
  webm: boolean,
): Promise<RgbFrame> {
  const memory = () => instance.exports.memory as WebAssembly.Memory;
  const zero = (address: number) =>
    new DataView(memory().buffer).setUint32(address, 0, true);
  const env = new Proxy<Record<string, (...args: number[]) => number>>({
    emscripten_notify_memory_growth: () => 0,
    emscripten_get_now: () => performance.now(),
    _emscripten_get_now_is_monotonic: () => 1,
    _emscripten_throw_longjmp: () => {
      throw new Error("Media decoder failed");
    },
    __syscall_getcwd: () => -2,
    __syscall_getdents64: () => -38,
    __syscall_readlinkat: () => -2,
    __syscall_openat: () => -38,
    __syscall_fcntl64: () => -38,
    __syscall_ioctl: () => -38,
    __syscall_stat64: () => -38,
    __syscall_lstat64: () => -38,
    __syscall_fstat64: () => -38,
  }, {
    get(target, name: string) {
      if (name.startsWith("invoke_")) {
        return (index: number, ...args: number[]) =>
          (instance.exports.__indirect_function_table as WebAssembly.Table).get(
            index,
          )!(...args);
      }
      return target[name];
    },
  });
  const module = await WebAssembly.instantiate(
    await Deno.readFile(
      new URL("../assets/media_decode.wasm", import.meta.url),
    ),
    {
      env,
      wasi_snapshot_preview1: {
        fd_read: () => 8,
        fd_write: () => 8,
        fd_seek: () => 8,
        fd_close: () => 8,
        fd_fdstat_get: () => 8,
        environ_sizes_get: (count: number, size: number) => {
          zero(count);
          zero(size);
          return 0;
        },
        environ_get: () => 0,
        clock_time_get: (
          _clock: number,
          _precision: bigint,
          address: number,
        ) => {
          new DataView(memory().buffer).setBigUint64(
            address,
            BigInt(Date.now()) * 1000000n,
            true,
          );
          return 0;
        },
        random_get: (pointer: number, size: number) => {
          for (let i = 0; i < size; i += 65536) {
            crypto.getRandomValues(
              new Uint8Array(
                memory().buffer,
                pointer + i,
                Math.min(65536, size - i),
              ),
            );
          }
          return 0;
        },
        proc_exit: () => {
          throw new Error("Media decoder exited");
        },
      },
    },
  );
  const instance = module.instance;
  const decoder = instance.exports as unknown as {
    _initialize: () => void;
    memory: WebAssembly.Memory;
    malloc: (size: number) => number;
    free: (p: number) => void;
    decode_media: (p: number, length: number, webm: number) => number;
    media_width: () => number;
    media_height: () => number;
    media_pixels: () => number;
    media_orientation: () => number;
  };
  decoder._initialize();
  const pointer = decoder.malloc(bytes.length);
  if (!pointer) throw new Error("媒体解码内存不足");
  new Uint8Array(decoder.memory.buffer).set(bytes, pointer);
  if (decoder.decode_media(pointer, bytes.length, Number(webm)) !== 0) {
    throw new Error("媒体首帧解码失败");
  }
  const width = decoder.media_width(),
    height = decoder.media_height(),
    pixels = decoder.media_pixels();
  if (!pixels || width < 1 || height < 1 || width * height > 16_000_000) {
    throw new Error("媒体尺寸无效");
  }
  const frame = rgbaRgb(
    new Uint8Array(decoder.memory.buffer, pixels, width * height * 4),
    width,
    height,
  );
  decoder.free(pointer);
  return orientRgb(frame, decoder.media_orientation());
}
