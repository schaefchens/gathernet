CREATE TABLE "channel_artifact_tickets" (
	"artifact_id" text NOT NULL,
	"ticket_hash" text NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_artifact_tickets_artifact_id_ticket_hash_pk" PRIMARY KEY("artifact_id","ticket_hash")
);
--> statement-breakpoint
ALTER TABLE "channel_artifact_tickets" ADD CONSTRAINT "channel_artifact_tickets_artifact_id_channel_artifacts_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."channel_artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_artifact_tickets" ADD CONSTRAINT "channel_artifact_tickets_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_artifact_tickets_channel_idx" ON "channel_artifact_tickets" USING btree ("channel_id");--> statement-breakpoint
-- Event RSVPs are anonymous tickets from now on: drop the previously-stored
-- (artifact, account) associations. Privacy-positive and dev-only data.
DELETE FROM "channel_artifact_participants";
