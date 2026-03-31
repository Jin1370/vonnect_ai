"use client";
import React, { useState, useRef, useEffect, useCallback } from "react";
import {
    CloudArrowUpIcon,
    MusicalNoteIcon,
    PlayIcon,
    ArrowPathIcon,
    ArrowRightIcon,
    UsersIcon,
    ScissorsIcon,
    UserIcon,
    ArrowDownTrayIcon,
    PencilSquareIcon,
    CheckCircleIcon,
    ExclamationCircleIcon,
    ClockIcon,
} from "@heroicons/react/24/solid";
import { FFmpeg } from "@ffmpeg/ffmpeg";

// Simplified toBlobURL helper (bypass Next.js build error)
async function toBlobURL(url: string, mimeType: string): Promise<string> {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: mimeType });
    return URL.createObjectURL(blob);
}

// Unique color palette per speaker (6 colors, cycled)
const SPEAKER_COLORS = [
    "#6366f1", // Indigo
    "#0ea5e9", // Sky Blue
    "#8b5cf6", // Violet
    "#10b981", // Emerald
    "#f59e0b", // Amber
    "#64748b", // Slate
];

const PROCESSING_STEPS = [
    {
        key: "TRANSCRIBING",
        label: "🎙️ Recognizing speech & separating speakers...",
    },
    { key: "TRANSLATING", label: "🌐 Translating by speaker..." },
    { key: "SYNTHESIZING", label: "🔊 Synthesizing voices..." },
    { key: "FINALIZING", label: "✨ Finalizing high-quality video..." },
];

// [speaker_N] → { speakerIdx, content } conversion helper
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
    start: number;
    end: number;
}

interface Result {
    jobId: string;
    mediaUrl: string;
    mediaType: "video" | "audio";
    fileExt: string;
    transcript: string;
    translatedText: string;
    speakerCount: number;
    editableTranslations: EditableTranslation[];
}

// FFmpeg WASM singleton
let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoading = false;
let ffmpegReady = false;

async function getFFmpeg(): Promise<FFmpeg> {
    if (ffmpegReady && ffmpegInstance) return ffmpegInstance;
    if (!ffmpegInstance) {
        ffmpegInstance = new FFmpeg();
    }

    if (!ffmpegLoading) {
        ffmpegLoading = true;
        try {
            if (typeof SharedArrayBuffer === "undefined") {
                throw new Error(
                    "SharedArrayBuffer is not supported by this browser, or COOP/COEP headers are not applied. Please restart the server.",
                );
            }
            const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
            await ffmpegInstance.load({
                coreURL: await toBlobURL(
                    `${baseURL}/ffmpeg-core.js`,
                    "text/javascript",
                ),
                wasmURL: await toBlobURL(
                    `${baseURL}/ffmpeg-core.wasm`,
                    "application/wasm",
                ),
            });
            ffmpegReady = true;
        } catch (e: any) {
            ffmpegLoading = false;
            throw new Error(`FFmpeg Load Failed: ${e?.message || String(e)}`);
        }
    } else {
        // Wait if already loading
        while (!ffmpegReady) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    return ffmpegInstance;
}

// Preprocess (Crop video and/or Extract audio)
async function preprocessFile(
    file: File,
    start: number,
    duration: number,
    onProgress?: (msg: string) => void,
): Promise<{ videoFile: File; audioFile: File }> {
    try {
        onProgress?.("Loading FFmpeg...");
        const ff = await getFFmpeg();
        const ext = file.name.split(".").pop() ?? "mp4";
        const isVideo = file.type.startsWith("video") || ["mp4", "mov", "webm", "avi"].includes(ext);

        const inputName = `input.${ext}`;
        const outputVideoName = `processed_video.${ext}`;
        const outputAudioName = `processed_audio.mp3`;

        onProgress?.("Analyzing Media...");
        await ff.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

        // 1. Process Video (Crop and keep all streams)
        // We use '-c copy' to preserve 100% quality and speed.
        const videoArgs = ["-ss", start.toString(), "-i", inputName, "-t", duration.toString()];
        if (isVideo) {
            videoArgs.push("-c", "copy", "-map", "0", "-y", outputVideoName);
        } else {
            // If it's just audio, we don't need a video file
            await ff.writeFile(outputVideoName, new Uint8Array(await file.arrayBuffer()));
        }

        onProgress?.("Preparing Video...");
        if (isVideo) await ff.exec(videoArgs);

        // 2. Process Audio (Extract as MP3 for server upload)
        const audioArgs = ["-ss", start.toString(), "-i", inputName, "-t", duration.toString()];
        audioArgs.push("-vn", "-acodec", "libmp3lame", "-b:a", "128k", "-y", outputAudioName);

        onProgress?.("Extracting Audio...");
        await ff.exec(audioArgs);

        const videoData = isVideo ? await ff.readFile(outputVideoName) : await ff.readFile(inputName);
        const audioData = await ff.readFile(outputAudioName);

        // Cleanup
        ff.deleteFile(inputName).catch(() => {});
        if (isVideo) ff.deleteFile(outputVideoName).catch(() => {});
        ff.deleteFile(outputAudioName).catch(() => {});

        return {
            videoFile: new File([videoData as any], isVideo ? `cropped_${file.name}` : file.name, { type: isVideo ? file.type : file.type }),
            audioFile: new File([audioData as any], "audio.mp3", { type: "audio/mpeg" }),
        };
    } catch (e: any) {
        console.error("Preprocess error:", e);
        throw new Error(e?.message || String(e));
    }
}

// Local Merge: Merge dubbed audio with original video in the browser
async function mergeDubbedAudio(
    videoFile: File,
    audioBlob: Blob,
    onProgress?: (msg: string) => void,
    segments?: any[]
): Promise<File> {
    try {
        // onProgress?.("Merging Dubbed audio..."); // Removed noisy log to keep Ready to dub! stable
        const ff = await getFFmpeg();
        const videoExt = videoFile.name.split(".").pop() || "mp4";
        const videoName = `input_video.${videoExt}`;
        const audioName = "dubbed_audio.mp3";
        const outputName = "final_dubbed.mp4";

        await ff.writeFile(videoName, new Uint8Array(await videoFile.arrayBuffer()));
        await ff.writeFile(audioName, new Uint8Array(await audioBlob.arrayBuffer()));

        const args = [
            "-i", videoName,
            "-i", audioName,
        ];

            if (segments && segments.length > 0) {
                // 1. Load a CJK-compatible font for rendering. Try multiple reliable sources.
                const fontSources = [
                    "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf",
                    "https://cdn.jsdelivr.net/gh/googlefonts/noto-fonts/hinted/ttf/NotoSansKR/NotoSansKR-Regular.ttf",
                    "https://cdn.jsdelivr.net/gh/naver/nanumfont@master/nanumgothic/NanumGothic.ttf",
                    "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-kr/files/noto-sans-kr-korean-400-normal.woff" 
                ];
                
                let hasFont = false;
                let loadedFontName = "font.ttf";
    
                for (const url of fontSources) {
                    try {
                        const fontRes = await fetch(url);
                        if (fontRes.ok) {
                            const ext = url.split(".").pop() || "ttf";
                            loadedFontName = `font.${ext}`;
                            const fontData = await fontRes.arrayBuffer();
                            await ff.writeFile(loadedFontName, new Uint8Array(fontData));
                            hasFont = true;
                            // onProgress?.(`Font loaded from: ${url.split('/').slice(-3).join('/')}`); // Removed noisy log
                            break; 
                        }
                    } catch (e) {
                        console.warn(`Failed to load font from ${url}:`, e);
                    }
                }

            if (!hasFont) {
                console.warn("All font sources failed. Subtitles will be skipped to prevent video corruption.");
            }

            // Generate drawtext filters for each segment - ONLY if font is available
            let drawtextChain = "";
            if (hasFont) {
                drawtextChain = segments
                    .filter(s => s.translated && s.translated.trim() !== "")
                    .map(s => {
                        // Smart wrap: handles word boundaries and balances CJK vs Latin width
                        const wrapSubtitle = (text: string, maxUnits: number = 44) => {
                            const tokens = text.match(/[\u4e00-\u9fa5]|[\uac00-\ud7af]|[\u3040-\u309f]|[\u30a0-\u30ff]|\S+|\s+/g) || [];
                            const lines: string[] = [];
                            let currentLine = "";
                            let currentUnits = 0;

                            for (const token of tokens) {
                                let tokenUnits = 0;
                                for (const char of token) {
                                    tokenUnits += /[\u4e00-\u9fa5]|[\uac00-\ud7af]|[\u3040-\u309f]|[\u30a0-\u30ff]/.test(char) ? 2 : 1;
                                }

                                if (currentUnits + tokenUnits > maxUnits && currentLine.trim() !== "") {
                                    lines.push(currentLine.trim());
                                    currentLine = token.trim() === "" ? "" : token;
                                    currentUnits = tokenUnits;
                                } else {
                                    currentLine += token;
                                    currentUnits += tokenUnits;
                                }
                            }
                            if (currentLine.trim() !== "") lines.push(currentLine.trim());
                            return lines.join("\n");
                        };

                        const wrapped = wrapSubtitle(s.translated);

                        const cleanText = wrapped
                            .replace(/\\/g, "\\\\")
                            .replace(/'/g, "'\\''")
                            .replace(/:/g, "\\:")
                            .replace(/%/g, "\\%")
                            .replace(/\n/g, "\\\n"); // FFmpeg drawtext newline escaping
                        
                        return `drawtext=fontfile=${loadedFontName}:text='${cleanText}':enable='between(t,${s.start},${s.end})':x=(w-text_w)/2:y=h-80:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10:fix_bounds=1`;
                    })
                    .join(",");
            }

            if (drawtextChain) {
                // Combine with scaling to ensure even dimensions (needed for yuv420p)
                args.push("-vf", `scale=trunc(iw/2)*2:trunc(ih/2)*2,${drawtextChain}`);
            } else {
                args.push("-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
            }
            // Re-encoding is required for filters - use yuv420p for mobile compatibility
            args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p");
        } else {
            // Always re-encode to H.264/yuv420p for maximum compatibility (iOS/Chrome/Mobile)
            args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p");
        }

        args.push(
            "-c:a", "aac",
            "-b:a", "192k",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-map_metadata", "-1", // Strip potentially corrupt metadata
            "-shortest",
            "-y",
            outputName
        );

        await ff.exec(args);

        const data = await ff.readFile(outputName);
        ff.deleteFile(videoName).catch(() => {});
        ff.deleteFile(audioName).catch(() => {});
        ff.deleteFile(outputName).catch(() => {});

        return new File([data as any], "dubbed_final.mp4", { type: "video/mp4" });
    } catch (e: any) {
        console.error("Merge error:", e);
        throw new Error(`Merge failed: ${e.message}`);
    }
}

// Detect media duration using HTMLMediaElement
function getMediaDuration(file: File): Promise<number> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const el = document.createElement(
            file.type.startsWith("video") ? "video" : "audio",
        ) as HTMLMediaElement;
        el.src = url;
        el.onloadedmetadata = () => {
            URL.revokeObjectURL(url);
            resolve(el.duration);
        };
        el.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(0);
        };
    });
}

export default function DubbingWorkspace() {
    const [file, setFile] = useState<File | null>(null);
    const [processedVideo, setProcessedVideo] = useState<File | null>(null);
    const [processedAudio, setProcessedAudio] = useState<File | null>(null);
    const [cropStatus, setCropStatus] = useState<string>("");
    const [lang, setLang] = useState("en");
    const [isProcessing, setIsProcessing] = useState(false);
    const [isRedubbing, setIsRedubbing] = useState(false);
    const [stepIdx, setStepIdx] = useState(0);
    const [result, setResult] = useState<Result | null>(null);
    const [editedTranslations, setEditedTranslations] = useState<string[]>([]);
    const [videoDuration, setVideoDuration] = useState(0);
    const [cropStart, setCropStart] = useState(0);
    const [cropEnd, setCropEnd] = useState(60);
    const [errorLine, setErrorLine] = useState("");
    const [currentTime, setCurrentTime] = useState(0);
    const [burnSubtitles, setBurnSubtitles] = useState(false);
    const [originalUrl, setOriginalUrl] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const videoPreviewRef = useRef<HTMLVideoElement>(null);

    // Revoke original URL on cleanup or change
    useEffect(() => {
        if (processedVideo) {
            const url = URL.createObjectURL(processedVideo);
            setOriginalUrl(url);
            return () => URL.revokeObjectURL(url);
        }
    }, [processedVideo]);

    // Handle preview URL for the cropping UI
    useEffect(() => {
        if (file && file.type.startsWith("video")) {
            const url = URL.createObjectURL(file);
            setPreviewUrl(url);
            return () => URL.revokeObjectURL(url);
        } else {
            setPreviewUrl(null);
        }
    }, [file]);

    // Reset preview to cropStart when done dragging handles
    useEffect(() => {
        if (!isDragging && videoPreviewRef.current && !videoPreviewRef.current.paused) return; // Don't snap if playing
        if (!isDragging && videoPreviewRef.current) {
            videoPreviewRef.current.currentTime = cropStart;
        }
    }, [isDragging, cropStart]);

    // Voice Clone cleanup on tab close
    useEffect(() => {
        if (!result?.jobId) return;
        const jobId = result.jobId;
        const handleUnload = () => {
            navigator.sendBeacon(
                "/api/dubbing/cleanup",
                new Blob([JSON.stringify({ jobId })], {
                    type: "application/json",
                }),
            );
        };
        window.addEventListener("beforeunload", handleUnload);
        window.addEventListener("pagehide", handleUnload);

        return () => {
            window.removeEventListener("beforeunload", handleUnload);
            window.removeEventListener("pagehide", handleUnload);
        };
    }, [result?.jobId]);


    const handleFileChange = useCallback(
        async (e: React.ChangeEvent<HTMLInputElement>) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFile(f);
            setResult(null);
            setErrorLine("");
            setCropStatus("");
            setProcessedVideo(null);
            setProcessedAudio(null);

            const duration = await getMediaDuration(f);
            setVideoDuration(duration);
            setCurrentTime(0); // Reset playhead
            
            // Set initial crop range: 0 to min(duration, 60)
            setCropStart(0);
            setCropEnd(Math.min(duration, 60));

            // If it's a short audio file, we can skip cropping UI logic 
            // but for any video, we show the selection UI.
            const isVideo = f.type.startsWith("video");
            if (!isVideo && duration <= 60) {
                // Auto-prepare short audio
                setCropStatus("preparing");
                try {
                    const { videoFile, audioFile } = await preprocessFile(f, 0, duration, (msg) => setCropStatus(msg));
                    setProcessedVideo(videoFile);
                    setProcessedAudio(audioFile);
                    setCropStatus("done");
                } catch (err: any) {
                    setCropStatus("error");
                    setErrorLine(`Preprocessing failed: ${err.message}`);
                }
            }
        },
        [],
    );

    const handleDubbing = async () => {
        const uploadFile = processedAudio; // ONLY upload audio
        if (!uploadFile) return;
        setIsProcessing(true);
        setResult(null);
        setCurrentTime(0); // Reset playhead for result view
        setErrorLine("");
        setStepIdx(0);

        const stepTimer = setInterval(() => {
            setStepIdx((i) => (i < PROCESSING_STEPS.length - 1 ? i + 1 : i));
        }, 8000);

        const formData = new FormData();
        formData.append("audio_file", uploadFile);
        formData.append("target_language", lang);

        try {
            const res = await fetch("/api/dubbing", {
                method: "POST",
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            // POST-PROCESS: Merge dubbed audio with local video in browser
            if (processedVideo && processedVideo.type.startsWith("video")) {
                setStepIdx(PROCESSING_STEPS.length - 1); // Mark "FINALIZING"
                const dubbedAudioRes = await fetch(data.mediaUrl);
                const dubbedAudioBlob = await dubbedAudioRes.blob();
                
                const finalVideo = await mergeDubbedAudio(
                    processedVideo, 
                    dubbedAudioBlob, 
                    (msg) => setCropStatus(msg),
                    burnSubtitles ? data.editableTranslations : undefined
                ); 
                
                data.mediaUrl = URL.createObjectURL(finalVideo);
                data.mediaType = "video";
                data.fileExt = "mp4";
            }

            setResult(data);
            setEditedTranslations(
                data.editableTranslations.map(
                    (t: EditableTranslation) => t.translated,
                ),
            );
            setErrorLine(""); // Clear status messages
        } catch (e: any) {
            let userMsg = e.message;
            if (
                userMsg.includes("detected_captcha_voice") ||
                userMsg.includes("voice_access_denied")
            ) {
                userMsg =
                    "This voice cannot be dubbed due to ElevenLabs' safety policy. Please try again or use a different video.\n(ElevenLabs 보이스 정책으로 인해 해당 음성을 처리할 수 없습니다. 다시 시도하거나 다른 영상을 사용해 주세요.)";
            }
            setErrorLine(userMsg);
        } finally {
            clearInterval(stepTimer);
            setIsProcessing(false);
            setStepIdx(0);
        }
    };

    const handleRedub = async () => {
        const uploadFile = processedAudio;
        if (!uploadFile || !result) return;
        setIsRedubbing(true);
        setErrorLine("");

        const formData = new FormData();
        formData.append("audio_file", uploadFile);
        formData.append("job_id", result.jobId);
        formData.append(
            "edited_translations",
            JSON.stringify(editedTranslations),
        );

        try {
            const res = await fetch("/api/dubbing/remix", {
                method: "POST",
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            // POST-PROCESS for Remix
            if (processedVideo && processedVideo.type.startsWith("video")) {
                const dubbedAudioRes = await fetch(data.mediaUrl);
                const dubbedAudioBlob = await dubbedAudioRes.blob();
                const finalVideo = await mergeDubbedAudio(
                    processedVideo, 
                    dubbedAudioBlob, 
                    (msg) => setCropStatus(msg),
                    burnSubtitles ? result.editableTranslations : undefined
                );
                
                data.mediaUrl = URL.createObjectURL(finalVideo);
                data.mediaType = "video";
                data.fileExt = "mp4";
            }

            setResult((prev: Result | null) =>
                prev
                    ? {
                          ...prev,
                          mediaUrl: data.mediaUrl,
                          mediaType: data.mediaType,
                          fileExt: data.fileExt,
                      }
                    : prev,
            );
        } catch (e: any) {
            let userMsg = e.message;
            if (
                userMsg.includes("detected_captcha_voice") ||
                userMsg.includes("voice_access_denied")
            ) {
                userMsg =
                    "This voice cannot be dubbed due to ElevenLabs' safety policy. Please try again or use a different video.\n(ElevenLabs 보이스 정책으로 인해 해당 음성을 처리할 수 없습니다. 다시 시도하거나 다른 영상을 사용해 주세요.)";
            }
            setErrorLine(userMsg);
        } finally {
            setIsRedubbing(false);
        }
    };

    const hasEdits = result
        ? editedTranslations.some(
              (t, i) => t !== result.editableTranslations[i]?.translated,
          )
        : false;

    return (
        <div style={{ marginTop: "1.5rem", textAlign: "left" }}>
            {/* Upload Panel */}
            {!result && (
                <div
                    style={{
                        padding: "var(--inner-padding)",
                        background: "rgba(255,255,255,0.8)",
                        borderRadius: "24px",
                        border: file
                            ? "2px solid var(--primary)"
                            : "2px dashed rgba(0,0,0,0.08)",
                        transition: "all 0.3s",
                        boxShadow: "0 10px 25px -5px rgba(0,0,0,0.04)",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            cursor: "pointer",
                        }}
                        onClick={() =>
                            !isProcessing &&
                            cropStatus === "" &&
                            fileInputRef.current?.click()
                        }
                    >
                        <input
                            type="file"
                            accept="audio/*,video/*"
                            ref={fileInputRef}
                            style={{ display: "none" }}
                            onChange={handleFileChange}
                        />
                        {file ? (
                            <MusicalNoteIcon
                                style={{
                                    width: 48,
                                    height: 48,
                                    color: "var(--primary)",
                                }}
                            />
                        ) : (
                            <CloudArrowUpIcon
                                style={{
                                    width: 48,
                                    height: 48,
                                    color: "#94a3b8",
                                }}
                            />
                        )}
                        <h3
                            style={{
                                marginTop: "1rem",
                                color: file ? "#1e293b" : "#64748b",
                                fontWeight: 600,
                            }}
                        >
                            {file
                                ? file.name
                                : "Click here to upload file (mp3, wav, mp4)"}
                        </h3>
                        {file && (
                            <p
                                style={{
                                    color: "#94a3b8",
                                    fontSize: "0.85rem",
                                }}
                            >
                                {(file.size / 1024 / 1024).toFixed(1)} MB
                            </p>
                        )}
                    </div>

            {/* Range Selection UI */}
            {file && !result && !processedAudio && !isProcessing && (
                <div style={{
                    marginTop: "1.5rem",
                    padding: "1.5rem",
                    background: "rgba(255,255,255,0.8)",
                    borderRadius: "24px",
                    border: "1px solid rgba(0,0,0,0.05)",
                    boxShadow: "0 10px 25px -5px rgba(0,0,0,0.04)",
                }}>
                    <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem", fontWeight: 600 }}>Select Dubbing Range</h4>
                    
                    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                        {previewUrl && (
                            <div style={{ width: "100%", maxWidth: "100%", aspectRatio: "16/9", background: "#000", borderRadius: "16px", overflow: "hidden", position: "relative" }}>
                                <video 
                                    controls
                                    src={previewUrl} 
                                    ref={videoPreviewRef}
                                    onLoadedMetadata={(e) => {
                                        const v = e.target as HTMLVideoElement;
                                        v.currentTime = cropStart;
                                    }}
                                    onTimeUpdate={(e) => {
                                        const v = e.target as HTMLVideoElement;
                                        if (v.paused) return; // Don't enforce constraints while seeking/dragging
                                        if (v.currentTime < cropStart) {
                                            v.currentTime = cropStart;
                                        }
                                        if (v.currentTime >= cropEnd) {
                                            v.pause();
                                            v.currentTime = cropStart;
                                        }
                                    }}
                                    style={{ width: "100%", height: "100%", objectFit: "contain", maxWidth: "100%" }}
                                />
                                <div style={{ position: "absolute", bottom: "10px", right: "10px", padding: "4px 8px", background: "rgba(0,0,0,0.6)", color: "white", borderRadius: "6px", fontSize: "0.75rem", fontFamily: "monospace" }}>
                                    Preview at {new Date(cropStart * 1000).toISOString().substr(14, 5)}
                                </div>
                            </div>
                        )}

                        {/* Dual Range Slider */}
                        <div style={{ position: "relative", width: "100%", height: "60px", marginBottom: "0.5rem", display: "flex", alignItems: "center" }}>
                            {/* Track Background */}
                            <div style={{ position: "absolute", width: "100%", height: "10px", background: "#e2e8f0", borderRadius: "5px" }} />
                            
                            {/* Highlighted Range */}
                            <div style={{ 
                                position: "absolute", 
                                left: `${(cropStart / videoDuration) * 100}%`, 
                                width: `${((cropEnd - cropStart) / videoDuration) * 100}%`, 
                                height: "10px", 
                                background: "var(--primary)", 
                                borderRadius: "5px",
                                opacity: 0.8
                            }} />

                            {/* Floating Timestamps */}
                            <div style={{ 
                                position: "absolute", 
                                left: `${(cropStart / videoDuration) * 100}%`, 
                                top: "0",
                                transform: "translateX(-50%)",
                                fontSize: "0.75rem",
                                fontWeight: 700,
                                color: "var(--primary)",
                                whiteSpace: "nowrap"
                            }}>
                                {new Date(cropStart * 1000).toISOString().substr(14, 5)}
                            </div>
                            <div style={{ 
                                position: "absolute", 
                                left: `${(cropEnd / videoDuration) * 100}%`, 
                                bottom: "-18px",
                                transform: "translateX(-50%)",
                                fontSize: "0.75rem",
                                fontWeight: 700,
                                color: "var(--primary)",
                                whiteSpace: "nowrap"
                            }}>
                                {new Date(cropEnd * 1000).toISOString().substr(14, 5)}
                            </div>

                            {/* Start Handle */}
                            <input 
                                type="range" 
                                min={0} 
                                max={videoDuration} 
                                step={0.1}
                                value={cropStart} 
                                onChange={(e) => {
                                    const val = Number(e.target.value);
                                    if (val >= cropEnd) {
                                        setCropStart(cropEnd - 0.1);
                                        return;
                                    }
                                    setCropStart(val);
                                    if (cropEnd - val > 60) setCropEnd(val + 60);
                                    if (videoPreviewRef.current) {
                                        videoPreviewRef.current.currentTime = val;
                                    }
                                }}
                                onMouseDown={() => setIsDragging(true)}
                                onMouseUp={() => setIsDragging(false)}
                                onTouchStart={() => setIsDragging(true)}
                                onTouchEnd={() => setIsDragging(false)}
                                style={{ 
                                    position: "absolute", 
                                    width: "100%", 
                                    appearance: "none", 
                                    background: "transparent", 
                                    pointerEvents: "none",
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    zIndex: cropStart > videoDuration / 2 ? 5 : 4
                                }}
                                className="range-handle"
                            />

                            {/* End Handle */}
                            <input 
                                type="range" 
                                min={0} 
                                max={videoDuration} 
                                step={0.1}
                                value={cropEnd} 
                                onChange={(e) => {
                                    const val = Number(e.target.value);
                                    if (val <= cropStart) {
                                        setCropEnd(cropStart + 0.1);
                                        return;
                                    }
                                    setCropEnd(val);
                                    if (val - cropStart > 60) setCropStart(val - 60);
                                    if (videoPreviewRef.current) {
                                        videoPreviewRef.current.currentTime = val;
                                    }
                                }}
                                onMouseDown={() => setIsDragging(true)}
                                onMouseUp={() => setIsDragging(false)}
                                onTouchStart={() => setIsDragging(true)}
                                onTouchEnd={() => setIsDragging(false)}
                                style={{ 
                                    position: "absolute", 
                                    width: "100%", 
                                    appearance: "none", 
                                    background: "transparent", 
                                    pointerEvents: "none",
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    zIndex: cropEnd < videoDuration / 2 ? 5 : 4
                                }}
                                className="range-handle"
                            />
                        </div>

                        <div style={{ 
                            padding: "0.75rem",
                            background: "rgba(99, 102, 241, 0.05)",
                            borderRadius: "12px",
                            border: "1px solid rgba(99, 102, 241, 0.15)",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center"
                        }}>
                            <span style={{ fontSize: "0.88rem", color: "#6366f1", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                <ExclamationCircleIcon style={{ width: 16, height: 16 }} />
                                Please select a range within 1 minute
                            </span>
                            <button
                                disabled={cropStatus === "preparing" || (cropEnd - cropStart) > 60 || (cropEnd - cropStart) <= 0}
                                onClick={async () => {
                                    setCropStatus("preparing");
                                    try {
                                        const { videoFile, audioFile } = await preprocessFile(
                                            file!, 
                                            cropStart, 
                                            cropEnd - cropStart, 
                                            (msg) => setCropStatus(msg)
                                        );
                                        setProcessedVideo(videoFile);
                                        setProcessedAudio(audioFile);
                                        setCropStatus("done");
                                    } catch (err: any) {
                                        setCropStatus("error");
                                        setErrorLine(`Preprocessing failed: ${err.message}`);
                                    }
                                }}
                                style={{
                                    padding: "0.5rem 1rem",
                                    background: "var(--primary)",
                                    color: "white",
                                    border: "none",
                                    borderRadius: "8px",
                                    cursor: "pointer",
                                    fontSize: "0.9rem",
                                    fontWeight: 500,
                                    opacity: (cropStatus === "preparing" || (cropEnd - cropStart) > 60) ? 0.5 : 1
                                }}
                            >
                                {cropStatus === "preparing" ? "Preparing..." : "Apply"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Preparation Status */}
            {cropStatus && cropStatus !== "" && (
                <div style={{
                    marginTop: "1rem",
                    padding: "0.75rem 1rem",
                    background: cropStatus === "error" ? "rgba(239,68,68,0.05)" : (cropStatus === "done" ? "rgba(34,197,94,0.05)" : "rgba(37,99,235,0.05)"),
                    borderRadius: "12px",
                    border: cropStatus === "error" ? "1px solid rgba(239,68,68,0.15)" : (cropStatus === "done" ? "1px solid rgba(34,197,94,0.15)" : "1px solid rgba(37,99,235,0.15)"),
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                }}>
                    {cropStatus === "done" ? (
                        <CheckCircleIcon style={{ width: 16, height: 16, color: "#22c55e" }} />
                    ) : (
                        cropStatus === "error" ? (
                            <ExclamationCircleIcon style={{ width: 16, height: 16, color: "#ef4444" }} />
                        ) : (
                            <ArrowPathIcon className="animate-spin" style={{ width: 14, height: 14, color: "var(--primary)" }} />
                        )
                    )}
                    <span style={{
                        color: cropStatus === "error" ? "#dc2626" : (cropStatus === "done" ? "#16a34a" : "var(--primary)"),
                        fontSize: "0.88rem",
                        fontWeight: 500,
                    }}>
                        {cropStatus === "done" ? "Ready to dub!" : (cropStatus === "error" ? "Error in preparation" : cropStatus)}
                    </span>
                </div>
            )}

                    {file &&
                        processedAudio &&
                        !isProcessing && (
                            <div
                                style={{
                                    marginTop: "var(--section-gap)",
                                    display: "flex",
                                    gap: "1.2rem",
                                    flexWrap: "wrap",
                                    alignItems: "flex-end",
                                }}
                            >
                                <div
                                    style={{
                                        flex: 1,
                                        display: "flex",
                                        flexDirection: "column",
                                    }}
                                >
                                    <label
                                        style={{
                                            fontSize: "0.9rem",
                                            color: "#475569",
                                            marginBottom: "0.5rem",
                                            fontWeight: 500,
                                        }}
                                    >
                                        Select target language
                                    </label>
                                    <select
                                        value={lang}
                                        onChange={(e) =>
                                            setLang(e.target.value)
                                        }
                                        style={{
                                            padding: "0.8rem",
                                            borderRadius: "12px",
                                            background: "white",
                                            border: "1px solid rgba(0,0,0,0.08)",
                                            color: "#1e293b",
                                            outline: "none",
                                            boxShadow:
                                                "0 2px 4px rgba(0,0,0,0.02)",
                                        }}
                                    >
                                        <option value="en">English</option>
                                        <option value="ja">Japanese</option>
                                        <option value="ko">Korean</option>
                                        <option value="es">Spanish</option>
                                        <option value="fr">French</option>
                                        <option value="de">German</option>
                                        <option value="zh">Chinese</option>
                                    </select>
                                </div>
                                {file?.type.startsWith("video/") && (
                                    <div style={{ 
                                        display: "flex", 
                                        flexDirection: "column",
                                        justifyContent: "center",
                                        height: "3.1rem", // Matches the button and roughly the select box height
                                    }}>
                                        <label style={{ 
                                            fontSize: "0.95rem", 
                                            color: "#475569", 
                                            fontWeight: 500, 
                                            display: "flex", 
                                            alignItems: "center", 
                                            gap: "0.6rem", 
                                            cursor: "pointer" 
                                        }}>
                                            <input 
                                                type="checkbox" 
                                                checked={burnSubtitles} 
                                                onChange={(e) => setBurnSubtitles(e.target.checked)} 
                                                style={{ 
                                                    width: "18px",
                                                    height: "18px",
                                                    accentColor: "var(--primary)",
                                                    cursor: "pointer"
                                                }} 
                                            />
                                            Add subtitles
                                        </label>
                                        <span style={{ 
                                            fontSize: "0.75rem", 
                                            color: "#94a3b8", 
                                            marginLeft: "1.75rem",
                                            marginTop: "0.1rem"
                                        }}>
                                            (Takes a bit longer to process)
                                        </span>
                                    </div>
                                )}
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "flex-end",
                                    }}
                                >
                                    <button
                                        className="btn-primary btn-accent"
                                        onClick={handleDubbing}
                                        style={{ height: "3.1rem" }}
                                    >
                                        <PlayIcon
                                            style={{ width: 20, height: 20 }}
                                        />{" "}
                                        Start Dubbing
                                    </button>
                                </div>
                            </div>
                        )}

                    {isProcessing && (
                        <div
                            style={{
                                marginTop: "var(--section-gap)",
                                padding: "var(--inner-padding)",
                                background: "rgba(99,102,241,0.03)",
                                borderRadius: "16px",
                                border: "1px solid rgba(99,102,241,0.1)",
                            }}
                        >
                            {PROCESSING_STEPS.map((step, i) => (
                                <div
                                    key={step.key}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "0.75rem",
                                        padding: "0.5rem 0",
                                        opacity: i > stepIdx ? 0.3 : 1,
                                        transition: "opacity 0.5s",
                                        color:
                                            i === stepIdx
                                                ? "#4f46e5"
                                                : "#64748b",
                                    }}
                                >
                                    {i === stepIdx ? (
                                        <ArrowPathIcon
                                            className="animate-spin"
                                            style={{
                                                width: 18,
                                                height: 18,
                                                color: "#6366f1",
                                            }}
                                        />
                                    ) : i < stepIdx ? (
                                        <CheckCircleIcon
                                            style={{
                                                width: 18,
                                                height: 18,
                                                color: "#10b981",
                                            }}
                                        />
                                    ) : (
                                        <span
                                            style={{
                                                color: "#94a3b8",
                                                display: "inline-flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                width: 18,
                                                height: 18,
                                            }}
                                        >
                                            ○
                                        </span>
                                    )}
                                    <span
                                        style={{
                                            fontSize: "0.95rem",
                                            fontWeight:
                                                i === stepIdx ? 600 : 400,
                                        }}
                                    >
                                        {step.label}
                                    </span>
                                </div>
                            ))}
                            <p
                                style={{
                                    color: "#94a3b8",
                                    fontSize: "0.82rem",
                                    marginTop: "1rem",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.4rem",
                                }}
                            >
                                <ClockIcon style={{ width: 14, height: 14 }} />
                                Takes 20s to 2min depending on video length and
                                speakers.
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Error Feedback */}
            {errorLine && (
                <div
                    style={{
                        marginTop: "1rem",
                        padding: "1rem",
                        background: "rgba(239,68,68,0.1)",
                        color: "#ef4444",
                        borderRadius: "12px",
                        border: "1px solid rgba(239,68,68,0.2)",
                    }}
                >
                    ⚠️ Error occurred: {errorLine}
                </div>
            )}

            {/* Result View */}
            {result && (
                <div style={{ animation: "slideUpFade 0.6s ease-out" }}>
                    <div
                        style={{
                            padding: "var(--inner-padding)",
                            background: "#ffffff",
                            borderRadius: "16px",
                        }}
                    >
                        <div
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: "1.5rem",
                            }}
                        >
                            <h2
                                style={{
                                    fontSize: "1.1rem",
                                    color: "#6366f1",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.5rem",
                                }}
                            >
                                <CheckCircleIcon
                                    style={{ width: 22, height: 22 }}
                                />{" "}
                                Dubbing Completed!
                            </h2>
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.5rem",
                                    padding: "0.4rem 0.9rem",
                                    background: "rgba(99,102,241,0.08)",
                                    borderRadius: "20px",
                                    border: "1px solid rgba(99,102,241,0.15)",
                                }}
                            >
                                <UsersIcon
                                    style={{
                                        width: 14,
                                        height: 14,
                                        color: "#6366f1",
                                    }}
                                />
                                <span
                                    style={{
                                        color: "#6366f1",
                                        fontSize: "0.85rem",
                                    }}
                                >
                                    {result.speakerCount} speakers detected
                                </span>
                            </div>
                        </div>

                        <div style={{ 
                            display: "grid", 
                            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", 
                            gap: "1rem", 
                            marginBottom: "1.5rem" 
                        }}>
                            {/* Original Player */}
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "#94a3b8", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                    ORIGINAL
                                </span>
                                {result.mediaType === "video" ? (
                                    <video
                                        controls
                                        src={originalUrl || ""}
                                        style={{ width: "100%", borderRadius: "12px", background: "#000" }}
                                    />
                                ) : (
                                    <audio 
                                        controls 
                                        src={originalUrl || ""} 
                                        style={{ width: "100%" }} 
                                    />
                                )}
                            </div>

                            {/* Dubbed Player */}
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--primary)", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                    AI DUBBED RESULT ✨
                                </span>
                                {result.mediaType === "video" ? (
                                    <video
                                        controls
                                        src={result.mediaUrl}
                                        onTimeUpdate={(e) =>
                                            setCurrentTime(
                                                (e.target as HTMLVideoElement)
                                                    .currentTime,
                                            )
                                        }
                                        style={{
                                            width: "100%",
                                            borderRadius: "16px",
                                            outline: "none",
                                            background: "#000",
                                            boxShadow: "0 10px 30px rgba(99, 102, 241, 0.15)",
                                        }}
                                    />
                                ) : (
                                    <audio
                                        controls
                                        src={result.mediaUrl}
                                        onTimeUpdate={(e) =>
                                            setCurrentTime(
                                                (e.target as HTMLAudioElement)
                                                    .currentTime,
                                            )
                                        }
                                        style={{
                                            width: "100%",
                                            outline: "none",
                                        }}
                                    />
                                )}
                            </div>
                        </div>

                        <a
                            href={result.mediaUrl}
                            download={`dubbed_result.${result.fileExt}`}
                            style={{
                                textDecoration: "none",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: "0.6rem",
                            }}
                            className="btn-primary btn-accent"
                        >
                            <ArrowDownTrayIcon
                                style={{ width: 20, height: 20 }}
                            />
                            Download Dubbed File ({result.fileExt.toUpperCase()}
                            )
                        </a>

                        {/* Combined Transcript + Translation Panel */}
                        <div
                            style={{
                                marginTop: "var(--section-gap)",
                                padding: "var(--inner-padding)",
                                background: "rgba(255,255,255,0.7)",
                                borderRadius: "16px",
                                border: "1px solid rgba(99, 102, 241, 0.15)",
                                boxShadow:
                                    "0 4px 12px rgba(99, 102, 241, 0.05)",
                            }}
                        >
                            <div
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    marginBottom: "1.5rem",
                                }}
                            >
                                <strong
                                    style={{
                                        color: "#4f46e5",
                                        fontSize: "0.95rem",
                                        fontWeight: 600,
                                    }}
                                >
                                    Review and edit translations here
                                </strong>
                                {hasEdits && (
                                    <span
                                        style={{
                                            fontSize: "0.75rem",
                                            padding: "0.25rem 0.6rem",
                                            background: "rgba(99,102,241,0.08)",
                                            color: "#6366f1",
                                            borderRadius: "12px",
                                            border: "1px solid rgba(99,102,241,0.08)",
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "0.35rem",
                                        }}
                                    >
                                        <PencilSquareIcon
                                            style={{ width: 14, height: 14 }}
                                        />
                                        Edited
                                    </span>
                                )}
                            </div>

                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "0.75rem",
                                    maxHeight: "600px",
                                    overflowY: "auto",
                                    paddingRight: "4px",
                                }}
                            >
                                {result.editableTranslations.map((item, i) => {
                                    if (!item.original.trim()) return null;

                                    const spkIdx = parseInt(
                                        item.speaker.replace("speaker_", ""),
                                        10,
                                    );
                                    const color =
                                        SPEAKER_COLORS[
                                            spkIdx % SPEAKER_COLORS.length
                                        ];
                                    const isActive =
                                        currentTime >= item.start &&
                                        currentTime <= item.end;
                                    const showSpeakerIcon = i === 0 || result.editableTranslations[i-1].speaker !== item.speaker;

                                    return (
                                        <div
                                            key={i}
                                            id={`segment-${i}`}
                                            style={{
                                                display: "flex",
                                                gap: "0.8rem",
                                                alignItems: "flex-start",
                                                padding: "0.75rem",
                                                background: isActive
                                                    ? `${color}10` // 10% opacity color
                                                    : "rgba(255,255,255,0.5)",
                                                borderRadius: "12px",
                                                border: isActive
                                                    ? `1px solid ${color}40`
                                                    : "1px solid rgba(0,0,0,0.03)",
                                                transition:
                                                    "background 0.3s, border 0.3s",
                                                scrollMarginTop: "20px",
                                                marginTop: (showSpeakerIcon && i > 0) ? "0.75rem" : "0"
                                            }}
                                        >
                                            <div style={{ width: 20, flexShrink: 0, marginTop: "4px" }}>
                                                {showSpeakerIcon && (
                                                    <UserIcon
                                                        style={{
                                                            width: 20,
                                                            height: 20,
                                                            color,
                                                        }}
                                                    />
                                                )}
                                            </div>
                                            <div
                                                style={{
                                                    flex: 1,
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    gap: "0.6rem",
                                                }}
                                            >
                                                {/* Original Text */}
                                                <div
                                                    style={{
                                                        color: item.isSoundEffect
                                                            ? "#94a3b8"
                                                            : "#64748b",
                                                        fontWeight: 500,
                                                        lineHeight: 1.5,
                                                        fontStyle:
                                                            item.isSoundEffect
                                                                ? "italic"
                                                                : "normal",
                                                    }}
                                                >
                                                    {item.original}
                                                </div>

                                                {/* Translated Text (Editable Only) */}
                                                {!item.isSoundEffect && (
                                                    <textarea
                                                        value={
                                                            editedTranslations[
                                                                i
                                                            ] ?? ""
                                                        }
                                                        onChange={(e) => {
                                                            const next = [
                                                                ...editedTranslations,
                                                            ];
                                                            next[i] =
                                                                e.target.value;
                                                            setEditedTranslations(
                                                                next,
                                                            );
                                                        }}
                                                        rows={Math.max(
                                                            1,
                                                            Math.ceil(
                                                                (editedTranslations[
                                                                    i
                                                                ]?.length ||
                                                                    0) / 70,
                                                            ),
                                                        )}
                                                        style={{
                                                            width: "100%",
                                                            background: "white",
                                                            border:
                                                                editedTranslations[
                                                                    i
                                                                ] !==
                                                                item.translated
                                                                    ? "1px solid #6366f1"
                                                                    : "1px solid rgba(0,0,0,0.08)",
                                                            borderRadius: "8px",
                                                            color: "#1e293b",
                                                            padding:
                                                                "0.6rem 0.8rem",
                                                            fontSize: "0.9rem",
                                                            outline: "none",
                                                            boxShadow:
                                                                "inset 0 1px 2px rgba(0,0,0,0.02)",
                                                            transition:
                                                                "all 0.2s",
                                                            resize: "vertical",
                                                            minHeight: "42px",
                                                            lineHeight: 1.5,
                                                        }}
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Action Buttons */}
                        <div
                            style={{
                                marginTop: "var(--section-gap)",
                                display: "flex",
                                gap: "0.8rem",
                                justifyContent: "flex-end",
                                alignItems: "center",
                                flexWrap: "wrap",
                            }}
                        >
                            <button
                                onClick={async () => {
                                    if (result?.jobId) {
                                        fetch("/api/dubbing/cleanup", {
                                            method: "POST",
                                            body: JSON.stringify({
                                                jobId: result.jobId,
                                            }),
                                            headers: {
                                                "Content-Type":
                                                    "application/json",
                                            },
                                        }).catch(() => {});
                                    }
                                    setResult(null);
                                    setFile(null);
                                    setProcessedVideo(null);
                                    setProcessedAudio(null);
                                    setCropStatus("");
                                }}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.5rem",
                                    padding: "0.65rem 1.2rem",
                                    background: "rgba(255,255,255,0.8)",
                                    border: "1px solid rgba(0,0,0,0.1)",
                                    borderRadius: "12px",
                                    color: "#475569",
                                    cursor: "pointer",
                                    fontSize: "0.9rem",
                                    fontWeight: 600,
                                    transition: "all 0.2s",
                                }}
                            >
                                <CloudArrowUpIcon
                                    style={{ width: 16, height: 16 }}
                                />
                                Dub another file
                            </button>

                            <button
                                onClick={handleRedub}
                                disabled={isRedubbing || !hasEdits}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.5rem",
                                    padding: "0.65rem 1.2rem",
                                    background: hasEdits
                                        ? "rgba(99,102,241,0.1)"
                                        : "rgba(0,0,0,0.02)",
                                    border: hasEdits
                                        ? "1px solid rgba(99,102,241,0.3)"
                                        : "1px solid rgba(0,0,0,0.05)",
                                    borderRadius: "12px",
                                    color: hasEdits ? "#4f46e5" : "#94a3b8",
                                    cursor:
                                        hasEdits && !isRedubbing
                                            ? "pointer"
                                            : "not-allowed",
                                    fontSize: "0.9rem",
                                    fontWeight: 600,
                                    transition: "all 0.2s",
                                }}
                            >
                                {isRedubbing ? (
                                    <ArrowPathIcon
                                        className="animate-spin"
                                        style={{ width: 16, height: 16 }}
                                    />
                                ) : (
                                    <ArrowPathIcon
                                        style={{ width: 16, height: 16 }}
                                    />
                                )}
                                Re-dub
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <style
                dangerouslySetInnerHTML={{
                    __html: `
                .animate-spin { animation: spin 1s linear infinite; }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                
                .range-handle::-webkit-slider-thumb {
                    pointer-events: auto;
                    appearance: none;
                    width: 6px;
                    height: 24px;
                    border-radius: 3px;
                    background: var(--primary);
                    border: none;
                    cursor: pointer;
                    box-shadow: 0 0 4px rgba(0,0,0,0.3);
                    transition: transform 0.1s;
                }
                .range-handle::-webkit-slider-thumb:hover {
                    transform: scale(1.2);
                }
                .range-handle::-moz-range-thumb {
                    pointer-events: auto;
                    width: 6px;
                    height: 24px;
                    border-radius: 3px;
                    background: var(--primary);
                    border: none;
                    cursor: pointer;
                    box-shadow: 0 0 4px rgba(0,0,0,0.3);
                }
            `,
                }}
            />
        </div>
    );
}
