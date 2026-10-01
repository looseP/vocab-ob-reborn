-- L3 语境整句翻译缓存（2026-09-29）——新增两列 + 一条一致性 CHECK
--
-- 目的：让「圈词后点翻译」的结果**落库**。翻译走免费外部端点（Google 网页翻译
-- 端点 / MyMemory 备胎），而这些端点是**非官方、无 SLA、随时可能消失**的。
-- 一旦译文写进本行，用户已读过的文章就**永久可读**，与 provider 是否还活着无关。
-- 这是整个方案能接受「免费非官方端点」的前提。
--
-- 列设计：
--   1. translation      text | null  译文。NULL = 从未翻译（惰性生成，不预热）。
--   2. translation_src  text | null  provider id（'google-web' | 'mymemory'
--      | 'manual'），记录译文来源，便于将来按来源统计/重翻。
--   3. l3_contexts_translation_check  两列**全有或全无**：禁止出现
--      「有译文但没来源」或「有来源但没译文」——那会让重翻逻辑失去判据。
--
-- 幂等/去重：同句在文章里出现多次会落在**不同的 context 行**（每个圈记一行），
-- 本次不额外去重——重复翻译一次成本可忽略（免费端点），而按 (source_id, text)
-- 做唯一约束会改变 l3_contexts 的基数语义（一个 context 就是一次圈记）。

ALTER TABLE "l3_contexts" ADD COLUMN "translation" text;--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD COLUMN "translation_src" text;--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD CONSTRAINT "l3_contexts_translation_check" CHECK ((translation IS NULL AND translation_src IS NULL) OR (translation IS NOT NULL AND translation_src IS NOT NULL));
