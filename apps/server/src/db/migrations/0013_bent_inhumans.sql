CREATE TABLE "membership_capabilities" (
	"community_id" text NOT NULL,
	"scope" text NOT NULL,
	"subject_account_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"role" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_sig" "bytea" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_capabilities_community_id_scope_subject_account_id_epoch_pk" PRIMARY KEY("community_id","scope","subject_account_id","epoch")
);
--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN "root_device_id" text;--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN "root_sig" "bytea";--> statement-breakpoint
ALTER TABLE "membership_capabilities" ADD CONSTRAINT "membership_capabilities_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_capabilities" ADD CONSTRAINT "membership_capabilities_subject_account_id_accounts_account_id_fk" FOREIGN KEY ("subject_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_capabilities" ADD CONSTRAINT "membership_capabilities_issuer_device_id_devices_device_id_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_capabilities" ADD CONSTRAINT "membership_capabilities_created_by_accounts_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_capabilities_subject_idx" ON "membership_capabilities" USING btree ("community_id","subject_account_id");--> statement-breakpoint
ALTER TABLE "communities" ADD CONSTRAINT "communities_root_device_id_devices_device_id_fk" FOREIGN KEY ("root_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;