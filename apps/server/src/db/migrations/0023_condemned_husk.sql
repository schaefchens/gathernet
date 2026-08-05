CREATE TABLE "friend_request_recipients" (
	"request_id" uuid NOT NULL,
	"recipient_device_id" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"sender_pk_b64" text NOT NULL,
	CONSTRAINT "friend_request_recipients_request_id_recipient_device_id_pk" PRIMARY KEY("request_id","recipient_device_id")
);
--> statement-breakpoint
CREATE TABLE "friend_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_account_id" text NOT NULL,
	"to_account_id" text NOT NULL,
	"requester_device_id" text NOT NULL,
	"requester_sig" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "friend_request_recipients" ADD CONSTRAINT "friend_request_recipients_request_id_friend_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."friend_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_request_recipients" ADD CONSTRAINT "friend_request_recipients_recipient_device_id_devices_device_id_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_from_account_id_accounts_account_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_to_account_id_accounts_account_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_requester_device_id_devices_device_id_fk" FOREIGN KEY ("requester_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friend_request_recipients_device_idx" ON "friend_request_recipients" USING btree ("recipient_device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "friend_requests_pair_idx" ON "friend_requests" USING btree ("from_account_id","to_account_id");--> statement-breakpoint
CREATE INDEX "friend_requests_to_idx" ON "friend_requests" USING btree ("to_account_id");