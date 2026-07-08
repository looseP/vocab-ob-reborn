ALTER TABLE "l3_sources" ADD CONSTRAINT "l3_sources_id_user_id_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD CONSTRAINT "l3_contexts_id_user_id_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD CONSTRAINT "l3_contexts_source_owner_fk" FOREIGN KEY ("source_id","user_id") REFERENCES "public"."l3_sources"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_occurrences" ADD CONSTRAINT "l3_occurrences_context_owner_fk" FOREIGN KEY ("context_id","user_id") REFERENCES "public"."l3_contexts"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_context_links" ADD CONSTRAINT "l3_context_links_context_owner_fk" FOREIGN KEY ("context_id","user_id") REFERENCES "public"."l3_contexts"("id","user_id") ON DELETE cascade ON UPDATE no action;
