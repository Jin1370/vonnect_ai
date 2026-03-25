"use client";
import React, { useState, useRef } from "react";
import { UploadCloud, FileAudio, PlayCircle, Loader2, ArrowRight, Users } from "lucide-react";

const PROCESSING_STEPS = [
  { key: "TRANSCRIBING", label: "🎙️ 음성 인식 & 화자 분리 중..." },
  { key: "TRANSLATING",  label: "🌐 화자별 번역 중..." },
  { key: "SYNTHESIZING", label: "🔊 화자별 목소리 합성 중..." },
  { key: "MIXING",       label: "🎚️ 타이밍 맞춰 오디오 믹싱 중..." },
];

export default function DubbingWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [lang, setLang] = useState("en");
  const [isProcessing, setIsProcessing] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [result, setResult] = useState<{
    mediaUrl: string;
    mediaType: "video" | "audio";
    fileExt: string;
    transcript: string;
    translatedText: string;
    speakerCount: number;
  } | null>(null);
  const [errorLine, setErrorLine] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) { setFile(e.target.files[0]); setResult(null); setErrorLine(""); }
  };

  const handleDubbing = async () => {
    if (!file) return;
    setIsProcessing(true);
    setResult(null);
    setErrorLine("");
    setStepIdx(0);

    // 진행 단계 애니메이션 (API 호출 중 시각적 피드백)
    const stepTimer = setInterval(() => {
      setStepIdx((i) => (i < PROCESSING_STEPS.length - 1 ? i + 1 : i));
    }, 8000);

    const formData = new FormData();
    formData.append("audio_file", file);
    formData.append("target_language", lang);

    try {
      const res = await fetch("/api/dubbing", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
    } catch (e: any) {
      setErrorLine(e.message);
    } finally {
      clearInterval(stepTimer);
      setIsProcessing(false);
      setStepIdx(0);
    }
  };

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
            onClick={() => !isProcessing && fileInputRef.current?.click()}
          >
            <input type="file" accept="audio/*,video/*" ref={fileInputRef} style={{ display: "none" }} onChange={handleFileChange} />
            {file ? <FileAudio size={48} color="var(--primary)" /> : <UploadCloud size={48} color="#94a3b8" />}
            <h3 style={{ marginTop: "1rem", color: file ? "white" : "#94a3b8" }}>
              {file ? file.name : "클릭하여 파일 업로드 (mp3, wav, mp4)"}
            </h3>
            {file && <p style={{ color: "#64748b", fontSize: "0.85rem" }}>{(file.size / 1024).toFixed(0)} KB</p>}
          </div>

          {file && !isProcessing && (
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

          {/* 진행 상태 표시 */}
          {isProcessing && (
            <div style={{ marginTop: "2rem", padding: "1.5rem", background: "rgba(99,102,241,0.08)", borderRadius: "12px", border: "1px solid rgba(99,102,241,0.2)" }}>
              {PROCESSING_STEPS.map((step, i) => (
                <div key={step.key} style={{
                  display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0",
                  opacity: i > stepIdx ? 0.3 : 1, transition: "opacity 0.5s",
                  color: i === stepIdx ? "white" : "#64748b",
                }}>
                  {i === stepIdx
                    ? <Loader2 size={18} className="animate-spin" style={{ color: "#818cf8" }} />
                    : i < stepIdx
                      ? <span style={{ color: "#34d399" }}>✓</span>
                      : <span style={{ color: "#475569" }}>○</span>}
                  <span style={{ fontSize: "0.95rem" }}>{step.label}</span>
                </div>
              ))}
              <p style={{ color: "#94a3b8", fontSize: "0.82rem", marginTop: "1rem" }}>
                ⏱️ 화자 수와 오디오 길이에 따라 20초~2분 정도 소요됩니다.
              </p>
            </div>
          )}
        </div>
      )}

      {/* 에러 피드백 */}
      {errorLine && (
        <div style={{ marginTop: "1rem", padding: "1rem", background: "rgba(239, 68, 68, 0.1)", color: "#fca5a5", borderRadius: "8px", border: "1px solid rgba(239, 68, 68, 0.3)" }}>
          ⚠️ 에러가 발생했습니다: {errorLine}
        </div>
      )}

      {/* 결과 화면 */}
      {result && (
        <div style={{ animation: "slideUpFade 0.6s ease-out" }}>
          <div style={{ padding: "2rem", background: "rgba(52, 211, 153, 0.05)", borderRadius: "16px", border: "1px solid rgba(52, 211, 153, 0.2)" }}>
            
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h2 style={{ fontSize: "1.4rem", color: "#10b981", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                🎉 더빙 완료!
              </h2>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0.9rem", background: "rgba(99,102,241,0.15)", borderRadius: "20px", border: "1px solid rgba(99,102,241,0.3)" }}>
                <Users size={14} style={{ color: "#818cf8" }} />
                <span style={{ color: "#818cf8", fontSize: "0.85rem" }}>{result.speakerCount}명의 화자 감지됨</span>
              </div>
            </div>

            {result.mediaType === "video" ? (
              <video controls src={result.mediaUrl}
                style={{ width: "100%", borderRadius: "10px", marginBottom: "1.5rem", outline: "none", background: "#000" }} />
            ) : (
              <audio controls src={result.mediaUrl} style={{ width: "100%", marginBottom: "1.5rem", outline: "none" }} />
            )}

            <a href={result.mediaUrl} download={`dubbed_result.${result.fileExt}`} style={{ textDecoration: "none" }} className="btn-primary">
              ⬇️ 더빙본 다운로드 ({result.fileExt.toUpperCase()})
            </a>

            <div style={{ marginTop: "2rem", display: "flex", gap: "1rem", alignItems: "stretch" }}>
              <div style={{ flex: 1, padding: "1rem", background: "rgba(0,0,0,0.3)", borderRadius: "8px" }}>
                <strong style={{ display: "block", color: "#94a3b8", fontSize: "0.82rem", marginBottom: "0.5rem" }}>원본 음성 (화자별)</strong>
                <pre style={{ margin: 0, fontSize: "0.85rem", whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{result.transcript}</pre>
              </div>
              <div style={{ display: "flex", alignItems: "center", color: "#94a3b8", flexShrink: 0 }}>
                <ArrowRight size={24} />
              </div>
              <div style={{ flex: 1, padding: "1rem", background: "linear-gradient(rgba(168,85,247,0.1), rgba(168,85,247,0.05))", borderRadius: "8px", border: "1px solid rgba(168,85,247,0.2)" }}>
                <strong style={{ display: "block", color: "#c084fc", fontSize: "0.82rem", marginBottom: "0.5rem" }}>번역 결과 (화자별)</strong>
                <pre style={{ margin: 0, fontSize: "0.85rem", whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{result.translatedText}</pre>
              </div>
            </div>

            <div style={{ marginTop: "1.5rem", textAlign: "center" }}>
              <button onClick={() => { setResult(null); setFile(null); }}
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
