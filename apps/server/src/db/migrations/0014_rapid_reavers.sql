-- Time-limited blocks: existing rows (if any) default to now() (already expired); the app always sets expires_at explicitly.
ALTER TABLE "blocks" ADD COLUMN "expires_at" timestamp with time zone NOT NULL DEFAULT now();
