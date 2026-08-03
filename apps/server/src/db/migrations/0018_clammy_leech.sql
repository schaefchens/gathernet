CREATE TYPE "public"."channel_artifact_kind" AS ENUM('pin', 'link', 'media', 'event');--> statement-breakpoint
CREATE TABLE "channel_artifacts" (
	"artifact_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"community_id" text NOT NULL,
	"kind" "channel_artifact_kind" NOT NULL,
	"seal_epoch" integer NOT NULL,
	"sealed_body" "bytea" NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_sig" "bytea" NOT NULL,
	"approver_device_id" text,
	"approval_sig" "bytea",
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_artifacts" ADD CONSTRAINT "channel_artifacts_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_artifacts" ADD CONSTRAINT "channel_artifacts_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_artifacts" ADD CONSTRAINT "channel_artifacts_issuer_device_id_devices_device_id_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_artifacts" ADD CONSTRAINT "channel_artifacts_approver_device_id_devices_device_id_fk" FOREIGN KEY ("approver_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_artifacts" ADD CONSTRAINT "channel_artifacts_created_by_accounts_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_artifacts_channel_idx" ON "channel_artifacts" USING btree ("channel_id");