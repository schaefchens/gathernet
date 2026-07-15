CREATE TYPE "public"."channel_access" AS ENUM('members', 'leaders');--> statement-breakpoint
CREATE TYPE "public"."community_member_status" AS ENUM('active', 'left', 'removed');--> statement-breakpoint
CREATE TYPE "public"."community_role" AS ENUM('owner', 'leader', 'member');--> statement-breakpoint
CREATE TYPE "public"."grant_code_status" AS ENUM('pending', 'approved', 'denied', 'consumed');--> statement-breakpoint
CREATE TYPE "public"."join_request_status" AS ENUM('pending', 'approved', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'unlisted', 'listed');--> statement-breakpoint
CREATE TYPE "public"."publication_kind" AS ENUM('app', 'game', 'book', 'video');--> statement-breakpoint
CREATE TYPE "public"."room_member_status" AS ENUM('active', 'left', 'kicked');--> statement-breakpoint
CREATE TYPE "public"."room_phase" AS ENUM('open', 'in_progress', 'closed');--> statement-breakpoint
CREATE TYPE "public"."room_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE "app_accounts" (
	"pub_id" text NOT NULL,
	"account_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_accounts_pub_id_account_id_pk" PRIMARY KEY("pub_id","account_id"),
	CONSTRAINT "app_accounts_app_user_id_unique" UNIQUE("app_user_id")
);
--> statement-breakpoint
CREATE TABLE "app_configs" (
	"pub_id" text PRIMARY KEY NOT NULL,
	"origins" text[] NOT NULL,
	"allowed_scopes" text[] NOT NULL,
	"service_account_id" text
);
--> statement-breakpoint
CREATE TABLE "app_grant_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pub_id" text NOT NULL,
	"user_code" text NOT NULL,
	"poll_secret_hash" "bytea" NOT NULL,
	"requested_scopes" text[] NOT NULL,
	"app_ephemeral_pk" "bytea",
	"status" "grant_code_status" DEFAULT 'pending' NOT NULL,
	"account_id" text,
	"granted_scopes" text[],
	"sealed_storage_key" "bytea",
	"hub_ephemeral_pk" "bytea",
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_grant_codes_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "app_grant_codes_poll_secret_hash_unique" UNIQUE("poll_secret_hash")
);
--> statement-breakpoint
CREATE TABLE "app_grants" (
	"pub_id" text NOT NULL,
	"account_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_grants_pub_id_account_id_pk" PRIMARY KEY("pub_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "app_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pub_id" text NOT NULL,
	"account_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "app_storage" (
	"pub_id" text NOT NULL,
	"account_id" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_storage_pub_id_account_id_key_pk" PRIMARY KEY("pub_id","account_id","key")
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"community_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon_url" text,
	"owner_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"access" "channel_access" DEFAULT 'members' NOT NULL,
	"join_default" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" text NOT NULL,
	"creator_account_id" text NOT NULL,
	"code" text NOT NULL,
	"max_uses" integer DEFAULT 25 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "community_members" (
	"community_id" text NOT NULL,
	"account_id" text NOT NULL,
	"role" "community_role" DEFAULT 'member' NOT NULL,
	"status" "community_member_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "community_members_community_id_account_id_pk" PRIMARY KEY("community_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"pub_id" text PRIMARY KEY NOT NULL,
	"kind" "publication_kind" NOT NULL,
	"publisher_account_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon_url" text,
	"listing" "listing_status" DEFAULT 'unlisted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" text NOT NULL,
	"account_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"status" "join_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" text NOT NULL,
	"account_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"is_service" boolean DEFAULT false NOT NULL,
	"status" "room_member_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "room_members_room_id_account_id_pk" PRIMARY KEY("room_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"room_id" text PRIMARY KEY NOT NULL,
	"pub_id" text NOT NULL,
	"code" text NOT NULL,
	"visibility" "room_visibility" DEFAULT 'private' NOT NULL,
	"title" text NOT NULL,
	"host_account_id" text NOT NULL,
	"max_members" integer DEFAULT 16 NOT NULL,
	"compat_tag" text NOT NULL,
	"phase" "room_phase" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_accounts" ADD CONSTRAINT "app_accounts_pub_id_publications_pub_id_fk" FOREIGN KEY ("pub_id") REFERENCES "public"."publications"("pub_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_accounts" ADD CONSTRAINT "app_accounts_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_configs" ADD CONSTRAINT "app_configs_pub_id_publications_pub_id_fk" FOREIGN KEY ("pub_id") REFERENCES "public"."publications"("pub_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_configs" ADD CONSTRAINT "app_configs_service_account_id_accounts_account_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grant_codes" ADD CONSTRAINT "app_grant_codes_pub_id_publications_pub_id_fk" FOREIGN KEY ("pub_id") REFERENCES "public"."publications"("pub_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grant_codes" ADD CONSTRAINT "app_grant_codes_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_pub_id_publications_pub_id_fk" FOREIGN KEY ("pub_id") REFERENCES "public"."publications"("pub_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_pub_id_publications_pub_id_fk" FOREIGN KEY ("pub_id") REFERENCES "public"."publications"("pub_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_storage" ADD CONSTRAINT "app_storage_pub_id_publications_pub_id_fk" FOREIGN KEY ("pub_id") REFERENCES "public"."publications"("pub_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_storage" ADD CONSTRAINT "app_storage_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communities" ADD CONSTRAINT "communities_owner_account_id_accounts_account_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_channels" ADD CONSTRAINT "community_channels_channel_id_groups_group_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."groups"("group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_channels" ADD CONSTRAINT "community_channels_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_invites" ADD CONSTRAINT "community_invites_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_invites" ADD CONSTRAINT "community_invites_creator_account_id_accounts_account_id_fk" FOREIGN KEY ("creator_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_publisher_account_id_accounts_account_id_fk" FOREIGN KEY ("publisher_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_join_requests" ADD CONSTRAINT "room_join_requests_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_room_id_groups_group_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."groups"("group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_pub_id_publications_pub_id_fk" FOREIGN KEY ("pub_id") REFERENCES "public"."publications"("pub_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_account_id_accounts_account_id_fk" FOREIGN KEY ("host_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_sessions_account_idx" ON "app_sessions" USING btree ("account_id","pub_id");--> statement-breakpoint
CREATE INDEX "community_channels_community_idx" ON "community_channels" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "community_invites_community_idx" ON "community_invites" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "rooms_browse_idx" ON "rooms" USING btree ("pub_id","visibility","phase");--> statement-breakpoint
CREATE INDEX "rooms_code_idx" ON "rooms" USING btree ("pub_id","code");