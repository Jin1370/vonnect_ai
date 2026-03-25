"use client";
import React from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/solid";
import Link from "next/link";

export default function UnauthorizedPage() {
    return (
        <main className="premium-container">
            <div className="glass-panel">
                <div className="error-icon">
                    <ExclamationTriangleIcon style={{ width: 40, height: 40 }} />
                </div>
                <h1 className="premium-title" style={{ fontSize: "2.2rem" }}>
                    Access Denied
                </h1>
                <p className="premium-subtitle">
                    Your account is not authorized to access this page.
                </p>
                <Link href="/login" className="btn-primary btn-accent">
                    Go Back
                </Link>
            </div>
        </main>
    );
}
