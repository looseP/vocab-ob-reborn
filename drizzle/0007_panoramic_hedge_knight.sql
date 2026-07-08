ALTER TABLE "l3_sources" DROP CONSTRAINT "l3_sources_wordbook_id_wordbooks_id_fk";
--> statement-breakpoint
ALTER TABLE "wordbooks" ADD CONSTRAINT "wordbooks_id_user_id_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "l3_sources" ADD CONSTRAINT "l3_sources_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;
