CREATE UNIQUE INDEX "idx_l3_import_jobs_user_input_hash"
	ON "l3_import_jobs" ("user_id", "input_hash")
	WHERE input_hash IS NOT NULL;
