CREATE TABLE "channel_reminder_fires" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "event_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_reminder_fires" ADD CONSTRAINT "channel_reminder_fires_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;