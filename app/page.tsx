import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function Dashboard() {
  // 로그인된 여부를 서버단에서 가장 먼저 검사합니다.
  const session = await getServerSession(authOptions);

  if (!session) {
    // 세션이 없으면 무조건 로그인 창으로 내쫓음
    redirect("/login");
  }

  return (
    <main className="premium-container">
      <div className="glass-panel" style={{ maxWidth: '800px' }}>
        <h1 className="premium-title">AI 더빙 워크스페이스</h1>
        <p className="premium-subtitle">환영합니다! {session.user?.name}님 ({session.user?.email})</p>
        
        <div style={{ marginTop: '2rem', padding: '3rem 2rem', background: 'rgba(0,0,0,0.2)', borderRadius: '16px', border: '1px dashed rgba(255,255,255,0.2)'}}>
          <h3 style={{ fontSize: '1.2rem', marginBottom: '1rem', color: 'white' }}>파일 업로드 인터페이스는 여기에 배치됩니다</h3>
          <p style={{ color: '#94a3b8' }}>다음 단계에서 비디오 추출 및 번역 UI가 이 곳에 화려하게 구현됩니다.</p>
        </div>
      </div>
    </main>
  );
}
