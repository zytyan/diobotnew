import type { Api } from "grammy";
import { fingerprint, Profiles, profileState } from "../src/profiles.ts";
function assert(v: unknown): asserts v {
  if (!v) throw new Error("assertion failed");
}
const user = { id: 42, is_bot: false, first_name: "Alice", username: "alice" };
Deno.test("资料缓存保留缺失状态，显示名实时更新；头像限制与模型数据隔离", async () => {
  let reads = 0;
  let now = 1000;
  let url = "";
  const api = {
    getChat: () => {
      reads++;
      return Promise.resolve({ type: "private", bio: "developer" });
    },
    getUserProfilePhotos: () =>
      Promise.resolve({
        photos: [[{ file_id: "photo", width: 160, height: 160 }]],
      }),
    getFile: () => Promise.resolve({ file_path: "photos/avatar.jpg" }),
  } as unknown as Pick<Api, "getChat" | "getUserProfilePhotos" | "getFile">;
  const request: typeof fetch = (input) => {
    url = String(input);
    return Promise.resolve(new Response(new Uint8Array([255, 216, 255, 1])));
  };
  const profiles = new Profiles(
    api,
    {
      token: "99:secret",
      environment: "test",
      apiRoot: "https://api.telegram.org",
    },
    request,
    () => now,
  );
  const first = await profiles.get(user);
  assert(
    first.avatar?.mime === "image/jpeg" && first.profile?.bio === "developer",
  );
  assert(
    url === "https://api.telegram.org/file/bot99:secret/test/photos/avatar.jpg",
  );
  const second = await profiles.get({ ...user, first_name: "Bob" });
  assert(reads === 1 && second.profile?.display_name === "Bob");
  assert(
    await fingerprint(profileState(first)) !==
      await fingerprint(profileState(second)),
  );
  const state = JSON.stringify(profileState(first));
  assert(
    !state.includes("secret") && !state.includes("base64") &&
      !state.includes("photo.jpg"),
  );
  now += 120001;
  await profiles.get(user);
  assert(Number(reads) === 2);
});
Deno.test("不可见 bio 和超限/无效头像降级，不阻断消息审核", async () => {
  const api = {
    getChat: () => Promise.reject(new Error("private")),
    getUserProfilePhotos: () =>
      Promise.resolve({
        photos: [[{ file_id: "x", width: 160, height: 160 }]],
      }),
    getFile: () => Promise.resolve({ file_path: "photos/x" }),
  } as unknown as Pick<Api, "getChat" | "getUserProfilePhotos" | "getFile">;
  for (const bytes of [new Uint8Array(131073), new Uint8Array([1, 2, 3])]) {
    const request: typeof fetch = () => Promise.resolve(new Response(bytes));
    const result = await new Profiles(api, {
      token: "99:fake",
      environment: "prod",
      apiRoot: "https://api.telegram.org",
    }, request).get(user);
    assert(
      !result.avatar && result.profile?.bio_status === "unavailable" &&
        result.profile?.avatar_status === "unavailable",
    );
  }
});

Deno.test("关闭头像后不请求照片、不复用其他群的头像缓存，再开启可恢复", async () => {
  let photos = 0;
  const api = {
    getChat: () => Promise.resolve({ type: "private", bio: "dev" }),
    getUserProfilePhotos: () => {
      photos++;
      return Promise.resolve({
        photos: [[{ file_id: "x", width: 160, height: 160 }]],
      });
    },
    getFile: () => Promise.resolve({ file_path: "avatar.jpg" }),
  } as unknown as Pick<Api, "getChat" | "getUserProfilePhotos" | "getFile">;
  const profiles = new Profiles(api, {
    token: "99:fake",
    environment: "test",
    apiRoot: "https://api.telegram.org",
  }, () => Promise.resolve(new Response(new Uint8Array([255, 216, 255]))));
  const enabled = await profiles.get(user, true);
  assert(photos === 1 && enabled.avatar);
  const disabled = await profiles.get(user, false);
  assert(
    photos === 1 && !disabled.avatar &&
      disabled.profile?.avatar_status === "disabled",
  );
  assert((await profiles.get(user, true)).avatar && photos === 1);
});

Deno.test("本地 Bot API 头像读取受目录、回环地址、符号链接和大小限制", async () => {
  const dir = await Deno.makeTempDir();
  const root = dir + "/bot-api";
  await Deno.mkdir(root);
  const bytes = new Uint8Array([255, 216, 255, 1]);
  await Deno.writeFile(root + "/avatar.jpg", bytes);
  await Deno.writeFile(dir + "/outside.jpg", bytes);
  await Deno.symlink(dir + "/outside.jpg", root + "/escape.jpg");
  await Deno.writeFile(root + "/large.jpg", new Uint8Array(131073));
  let downloads = 0;
  const read = (
    path: string,
    apiRoot = "http://127.0.0.1:8081",
    localFileRoot: string | undefined = root,
  ) => {
    const api = {
      getChat: () => Promise.resolve({ type: "private", bio: "dev" }),
      getUserProfilePhotos: () =>
        Promise.resolve({
          photos: [[{ file_id: "photo", width: 160, height: 160 }]],
        }),
      getFile: () => Promise.resolve({ file_path: path }),
    } as unknown as Pick<Api, "getChat" | "getUserProfilePhotos" | "getFile">;
    return new Profiles(api, {
      apiRoot,
      localFileRoot,
      token: "99:fake",
      environment: "prod",
    }, () => {
      downloads++;
      throw new Error("Local files must not use HTTP");
    }).get(user);
  };
  try {
    assert((await read(root + "/avatar.jpg")).avatar?.mime === "image/jpeg");
    for (
      const path of [
        dir + "/outside.jpg",
        root + "/escape.jpg",
        root + "/large.jpg",
        root + "/../outside.jpg",
      ]
    ) {
      const result = await read(path);
      assert(!result.avatar && result.profile?.avatar_status === "unavailable");
    }
    assert(
      !(await read(root + "/avatar.jpg", "https://api.telegram.org")).avatar,
    );
    assert(
      !(await read(root + "/avatar.jpg", "http://127.0.0.1:8081", "")).avatar,
    );
    assert(downloads === 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
