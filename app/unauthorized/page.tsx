"use client";
import React from "react";
import Link from "next/link";

export default function UnauthorizedPage() {
    return (
        <main className="premium-container">
            <div className="glass-panel">
                <div className="error-icon">🚫</div>
                <h1 className="premium-title" style={{ fontSize: "2.2rem" }}>
                    접근 거부됨
                </h1>
                <p className="premium-subtitle">인증된 계정이 아닙니다.</p>
                <Link href="/login" className="btn-primary btn-accent">
                    돌아가기
                </Link>
            </div>
        </main>
    );
}
