CREATE TABLE "community_key_epochs" (
	"community_id" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"key_commitment" "bytea" NOT NULL,
	"minter_device_id" text NOT NULL,
	"minter_sig" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_key_epochs_community_id_key_epoch_pk" PRIMARY KEY("community_id","key_epoch")
);
--> statement-breakpoint
ALTER TABLE "community_key_epochs" ADD CONSTRAINT "community_key_epochs_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_key_epochs" ADD CONSTRAINT "community_key_epochs_minter_device_id_devices_device_id_fk" FOREIGN KEY ("minter_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;