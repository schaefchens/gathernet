CREATE TYPE "public"."report_status" AS ENUM('pending', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TABLE "channel_report_recipients" (
	"report_id" text NOT NULL,
	"recipient_device_id" text NOT NULL,
	"sealed_report" "bytea" NOT NULL,
	"sender_pk_b64" text NOT NULL,
	CONSTRAINT "channel_report_recipients_report_id_recipient_device_id_pk" PRIMARY KEY("report_id","recipient_device_id")
);
--> statement-breakpoint
CREATE TABLE "channel_reports" (
	"report_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"community_id" text NOT NULL,
	"created_by" text NOT NULL,
	"reporter_device_id" text NOT NULL,
	"reporter_sig" "bytea" NOT NULL,
	"status" "report_status" DEFAULT 'pending' NOT NULL,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_report_recipients" ADD CONSTRAINT "channel_report_recipients_report_id_channel_reports_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."channel_reports"("report_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_report_recipients" ADD CONSTRAINT "channel_report_recipients_recipient_device_id_devices_device_id_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reports" ADD CONSTRAINT "channel_reports_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reports" ADD CONSTRAINT "channel_reports_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reports" ADD CONSTRAINT "channel_reports_created_by_accounts_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reports" ADD CONSTRAINT "channel_reports_reporter_device_id_devices_device_id_fk" FOREIGN KEY ("reporter_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reports" ADD CONSTRAINT "channel_reports_resolved_by_accounts_account_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_report_recipients_device_idx" ON "channel_report_recipients" USING btree ("recipient_device_id");--> statement-breakpoint
CREATE INDEX "channel_reports_channel_idx" ON "channel_reports" USING btree ("channel_id");