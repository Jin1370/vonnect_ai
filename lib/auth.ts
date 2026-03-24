import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens, whitelist } from "@/db/schema";
import { eq } from "drizzle-orm";

export const authOptions: NextAuthOptions = {
  // @ts-ignore : next-auth v4와 auth.js 어댑터 간의 버전 타입 호환 무시
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
        // 방금 만든 Turso DB의 whitelist 테이블에서 이메일 일치 여부 검사
        const allowedList = await db
          .select()
          .from(whitelist)
          .where(eq(whitelist.email, user.email))
          .limit(1);

        // 화이트리스트에 없는 사용자는 커스텀 거부 페이지로 튕겨냅니다.
        if (allowedList.length === 0) {
          return "/unauthorized";
        }
        
        return true; 
      } catch (error) {
        console.error("화이트리스트 인증 중 DB 에러:", error);
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
    error: "/unauthorized", // 접근 거부 혹은 에러 시 가는 페이지 표기
  },
  session: {
    strategy: "jwt", // 인증 세션을 토큰 기반으로 관리하여 속도 최적화
  },
};
