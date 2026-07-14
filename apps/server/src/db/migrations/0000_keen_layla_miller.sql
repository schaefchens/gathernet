CREATE TYPE "public"."challenge_purpose" AS ENUM('enroll', 'login');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."presence_pref" AS ENUM('online', 'away', 'invisible');--> statement-breakpoint
CREATE TABLE "accounts" (
	"account_id" text PRIMARY KEY NOT NULL,
	"account_pk" "bytea" NOT NULL,
	"display_name" text NOT NULL,
	"presence_pref" "presence_pref" DEFAULT 'online' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_account_pk_unique" UNIQUE("account_pk")
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"challenge" "bytea" PRIMARY KEY NOT NULL,
	"purpose" "challenge_purpose" NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"device_pk" "bytea" NOT NULL,
	"cert" "bytea" NOT NULL,
	"cert_sig" "bytea" NOT NULL,
	"name" text NOT NULL,
	"status" "device_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_device_pk_unique" UNIQUE("device_pk")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"account_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_account_idx" ON "devices" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "sessions" USING btree ("device_id");