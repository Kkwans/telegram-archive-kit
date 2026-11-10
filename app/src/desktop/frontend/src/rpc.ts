import type { Reply } from "./types";

export async function call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reply = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!reply.ok) throw new Error(reply.error || "请求失败");
  return reply.result as T;
}

