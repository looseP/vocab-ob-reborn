-- 0032: ADR-0030 §1/§2 —— L3 题目与试卷实体（试卷工作台 V1）。
--
-- 范围与语义：
--   * l3_questions：题目实体，与 l3_contexts（词的用法）严格分离。题干 stem /
--     选项 options / 标准答案 answer / 解析 explanation / 证据锚点 evidence 均
--     jsonb（形态按 question_type 分化，由服务层契约校验）。做题文件是派生
--     视图而非表：有正文文件 = (source_id, question_type) 题组聚合；无正文题组
--     （翻译/作文）由 file_key 定界——CHECK l3_questions_identity_check 保证
--     二者至少居其一。space 由题型自动映射写入（ADR-0030 §3）。
--     status pending|active|rejected：owner/trusted 直写 active；pending 通道
--     为后续 agent 波次预留（列先落库，不开放端点）。created_by 服务端认定。
--   * l3_papers：试卷，卷面结构存 payload jsonb（学 l3_sessions.plan 的引用
--     哲学），不建 sections 表；payload_version + 服务层写入校验 + 渲染降级 +
--     删题 409 构成引用完整性三护栏。
--   * 两表均 own_all RLS；复合 owner FK（questions→l3_sources）在 DB 层防越权
--     挂源，source 删除级联（卷面缺失引用走降级占位）；input_hash partial unique
--     为 agent submit_paper 幂等预留（0031/0006 范式）。
--
-- 幂等与回滚：drizzle-kit 生成物（journal 追踪，单次应用），forward-compatible、
-- 无自动 down（见 scripts/verify-rollback-compatibility.ts）。
-- ROLLBACK（人工执行）：
--   DROP TABLE IF EXISTS "l3_questions"; DROP TABLE IF EXISTS "l3_papers";
-- GRANT 由 scripts/bootstrap-database-roles.ts converge 提供；回滚后需重跑 converge。
CREATE TABLE "l3_papers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"direction" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"input_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_papers_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_papers_direction_check" CHECK (direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text])),
	CONSTRAINT "l3_papers_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_papers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid,
	"file_key" text,
	"space" text NOT NULL,
	"question_type" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"stem" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"explanation" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"input_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_questions_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_questions_identity_check" CHECK (source_id IS NOT NULL OR file_key IS NOT NULL),
	CONSTRAINT "l3_questions_space_check" CHECK (space = ANY (ARRAY['语法'::text, '阅读'::text, '作文'::text, '翻译'::text, '通用'::text])),
	CONSTRAINT "l3_questions_question_type_check" CHECK (question_type = ANY (ARRAY['cloze'::text, 'reading_choice'::text, 'new_question'::text, 'sentence_translation'::text, 'short_essay'::text, 'long_essay'::text, 'grammar_blank'::text])),
	CONSTRAINT "l3_questions_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'rejected'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_papers" ADD CONSTRAINT "l3_papers_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_questions" ADD CONSTRAINT "l3_questions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_questions" ADD CONSTRAINT "l3_questions_source_owner_fk" FOREIGN KEY ("source_id","user_id") REFERENCES "public"."l3_sources"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_papers_user_created" ON "l3_papers" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_papers_user_status" ON "l3_papers" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "l3_papers_user_input_hash_unique" ON "l3_papers" USING btree ("user_id","input_hash") WHERE input_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_l3_questions_source_type_ordinal" ON "l3_questions" USING btree ("user_id","source_id","question_type","ordinal");--> statement-breakpoint
CREATE INDEX "idx_l3_questions_file_key" ON "l3_questions" USING btree ("user_id","file_key");--> statement-breakpoint
CREATE INDEX "idx_l3_questions_user_type_status" ON "l3_questions" USING btree ("user_id","question_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "l3_questions_user_input_hash_unique" ON "l3_questions" USING btree ("user_id","input_hash") WHERE input_hash IS NOT NULL;--> statement-breakpoint
CREATE POLICY "l3_papers_own_all" ON "l3_papers" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_questions_own_all" ON "l3_questions" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));