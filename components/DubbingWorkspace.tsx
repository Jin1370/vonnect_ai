"use client";
import React, { useState, useRef } from "react";
import { UploadCloud, FileAudio, PlayCircle, Loader2, ArrowRight } from "lucide-react";

export default function DubbingWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [lang, setLang] = useState("en"); // 기본: 영어
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<{ audioUrl: string; transcript: string; translatedText: string } | null>(null);
  const [errorLine, setErrorLine] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };

  const handleDubbing = async () => {
    if (!file) return;
    setIsProcessing(true);
    setResult(null);
    setErrorLine("");

    const formData = new FormData();
    formData.append("audio_file", file);
    formData.append("target_language", lang);

    try {
      const res = await fetch("/api/dubbing", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error);
      
      setResult(data);
    } catch (error: any) {
      setErrorLine(error.message);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div style={{ marginTop: '1.5rem', textAlign: 'left' }}>
      
      {/* 프리미엄 파일 업로더 UI */}
      {!result && (
        <div style={{ padding: '2rem', background: 'rgba(255,255,255,0.03)', borderRadius: '16px', border: file ? '1px solid var(--primary)' : '1px dashed rgba(255,255,255,0.2)', transition: 'all 0.3s' }}>
          
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }} onClick={() => fileInputRef.current?.click()}>
            <input type="file" accept="audio/*,video/*" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileChange} />
            {file ? <FileAudio size={48} color="var(--primary)" /> : <UploadCloud size={48} color="#94a3b8" />}
            <h3 style={{ marginTop: '1rem', color: file ? 'white' : '#94a3b8' }}>
              {file ? file.name : "이곳을 클릭하여 파일 업로드 (mp3, wav, mp4)"}
            </h3>
          </div>

          {file && (
            <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <label style={{ fontSize: '0.9rem', color: '#cbd5e1', marginBottom: '0.5rem' }}>어떤 언어로 더빙할까요?</label>
                <select 
                  value={lang} 
                  onChange={(e) => setLang(e.target.value)}
                  style={{ padding: '0.8rem', borderRadius: '8px', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', outline: 'none' }}
                >
                  <option value="en">미국 영어 (English)</option>
                  <option value="ja">일본어 (Japanese)</option>
                  <option value="ko">한국어 (Korean)</option>
                  <option value="es">스페인어 (Spanish)</option>
                  <option value="fr">프랑스어 (French)</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button className="btn-primary btn-accent" onClick={handleDubbing} disabled={isProcessing} style={{ height: '3.1rem' }}>
                  {isProcessing ? <><Loader2 className="animate-spin" size={20} /> AI 작업 진행중...</> : <><PlayCircle size={20} /> 더빙 시작</>}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 에러 피드백 */}
      {errorLine && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', color: '#fca5a5', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          ⚠️ 에러가 발생했습니다: {errorLine}
        </div>
      )}

      {/* 더빙 결과창 다운로드 UI */}
      {result && (
        <div style={{ animation: 'slideUpFade 0.6s ease-out' }}>
          
          <div style={{ padding: '2rem', background: 'rgba(52, 211, 153, 0.05)', borderRadius: '16px', border: '1px solid rgba(52, 211, 153, 0.2)' }}>
            <h2 style={{ fontSize: '1.5rem', color: '#10b981', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
              🎉 완벽하게 더빙되었습니다!
            </h2>
            
            <audio controls src={result.audioUrl} style={{ width: '100%', marginBottom: '1.5rem', outline: 'none' }} />
            
            <a href={result.audioUrl} download={`dubbed_result.mp3`} style={{ textDecoration: 'none' }} className="btn-primary">
              더빙본 안전하게 다운로드 (MP3)
            </a>
            
            <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', alignItems: 'stretch' }}>
              <div style={{ flex: 1, padding: '1rem', background: 'rgba(0,0,0,0.3)', borderRadius: '8px' }}>
                <strong style={{ display: 'block', color: '#94a3b8', fontSize: '0.85rem' }}>원본 음성 추출 (STT)</strong>
                <p style={{ marginTop: '0.5rem', fontSize: '0.95rem' }}>{result.transcript}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', color: '#94a3b8' }}>
                <ArrowRight size={24} />
              </div>
              <div style={{ flex: 1, padding: '1rem', background: 'linear-gradient(rgba(168, 85, 247, 0.1), rgba(168, 85, 247, 0.05))', borderRadius: '8px', border: '1px solid rgba(168, 85, 247, 0.2)' }}>
                <strong style={{ display: 'block', color: '#c084fc', fontSize: '0.85rem' }}>AI 번역 결과</strong>
                <p style={{ marginTop: '0.5rem', fontSize: '0.95rem' }}>{result.translatedText}</p>
              </div>
            </div>

            <div style={{ marginTop: '2rem', textAlign: 'center' }}>
                <button onClick={() => { setResult(null); setFile(null); }} style={{ background: 'transparent', border: 'none', color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' }}>
                  다른 파일 더빙하기
                </button>
            </div>
          </div>
        </div>
      )}

      {/* 회전 애니메이션용 간이 글로벌 스타일 클래스 */}
      <style dangerouslySetInnerHTML={{__html: `
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}} />
    </div>
  );
}
