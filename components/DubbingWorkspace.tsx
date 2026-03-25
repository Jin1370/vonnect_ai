"use client";
import React, { useState, useRef, useEffect, useCallback } from "react";
import {
    UploadCloud,
    FileAudio,
    PlayCircle,
    Loader2,
    ArrowRight,
    Users,
    RefreshCw,
    Scissors,
} from "lucide-react";
import { UserIcon } from "@heroicons/react/24/solid";
import { FFmpeg } from "@ffmpeg/ffmpeg";

// ── 단순화된 toBlobURL 헬퍼 (Next.js 빌드 에러 우회) ──
async function toBlobURL(url: string, mimeType: string): Promise<string> {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: mimeType });
    return URL.createObjectURL(blob);
}

// 화자별 고유 색상 팔레트 (6색, 초과 시 순환)
const SPEAKER_COLORS = [
    "#60a5fa", // 파랑
    "#f472b6", // 분홍
    "#34d399", // 초록
    "#fb923c", // 주황
    "#a78bfa", // 보라
    "#facc15", // 노랑
];

const PROCESSING_STEPS = [
    { key: "TRANSCRIBING", label: "🎙️ 음성 인식 & 화자 분리 중..." },
    { key: "TRANSLATING", label: "🌐 화자별 번역 중..." },
    { key: "SYNTHESIZING", label: "🔊 화자별 목소리 합성 중..." },
    { key: "MIXING", label: "🎚️ 타이밍 맞춰 오디오 믹싱 중..." },
];

// [speaker_N] → { speakerIdx, content } 변환 헬퍼
function formatSpeakerLines(
    text: string,
): { speakerIdx: number | null; content: string }[] {
    return text
        .split("\n")
        .map((line) => {
            const match = line.match(/^\[speaker_(\d+)\]\s*(.*)$/);
            if (match)
                return {
                    speakerIdx: parseInt(match[1], 10),
                    content: match[2],
                };
            return { speakerIdx: null, content: line };
        })
        .filter((l) => l.content.trim().length > 0);
}

interface EditableTranslation {
    speaker: string;
    original: string;
    translated: string;
    isSoundEffect: boolean;
}

interface DubbingResult {
    jobId: string;
    mediaUrl: string;
    mediaType: "video" | "audio";
    fileExt: string;
    transcript: string;
    translatedText: string;
    speakerCount: number;
    editableTranslations: EditableTranslation[];
}

// ── FFmpeg WASM 싱글턴 ──
let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoading = false;
let ffmpegReady = false;

async function getFFmpeg(): Promise<FFmpeg> {
    if (ffmpegReady && ffmpegInstance) return ffmpegInstance;
    if (!ffmpegInstance) {
        ffmpegInstance = new FFmpeg();
        ffmpegInstance.on("log", ({ message }) => {
            console.log("[FFmpeg]", message);
        });
    }
    
    if (!ffmpegLoading) {
        ffmpegLoading = true;
        try {
            if (typeof SharedArrayBuffer === "undefined") {
                throw new Error("SharedArrayBuffer를 지원하지 않는 브라우저이거나, COOP/COEP 헤더가 적용되지 않았습니다. 서버를 재시작해보세요.");
            }
            const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
            await ffmpegInstance.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
            });
            ffmpegReady = true;
        } catch (e: any) {
            ffmpegLoading = false;
            throw new Error(`FFmpeg 로드 실패: ${e?.message || String(e)}`);
        }
    } else {
        // 이미 로딩 중이면 대기
        while (!ffmpegReady) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    return ffmpegInstance;
}

// 60초 초과 파일을 클라이언트에서 크롭
async function cropTo60s(
    file: File,
    onProgress?: (msg: string) => void,
): Promise<File> {
    try {
        onProgress?.("FFmpeg 로드 중...");
        const ff = await getFFmpeg();
        const ext = file.name.split(".").pop() ?? "mp4";
        const inputName = `input.${ext}`;
        const outputName = `cropped.${ext}`;

        onProgress?.("파일 분석 중...");
        await ff.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

        onProgress?.("1분으로 자르는 중...");
        const execResult = await ff.exec([
            "-i", inputName,
            "-t", "60",
            "-c", "copy",
            "-y", outputName,
        ]);
        
        if (execResult !== 0) {
            throw new Error(`FFmpeg 변환 프로세스 실패 (코드: ${execResult})`);
        }

        const data = await ff.readFile(outputName);
        ff.deleteFile(inputName).catch(() => {});
        ff.deleteFile(outputName).catch(() => {});

        const mimeType = file.type || (ext === "mp3" ? "audio/mpeg" : "video/mp4");
        return new File([data as any], `cropped_${file.name}`, { type: mimeType });
    } catch (e: any) {
        console.error("Crop error:", e);
        throw new Error(e?.message || String(e));
    }
}

// 파일 재생 시간 감지 (HTMLMediaElement 이용)
function getMediaDuration(file: File): Promise<number> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const el = document.createElement(file.type.startsWith("video") ? "video" : "audio") as HTMLMediaElement;
        el.src = url;
        el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(el.duration); };
        el.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    });
}

export default function DubbingWorkspace() {
    const [file, setFile] = useState<File | null>(null);
    const [croppedFile, setCroppedFile] = useState<File | null>(null);
    const [cropStatus, setCropStatus] = useState<string>("");
    const [lang, setLang] = useState("en");
    const [isProcessing, setIsProcessing] = useState(false);
    const [isRedubbing, setIsRedubbing] = useState(false);
    const [stepIdx, setStepIdx] = useState(0);
    const [result, setResult] = useState<DubbingResult | null>(null);
    const [editedTranslations, setEditedTranslations] = useState<string[]>([]);
    const [errorLine, setErrorLine] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 탭 닫기 시 Voice Clone cleanup
    useEffect(() => {
        if (!result?.jobId) return;
        const jobId = result.jobId;
        const handleUnload = () => {
            navigator.sendBeacon(
                "/api/dubbing/cleanup",
                new Blob([JSON.stringify({ jobId })], { type: "application/json" }),
            );
        };
        window.addEventListener("beforeunload", handleUnload);
        return () => window.removeEventListener("beforeunload", handleUnload);
    }, [result?.jobId]);

    const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (!f) return;
        setFile(f);
        setResult(null);
        setErrorLine("");
        setCropStatus("");
        setCroppedFile(null);

        // 60초 초과 여부 확인 → 자동 크롭
        const duration = await getMediaDuration(f);
        if (duration > 60) {
            setCropStatus("preparing");
            try {
                const cropped = await cropTo60s(f, (msg) => setCropStatus(msg));
                setCroppedFile(cropped);
                setCropStatus("done");
            } catch (err: any) {
                setCropStatus("error");
                setErrorLine(`크롭 실패: ${err.message}`);
            }
        } else {
            setCroppedFile(f);
        }
    }, []);

    const handleDubbing = async () => {
        const uploadFile = croppedFile ?? file;
        if (!uploadFile) return;
        setIsProcessing(true);
        setResult(null);
        setErrorLine("");
        setStepIdx(0);

        const stepTimer = setInterval(() => {
            setStepIdx((i) => (i < PROCESSING_STEPS.length - 1 ? i + 1 : i));
        }, 8000);

        const formData = new FormData();
        formData.append("audio_file", uploadFile);
        formData.append("target_language", lang);

        try {
            const res = await fetch("/api/dubbing", { method: "POST", body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            setResult(data);
            setEditedTranslations(data.editableTranslations.map((t: EditableTranslation) => t.translated));
        } catch (e: any) {
            setErrorLine(e.message);
        } finally {
            clearInterval(stepTimer);
            setIsProcessing(false);
            setStepIdx(0);
        }
    };

    const handleRedub = async () => {
        const uploadFile = croppedFile ?? file;
        if (!uploadFile || !result) return;
        setIsRedubbing(true);
        setErrorLine("");

        const formData = new FormData();
        formData.append("audio_file", uploadFile);
        formData.append("job_id", result.jobId);
        formData.append("edited_translations", JSON.stringify(editedTranslations));

        try {
            const res = await fetch("/api/dubbing/remix", { method: "POST", body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            // 미디어URL만 교체, 나머지 결과는 유지
            setResult((prev) => prev ? { ...prev, mediaUrl: data.mediaUrl, mediaType: data.mediaType, fileExt: data.fileExt } : prev);
        } catch (e: any) {
            setErrorLine(e.message);
        } finally {
            setIsRedubbing(false);
        }
    };

    const hasEdits = result
        ? editedTranslations.some((t, i) => t !== result.editableTranslations[i]?.translated)
        : false;

    return (
        <div style={{ marginTop: "1.5rem", textAlign: "left" }}>
            {/* 업로드 패널 */}
            {!result && (
                <div style={{
                    padding: "2rem",
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: "16px",
                    border: file ? "1px solid var(--primary)" : "1px dashed rgba(255,255,255,0.2)",
                    transition: "all 0.3s",
                }}>
                    <div
                        style={{ display: "flex", flexDirection: "column", alignItems: "center", cursor: "pointer" }}
                        onClick={() => !isProcessing && cropStatus === "" && fileInputRef.current?.click()}
                    >
                        <input type="file" accept="audio/*,video/*" ref={fileInputRef} style={{ display: "none" }} onChange={handleFileChange} />
                        {file ? <FileAudio size={48} color="var(--primary)" /> : <UploadCloud size={48} color="#94a3b8" />}
                        <h3 style={{ marginTop: "1rem", color: file ? "white" : "#94a3b8" }}>
                            {file ? file.name : "클릭하여 파일 업로드 (mp3, wav, mp4)"}
                        </h3>
                        {file && <p style={{ color: "#64748b", fontSize: "0.85rem" }}>{(file.size / 1024 / 1024).toFixed(1)} MB</p>}
                    </div>

                    {/* 크롭 상태 표시 */}
                    {cropStatus && cropStatus !== "done" && cropStatus !== "error" && (
                        <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "rgba(251,146,60,0.1)", borderRadius: "8px", border: "1px solid rgba(251,146,60,0.3)", display: "flex", alignItems: "center", gap: "0.6rem" }}>
                            <Scissors size={16} style={{ color: "#fb923c" }} />
                            <span style={{ color: "#fed7aa", fontSize: "0.88rem" }}>
                                1분 초과 감지 — {cropStatus}
                            </span>
                            <Loader2 size={14} className="animate-spin" style={{ color: "#fb923c" }} />
                        </div>
                    )}
                    {cropStatus === "done" && (
                        <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "rgba(52,211,153,0.1)", borderRadius: "8px", border: "1px solid rgba(52,211,153,0.2)", display: "flex", alignItems: "center", gap: "0.6rem" }}>
                            <Scissors size={16} style={{ color: "#34d399" }} />
                            <span style={{ color: "#a7f3d0", fontSize: "0.88rem" }}>앞 1분을 자동 크롭했습니다</span>
                        </div>
                    )}

                    {file && (cropStatus === "done" || cropStatus === "") && !isProcessing && (
                        <div style={{ marginTop: "2rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                                <label style={{ fontSize: "0.9rem", color: "#cbd5e1", marginBottom: "0.5rem" }}>더빙할 언어 선택</label>
                                <select value={lang} onChange={(e) => setLang(e.target.value)}
                                    style={{ padding: "0.8rem", borderRadius: "8px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.1)", color: "white", outline: "none" }}>
                                    <option value="en">영어 (English)</option>
                                    <option value="ja">일본어 (Japanese)</option>
                                    <option value="ko">한국어 (Korean)</option>
                                    <option value="es">스페인어 (Spanish)</option>
                                    <option value="fr">프랑스어 (French)</option>
                                    <option value="de">독일어 (German)</option>
                                    <option value="zh">중국어 (Chinese)</option>
                                </select>
                            </div>
                            <div style={{ display: "flex", alignItems: "flex-end" }}>
                                <button className="btn-primary btn-accent" onClick={handleDubbing} style={{ height: "3.1rem" }}>
                                    <PlayCircle size={20} /> 더빙 시작
                                </button>
                            </div>
                        </div>
                    )}

                    {isProcessing && (
                        <div style={{ marginTop: "2rem", padding: "1.5rem", background: "rgba(99,102,241,0.08)", borderRadius: "12px", border: "1px solid rgba(99,102,241,0.2)" }}>
                            {PROCESSING_STEPS.map((step, i) => (
                                <div key={step.key} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", opacity: i > stepIdx ? 0.3 : 1, transition: "opacity 0.5s", color: i === stepIdx ? "white" : "#64748b" }}>
                                    {i === stepIdx ? <Loader2 size={18} className="animate-spin" style={{ color: "#818cf8" }} /> : i < stepIdx ? <span style={{ color: "#34d399" }}>✓</span> : <span style={{ color: "#475569" }}>○</span>}
                                    <span style={{ fontSize: "0.95rem" }}>{step.label}</span>
                                </div>
                            ))}
                            <p style={{ color: "#94a3b8", fontSize: "0.82rem", marginTop: "1rem" }}>⏱️ 화자 수와 오디오 길이에 따라 20초~2분 정도 소요됩니다.</p>
                        </div>
                    )}
                </div>
            )}

            {/* 에러 피드백 */}
            {errorLine && (
                <div style={{ marginTop: "1rem", padding: "1rem", background: "rgba(239,68,68,0.1)", color: "#fca5a5", borderRadius: "8px", border: "1px solid rgba(239,68,68,0.3)" }}>
                    ⚠️ 에러가 발생했습니다: {errorLine}
                </div>
            )}

            {/* 결과 화면 */}
            {result && (
                <div style={{ animation: "slideUpFade 0.6s ease-out" }}>
                    <div style={{ padding: "2rem", background: "rgba(52,211,153,0.05)", borderRadius: "16px", border: "1px solid rgba(52,211,153,0.2)" }}>

                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
                            <h2 style={{ fontSize: "1.4rem", color: "#10b981", display: "flex", alignItems: "center", gap: "0.5rem" }}>🎉 더빙 완료!</h2>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0.9rem", background: "rgba(99,102,241,0.15)", borderRadius: "20px", border: "1px solid rgba(99,102,241,0.3)" }}>
                                <Users size={14} style={{ color: "#818cf8" }} />
                                <span style={{ color: "#818cf8", fontSize: "0.85rem" }}>{result.speakerCount}명의 화자 감지됨</span>
                            </div>
                        </div>

                        {result.mediaType === "video" ? (
                            <video controls src={result.mediaUrl} style={{ width: "100%", borderRadius: "10px", marginBottom: "1.5rem", outline: "none", background: "#000" }} />
                        ) : (
                            <audio controls src={result.mediaUrl} style={{ width: "100%", marginBottom: "1.5rem", outline: "none" }} />
                        )}

                        <a href={result.mediaUrl} download={`dubbed_result.${result.fileExt}`} style={{ textDecoration: "none" }} className="btn-primary">
                            ⬇️ 더빙본 다운로드 ({result.fileExt.toUpperCase()})
                        </a>

                        {/* 원본 + 번역 패널 */}
                        <div style={{ marginTop: "2rem", display: "flex", gap: "1rem", alignItems: "stretch" }}>
                            {/* 원본 */}
                            <div style={{ flex: 1, padding: "1rem", background: "rgba(0,0,0,0.3)", borderRadius: "8px" }}>
                                <strong style={{ display: "block", color: "#94a3b8", fontSize: "0.82rem", marginBottom: "0.75rem" }}>원본 음성</strong>
                                {formatSpeakerLines(result.transcript).map((line, i) => {
                                    const color = line.speakerIdx !== null ? SPEAKER_COLORS[line.speakerIdx % SPEAKER_COLORS.length] : "transparent";
                                    return (
                                        <div key={i} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.4rem", alignItems: "flex-start", fontSize: "0.85rem", lineHeight: 1.6 }}>
                                            {line.speakerIdx !== null && <UserIcon style={{ width: 16, height: 16, color, flexShrink: 0, marginTop: 3 }} />}
                                            <span style={{ color: "#e2e8f0" }}>{line.content}</span>
                                        </div>
                                    );
                                })}
                            </div>

                            <div style={{ display: "flex", alignItems: "center", color: "#94a3b8", flexShrink: 0 }}>
                                <ArrowRight size={24} />
                            </div>

                            {/* 번역 (편집 가능) */}
                            <div style={{ flex: 1, padding: "1rem", background: "linear-gradient(rgba(168,85,247,0.1), rgba(168,85,247,0.05))", borderRadius: "8px", border: "1px solid rgba(168,85,247,0.2)" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                                    <strong style={{ color: "#c084fc", fontSize: "0.82rem" }}>번역 결과 (편집 가능)</strong>
                                    {hasEdits && (
                                        <span style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", background: "rgba(251,146,60,0.2)", color: "#fb923c", borderRadius: "10px", border: "1px solid rgba(251,146,60,0.3)" }}>
                                            ✏️ 수정됨
                                        </span>
                                    )}
                                </div>
                                {result.editableTranslations.map((item, i) => {
                                    const displayText = item.isSoundEffect ? (item.translated || item.original) : item.translated;
                                    if (!displayText.trim()) return null;
                                    const spkIdx = parseInt(item.speaker.replace("speaker_", ""), 10);
                                    const color = SPEAKER_COLORS[spkIdx % SPEAKER_COLORS.length];
                                    return (
                                        <div key={i} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                                            <UserIcon style={{ width: 16, height: 16, color, flexShrink: 0 }} />
                                            {item.isSoundEffect ? (
                                                <div style={{ flex: 1, padding: "0.3rem 0.6rem", color: "#64748b", fontSize: "0.85rem", fontStyle: "italic" }}>
                                                    {item.translated || item.original}
                                                </div>
                                            ) : (
                                                <input
                                                    value={editedTranslations[i] ?? ""}
                                                    onChange={(e) => {
                                                        const next = [...editedTranslations];
                                                        next[i] = e.target.value;
                                                        setEditedTranslations(next);
                                                    }}
                                                    style={{
                                                        flex: 1,
                                                        background: "rgba(0,0,0,0.3)",
                                                        border: editedTranslations[i] !== item.translated
                                                            ? "1px solid rgba(251,146,60,0.5)"
                                                            : "1px solid rgba(255,255,255,0.08)",
                                                        borderRadius: "6px",
                                                        color: "#e2e8f0",
                                                        padding: "0.3rem 0.6rem",
                                                        fontSize: "0.85rem",
                                                        outline: "none",
                                                    }}
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* 다시 만들기 버튼 */}
                        <div style={{ marginTop: "1.25rem", display: "flex", gap: "1rem", justifyContent: "flex-end", alignItems: "center" }}>
                            {isRedubbing && <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>🔄 재생성 중...</span>}
                            <button
                                onClick={handleRedub}
                                disabled={isRedubbing || !hasEdits}
                                style={{
                                    display: "flex", alignItems: "center", gap: "0.5rem",
                                    padding: "0.65rem 1.2rem",
                                    background: hasEdits ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.05)",
                                    border: hasEdits ? "1px solid rgba(99,102,241,0.5)" : "1px solid rgba(255,255,255,0.1)",
                                    borderRadius: "8px",
                                    color: hasEdits ? "#818cf8" : "#475569",
                                    cursor: hasEdits && !isRedubbing ? "pointer" : "not-allowed",
                                    fontSize: "0.9rem",
                                    transition: "all 0.2s",
                                }}
                            >
                                {isRedubbing
                                    ? <Loader2 size={16} className="animate-spin" />
                                    : <RefreshCw size={16} />}
                                다시 만들기
                            </button>
                        </div>

                        <div style={{ marginTop: "1.5rem", textAlign: "center" }}>
                            <button onClick={async () => {
                                // 기존 작업이 있으면 백그라운드로 클린업 호출
                                if (result?.jobId) {
                                    fetch("/api/dubbing/cleanup", {
                                        method: "POST",
                                        body: JSON.stringify({ jobId: result.jobId }),
                                        headers: { "Content-Type": "application/json" }
                                    }).catch(() => {});
                                }
                                setResult(null);
                                setFile(null);
                                setCroppedFile(null);
                                setCropStatus("");
                                }}
                                style={{ background: "transparent", border: "none", color: "#3b82f6", cursor: "pointer", textDecoration: "underline" }}>
                                다른 파일 더빙하기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <style dangerouslySetInnerHTML={{ __html: `
                .animate-spin { animation: spin 1s linear infinite; }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            ` }} />
        </div>
    );
}
