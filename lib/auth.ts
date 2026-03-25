import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens, whitelist } from "@/db/schema";
import { eq } from "drizzle-orm";

export const authOptions: NextAuthOptions = {
  // @ts-ignore : Ignore type incompatibility between next-auth v4 and auth.js adapter
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false;

      try {
        // Check if email exists in the Turso DB whitelist table
        const allowedList = await db
          .select()
          .from(whitelist)
          .where(eq(whitelist.email, user.email))
          .limit(1);

        // Redirect unauthorized users to custom access denied page.
        if (allowedList.length === 0) {
          return "/unauthorized";
        }
        
        return true; 
      } catch (error) {
        console.error("DB error during whitelist authentication:", error);
        return false;
      }
    },
    jwt({ token, user }) {
      if (user) { token.id = user.id; }
      return token;
    },
    session({ session, token }) {
      if (session.user) { (session.user as any).id = token.id; }
      return session;
    }
  },
  pages: {
    signIn: "/login",
    error: "/unauthorized", // Page to redirect on access denial or error
  },
  session: {
    strategy: "jwt", // Manage auth sessions via tokens for performance optimization
  },
};
