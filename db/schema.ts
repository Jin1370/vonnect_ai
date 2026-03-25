import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"

export const whitelist = sqliteTable('whitelist', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().defaultNow(),
});

export const users = sqliteTable("user", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").notNull(),
  emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
  image: text("image"),
})

export const accounts = sqliteTable("account", {
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").$type<"oauth" | "oidc" | "email">().notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("providerAccountId").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (account) => ({
  compoundKey: primaryKey({ columns: [account.provider, account.providerAccountId] })
}))

export const sessions = sqliteTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
})

export const verificationTokens = sqliteTable("verificationToken", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
}, (vt) => ({
  compoundKey: primaryKey({ columns: [vt.identifier, vt.token] })
}))

export const dubbingJobs = sqliteTable("dubbing_jobs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  originalFileUrl: text("original_file_url").notNull(),
  targetLanguage: text("target_language").notNull(),
  status: text("status").notNull().default("PENDING"),
  dubbedFileUrl: text("dubbed_file_url"),
  errorMessage: text("error_message"),
  // Re-dub 지원: 세그먼트/번역/Voice Clone ID 보관
  segmentsJson: text("segments_json"),
  translationsJson: text("translations_json"),
  cloneVoiceMapJson: text("clone_voice_map_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().defaultNow(),
})
