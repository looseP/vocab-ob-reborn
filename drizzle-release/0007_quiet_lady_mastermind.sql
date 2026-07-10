ALTER TABLE "llm_usage" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
UPDATE "llm_usage"
SET "status" = CASE WHEN "provider" = '__reservation__' THEN 'pending' ELSE 'settled' END,
    "expires_at" = CASE
      WHEN "provider" = '__reservation__' THEN "created_at" + interval '5 minutes'
      ELSE NULL
    END;--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "status" SET DEFAULT 'settled';--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "normalize_llm_usage_reservation_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Rolling-deploy compatibility: an old process inserts reservations without
  -- lifecycle columns. Normalize that legacy write before constraints run.
  IF TG_OP = 'INSERT'
     AND NEW.provider = '__reservation__'
     AND NEW.status = 'settled'
     AND NEW.expires_at IS NULL THEN
    NEW.status := 'pending';
    NEW.expires_at := now() + interval '5 minutes';
    NEW.finalized_at := NULL;
  END IF;

  -- Rolling-deploy compatibility: an old process settles by changing only the
  -- provider/model/token fields. Promote the pending row to settled.
  IF TG_OP = 'UPDATE'
     AND OLD.provider = '__reservation__'
     AND NEW.provider <> '__reservation__'
     AND NEW.status = 'pending' THEN
    NEW.status := 'settled';
    NEW.expires_at := NULL;
    NEW.finalized_at := now();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "trg_normalize_llm_usage_reservation_lifecycle"
BEFORE INSERT OR UPDATE ON "llm_usage"
FOR EACH ROW EXECUTE FUNCTION "normalize_llm_usage_reservation_lifecycle"();--> statement-breakpoint
CREATE INDEX "idx_llm_usage_pending_expiry" ON "llm_usage" USING btree ("expires_at","id") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'settled'::text, 'released'::text, 'expired'::text]));--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_reservation_lifecycle_check" CHECK ((status = 'settled' AND provider <> '__reservation__' AND expires_at IS NULL) OR (status = 'pending' AND provider = '__reservation__' AND expires_at IS NOT NULL AND finalized_at IS NULL) OR (status = ANY (ARRAY['released'::text, 'expired'::text]) AND provider = '__reservation__' AND expires_at IS NOT NULL AND finalized_at IS NOT NULL));
