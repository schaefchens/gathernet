CREATE TYPE "public"."channel_encryption_mode" AS ENUM('mls', 'group_key');--> statement-breakpoint
CREATE TABLE "channel_key_epochs" (
	"channel_id" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"key_commitment" "bytea" NOT NULL,
	"minter_device_id" text NOT NULL,
	"minter_sig" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_key_epochs_channel_id_key_epoch_pk" PRIMARY KEY("channel_id","key_epoch")
);
--> statement-breakpoint
CREATE TABLE "channel_key_grants" (
	"channel_id" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"grantee_device_id" text NOT NULL,
	"sealed_key" "bytea" NOT NULL,
	"sender_pk_b64" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_key_grants_channel_id_key_epoch_grantee_device_id_pk" PRIMARY KEY("channel_id","key_epoch","grantee_device_id")
);
--> statement-breakpoint
ALTER TABLE "community_channels" ADD COLUMN "encryption_mode" "channel_encryption_mode" DEFAULT 'mls' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_channels" ADD COLUMN "key_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "community_channels" ADD COLUMN "rotation_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_key_epochs" ADD CONSTRAINT "channel_key_epochs_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_key_epochs" ADD CONSTRAINT "channel_key_epochs_minter_device_id_devices_device_id_fk" FOREIGN KEY ("minter_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_key_grants" ADD CONSTRAINT "channel_key_grants_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_key_grants" ADD CONSTRAINT "channel_key_grants_grantee_device_id_devices_device_id_fk" FOREIGN KEY ("grantee_device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_key_grants" ADD CONSTRAINT "channel_key_grants_created_by_accounts_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_key_grants_grantee_idx" ON "channel_key_grants" USING btree ("grantee_device_id");