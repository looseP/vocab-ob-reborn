/**
 * 默认词书访问（前端）。非 L3 面（复习 / 升级工作台）没有词书选择器，
 * 一律以服务端 `GET /api/wordbooks/default`（get-or-create）为准——
 * L1 复习队列、升级工单清单都挂在同一本默认词书上。
 *
 * 「一次取用并本地缓存」：模块级 Promise 缓存，同一会话内多次调用共享
 * 一次请求（失败时清缓存以便重试）。
 */
import { apiFetch } from "./client";

export interface DefaultWordbook {
  id: string;
  name: string;
}

let cached: Promise<DefaultWordbook> | null = null;

/** 取默认词书（模块级缓存，一次取用）。 */
export function getDefaultWordbook(): Promise<DefaultWordbook> {
  if (!cached) {
    cached = apiFetch<{ id: string; name: string }>("/wordbooks/default")
      .then((wordbook) => ({ id: wordbook.id, name: wordbook.name }))
      .catch((error) => {
        cached = null;
        throw error;
      });
  }
  return cached;
}

/** 测试用：清空模块级缓存。 */
export function resetDefaultWordbookCache(): void {
  cached = null;
}
