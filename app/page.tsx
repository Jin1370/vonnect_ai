import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import DubbingWorkspace from "@/components/DubbingWorkspace";

export default async function Dashboard() {
    const session = await getServerSession(authOptions);

    if (!session) {
        redirect("/login");
    }

    return (
        <main className="premium-container">
            <div
                className="glass-panel"
                style={{ maxWidth: "900px", width: "90%" }}
            >
                <h1 className="premium-title">Vonnect AI</h1>
                <p
                    className="premium-subtitle"
                    style={{ marginBottom: "1rem" }}
                >
                    Welcome, {session.user?.name}
                </p>

                {/* 클라이언트 컴포넌트로 워크스페이스(업로드 화면) 로드 */}
                <DubbingWorkspace />
            </div>
        </main>
    );
}
