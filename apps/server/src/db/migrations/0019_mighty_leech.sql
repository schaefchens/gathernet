CREATE TABLE "channel_artifact_participants" (
	"artifact_id" text NOT NULL,
	"account_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"device_id" text NOT NULL,
	"sig" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_artifact_participants_artifact_id_account_id_pk" PRIMARY KEY("artifact_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "channel_artifact_participants" ADD CONSTRAINT "channel_artifact_participants_artifact_id_channel_artifacts_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."channel_artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_artifact_participants" ADD CONSTRAINT "channel_artifact_participants_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_artifact_participants" ADD CONSTRAINT "channel_artifact_participants_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_artifact_participants" ADD CONSTRAINT "channel_artifact_participants_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_artifact_participants_channel_idx" ON "channel_artifact_participants" USING btree ("channel_id");