/**
 * L3 列表查询的分页上限（纯常量，零出向、零 IO）——**契约单点定义**。
 *
 * 为什么需要这个文件（2026-09-29）：`l3SourceListQuerySchema` 把 `limit` 上限定为
 * `max(50)`，而前端 `L3PapersPage.tsx` 硬编码了 `limit=100`。两边**各自都合法**
 * （Zod schema 通过、前端 TS 通过、契约测试两边都过），只在真实调用时炸：
 *
 *   GET /l3/sources?limit=100&sort=recent  →  400（Zod 拒绝）
 *   → 素材下拉只剩「选择阅读材料…」空选项
 *   → 粘贴建卷的 submit() 校验「第 N 节需要选阅读材料」后静默 return
 *   → 点击「建卷」零网络请求、零错误提示（`catch(() => setSources([]))` 吞掉了 400）
 *
 * 根因不是"少写了一个数"，而是**分页上限在前后端各写一份、没有共同真源**。
 * ��类漂移已实测排查：全仓其余 limit 调用（`/review/queue?limit=100`、
 * `/words?limit=1`、`/l3/sources?limit=5`、`/l3/occurrences?limit=20`）均正常，
 * 本轮只此一处越界。
 *
 * 修法纪律：**前端不再写裸数字**，改为引用本常量。这样上限再变时，
 * 改一处即可，且越界在类型层面就不可能发生。
 */

/**
 * `/l3/sources` 列表的 limit 上限。
 * 必须与 `l3SourceListQuerySchema` 的 `.max(...)` 保持一致 —— 二者同源于本常量。
 */
export const L3_SOURCE_LIST_LIMIT_MAX = 50;
