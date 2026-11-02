// All synchronous WASM work runs in a disposable worker, with a caller deadline.
const workerScope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<
      { rgb: Uint8Array; width: number; height: number; json?: Uint8Array }
    >,
  ) => void;
  postMessage: (data: unknown) => void;
};
workerScope.onmessage = async (
  { data }: MessageEvent<
    { rgb: Uint8Array; width: number; height: number; json?: Uint8Array }
  >,
) => {
  try {
    let frame = data;
    if (data.json) {
      const env = new Proxy<Record<string, (...args: number[]) => number>>({
        emscripten_notify_memory_growth: () => 0,
        __syscall_getcwd: () => -2,
        __syscall_readlinkat: () => -2,
        _emscripten_throw_longjmp: () => {
          throw new Error("Lottie failed");
        },
      }, {
        get(target, name: string) {
          if (name.startsWith("invoke_")) {
            return (index: number, ...args: number[]) =>
              table.get(index)!(...args);
          }
          return target[name];
        },
      });
      const module = await WebAssembly.instantiate(
        await Deno.readFile(new URL("../assets/rlottie.wasm", import.meta.url)),
        {
          wasi_snapshot_preview1: {
            proc_exit: () => {
              throw new Error("Lottie exited");
            },
            fd_write: () => 0,
            fd_close: () => 0,
            fd_seek: () => 0,
            fd_read: () => 8,
            environ_sizes_get: () => 0,
            environ_get: () => 0,
          },
          env,
        },
      );
      const table = module.instance.exports
        .__indirect_function_table as WebAssembly.Table;
      const lottie = module.instance.exports as unknown as {
        memory: WebAssembly.Memory;
        malloc: (n: number) => number;
        _initialize: () => void;
        render_tgs: (p: number, n: number) => number;
        tgs_width: () => number;
        tgs_height: () => number;
      };
      lottie._initialize();
      const input = lottie.malloc(data.json.length);
      new Uint8Array(lottie.memory.buffer).set(data.json, input);
      const pointer = lottie.render_tgs(input, data.json.length);
      const width = lottie.tgs_width(), height = lottie.tgs_height();
      if (!pointer || !width || !height || width * height > 16_000_000) {
        throw new Error("TGS首帧渲染失败");
      }
      frame = {
        rgb: new Uint8Array(lottie.memory.buffer, pointer, width * height * 3)
          .slice(),
        width,
        height,
      };
    }
    if (
      !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
      frame.width < 1 || frame.height < 1 ||
      frame.width * frame.height > 16_000_000 ||
      frame.rgb.length !== frame.width * frame.height * 3
    ) throw new Error("RGB尺寸无效");
    const bytes = await Deno.readFile(
      new URL("../assets/pdq.wasm", import.meta.url),
    );
    const { instance } = await WebAssembly.instantiate(bytes, {
      wasi_snapshot_preview1: {
        proc_exit: () => {
          throw new Error("PDQ exited");
        },
      },
      env: { emscripten_notify_memory_growth: () => {} },
    });
    const wasm = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      malloc: (size: number) => number;
      free: (p: number) => void;
      _initialize?: () => void;
      pdq_hash_rgb: (
        p: number,
        width: number,
        height: number,
        out: number,
      ) => number;
    };
    wasm._initialize?.();
    const input = wasm.malloc(frame.rgb.length), output = wasm.malloc(65);
    if (!input || !output) throw new Error("PDQ allocation failed");
    new Uint8Array(wasm.memory.buffer).set(frame.rgb, input);
    const quality = wasm.pdq_hash_rgb(input, frame.width, frame.height, output);
    const hash = new TextDecoder().decode(
      new Uint8Array(wasm.memory.buffer, output, 64),
    );
    wasm.free(input);
    wasm.free(output);
    if (quality < 0 || quality > 100 || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Invalid PDQ output");
    }
    workerScope.postMessage({ hash, quality });
  } catch {
    workerScope.postMessage({ error: "PDQ计算失败" });
  }
};

export {};
