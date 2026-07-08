ALTER TABLE "l3_recommendation_items" DROP CONSTRAINT "l3_recommendation_items_proposal_owner_fk";
--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_proposal_owner_fk" FOREIGN KEY ("accepted_proposal_id","user_id") REFERENCES "public"."l3_proposals"("id","user_id") ON DELETE no action ON UPDATE no action;