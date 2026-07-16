-- M2 stage 4: E2EE rooms.
-- BREAKING FK DROP: group_members.device_id loses its FK to devices.device_id.
-- Room MLS leaves may be app_devices rows (SDK-registered app-session devices),
-- which live in a different table than real devices. Integrity is enforced in
-- the delivery service per group kind (dm -> devices, room -> devices|app_devices).
-- The composite PK (group_id, device_id) and group_members_device_idx remain.
-- groups.account_a/account_b become nullable: room groups have no dm pair.
CREATE TABLE "app_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"pub_id" text NOT NULL,
	"account_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"device_pk" "bytea" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_devices_device_pk_unique" UNIQUE("device_pk")
);
--> statement-breakpoint
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_device_id_devices_device_id_fk";
--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "account_a" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "account_b" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_devices" ADD CONSTRAINT "app_devices_pub_id_publications_pub_id_fk" FOREIGN KEY ("pub_id") REFERENCES "public"."publications"("pub_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_devices" ADD CONSTRAINT "app_devices_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_devices_account_idx" ON "app_devices" USING btree ("pub_id","account_id");