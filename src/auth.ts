async function hmac(
  key: BufferSource,
  value: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)),
  );
}
export async function telegramAuth(
  data: string,
  token: string,
  now = Date.now(),
): Promise<{ user: number; session: string }> {
  const params = new URLSearchParams(data);
  const hash = params.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("无效签名");
  const seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) throw new Error("重复参数");
    seen.add(key);
  }
  params.delete("hash");
  const check = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map((
    [k, v],
  ) => `${k}=${v}`).join("\n");
  const key = await hmac(new TextEncoder().encode("WebAppData"), token);
  const signature = await hmac(key, check);
  let difference = 0;
  for (let i = 0; i < 32; i++) {
    difference |= signature[i] ^
      Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16);
  }
  if (difference) throw new Error("身份校验失败");
  const date = Number(params.get("auth_date"));
  if (
    !Number.isSafeInteger(date) || date <= 0 || now / 1000 - date > 300 ||
    date > now / 1000 + 30
  ) throw new Error("身份信息已过期，请重新打开");
  const user = JSON.parse(params.get("user") ?? "{}").id;
  const session = params.get("start_param") ?? "";
  if (
    !Number.isSafeInteger(user) || user <= 0 || !/^[a-f0-9]{32}$/.test(session)
  ) throw new Error("无效用户或申请");
  return { user, session };
}
