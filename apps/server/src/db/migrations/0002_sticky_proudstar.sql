CREATE TYPE "public"."mls_message_kind" AS ENUM('application', 'commit', 'proposal');--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"device_id" text NOT NULL,
	"account_id" text NOT NULL,
	"added_epoch" integer NOT NULL,
	"removed_epoch" integer,
	CONSTRAINT "group_members_group_id_device_id_pk" PRIMARY KEY("group_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"group_id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'dm' NOT NULL,
	"account_a" text NOT NULL,
	"account_b" text NOT NULL,
	"creator_account_id" text NOT NULL,
	"current_epoch" integer DEFAULT 0 NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"group_info" "bytea",
	"group_info_epoch" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_packages" (
	"ref" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"data" "bytea" NOT NULL,
	"is_last_resort" boolean DEFAULT false NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"consumed_by" text,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mls_cursors" (
	"group_id" text NOT NULL,
	"device_id" text NOT NULL,
	"acked_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mls_cursors_group_id_device_id_pk" PRIMARY KEY("group_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "mls_messages" (
	"group_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" "mls_message_kind" NOT NULL,
	"epoch" integer NOT NULL,
	"sender_device" text NOT NULL,
	"payload" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mls_messages_group_id_seq_pk" PRIMARY KEY("group_id","seq")
);
--> statement-breakpoint
CREATE TABLE "welcomes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "welcomes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"recipient_device" text NOT NULL,
	"group_id" text NOT NULL,
	"payload" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_account_a_accounts_account_id_fk" FOREIGN KEY ("account_a") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_account_b_accounts_account_id_fk" FOREIGN KEY ("account_b") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_cursors" ADD CONSTRAINT "mls_cursors_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_cursors" ADD CONSTRAINT "mls_cursors_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_messages" ADD CONSTRAINT "mls_messages_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcomes" ADD CONSTRAINT "welcomes_recipient_device_devices_device_id_fk" FOREIGN KEY ("recipient_device") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcomes" ADD CONSTRAINT "welcomes_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_device_idx" ON "group_members" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "key_packages_device_idx" ON "key_packages" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "welcomes_recipient_idx" ON "welcomes" USING btree ("recipient_device");