CREATE TABLE "community_key_grants" (
	"community_id" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"grantee_device_id" text NOT NULL,
	"sealed_kmeta" "bytea" NOT NULL,
	"sender_pk_b64" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_key_grants_community_id_key_epoch_grantee_device_id_pk" PRIMARY KEY("community_id","key_epoch","grantee_device_id")
);
--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN "key_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "receipt_pk" "bytea";--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "receipt_pk_sig" "bytea";--> statement-breakpoint
ALTER TABLE "community_key_grants" ADD CONSTRAINT "community_key_grants_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_key_grants" ADD CONSTRAINT "community_key_grants_grantee_device_id_devices_device_id_fk" FOREIGN KEY ("grantee_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_key_grants" ADD CONSTRAINT "community_key_grants_created_by_accounts_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_key_grants_grantee_idx" ON "community_key_grants" USING btree ("grantee_device_id");