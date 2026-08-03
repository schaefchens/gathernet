CREATE TABLE "message_media" (
	"media_id" text PRIMARY KEY NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploader_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_uploader_account_id_accounts_account_id_fk" FOREIGN KEY ("uploader_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;