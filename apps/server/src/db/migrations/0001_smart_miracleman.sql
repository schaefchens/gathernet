CREATE TABLE "blocks" (
	"blocker_account_id" text NOT NULL,
	"blocked_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_account_id_blocked_account_id_pk" PRIMARY KEY("blocker_account_id","blocked_account_id")
);
--> statement-breakpoint
CREATE TABLE "friend_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_account_id" text NOT NULL,
	"code" text NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friend_invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"account_a" text NOT NULL,
	"account_b" text NOT NULL,
	"invite_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_account_a_account_b_pk" PRIMARY KEY("account_a","account_b")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_account_id_accounts_account_id_fk" FOREIGN KEY ("blocker_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_account_id_accounts_account_id_fk" FOREIGN KEY ("blocked_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_invites" ADD CONSTRAINT "friend_invites_inviter_account_id_accounts_account_id_fk" FOREIGN KEY ("inviter_account_id") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_account_a_accounts_account_id_fk" FOREIGN KEY ("account_a") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_account_b_accounts_account_id_fk" FOREIGN KEY ("account_b") REFERENCES "public"."accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friend_invites_inviter_idx" ON "friend_invites" USING btree ("inviter_account_id");--> statement-breakpoint
CREATE INDEX "friendships_b_idx" ON "friendships" USING btree ("account_b");