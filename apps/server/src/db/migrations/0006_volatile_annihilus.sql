CREATE TYPE "public"."channel_invite_kind" AS ENUM('code', 'targeted');--> statement-breakpoint
CREATE TYPE "public"."channel_join_policy" AS ENUM('open', 'request');--> statement-breakpoint
CREATE TYPE "public"."channel_member_role" AS ENUM('member', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."channel_member_status" AS ENUM('active', 'pending', 'invited', 'removed');--> statement-breakpoint
CREATE TYPE "public"."channel_visibility" AS ENUM('listed', 'unlisted');--> statement-breakpoint
CREATE TABLE "channel_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"kind" "channel_invite_kind" NOT NULL,
	"code" text,
	"invitee_account_id" text,
	"created_by" text NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"channel_id" text NOT NULL,
	"account_id" text NOT NULL,
	"status" "channel_member_status" DEFAULT 'active' NOT NULL,
	"role" "channel_member_role" DEFAULT 'member' NOT NULL,
	"invited_by" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_members_channel_id_account_id_pk" PRIMARY KEY("channel_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "community_media" (
	"media_id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN "meta_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN "avatar_media_id" text;--> statement-breakpoint
ALTER TABLE "community_channels" ADD COLUMN "meta_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "community_channels" ADD COLUMN "avatar_media_id" text;--> statement-breakpoint
ALTER TABLE "community_channels" ADD COLUMN "visibility" "channel_visibility" DEFAULT 'listed' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_channels" ADD COLUMN "join_policy" "channel_join_policy" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_channels" ADD COLUMN "message_ttl_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_invites" ADD CONSTRAINT "channel_invites_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_invites" ADD CONSTRAINT "channel_invites_created_by_accounts_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_community_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_media" ADD CONSTRAINT "community_media_community_id_communities_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_invites_channel_idx" ON "channel_invites" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "channel_members_account_idx" ON "channel_members" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "communities" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "communities" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "communities" DROP COLUMN "icon_url";--> statement-breakpoint
ALTER TABLE "community_channels" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "community_channels" DROP COLUMN "join_default";