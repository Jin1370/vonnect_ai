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
    needsCrop: boolean,
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

        // 1. Process Video (Crop if needed, else just copy)
        // We use '-c copy' to preserve 100% quality and speed if just cropping.
        const videoArgs = ["-i", inputName];
        if (needsCrop) {
            videoArgs.push("-t", "60");
        }
        if (isVideo) {
            videoArgs.push("-c", "copy", "-map", "0:v:0", "-y", outputVideoName);
        } else {
            // If it's just audio, we don't need a video file
            await ff.writeFile(outputVideoName, new Uint8Array(await file.arrayBuffer()));
        }

        onProgress?.(needsCrop ? "Cropping Video..." : "Preparing Video...");
        if (isVideo) await ff.exec(videoArgs);

        // 2. Process Audio (Extract as MP3 for server upload)
        const audioArgs = ["-i", inputName];
        if (needsCrop) audioArgs.push("-t", "60");
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
            videoFile: new File([videoData as any], isVideo ? `cropped_${file.name}` : file.name, { type: isVideo ? "video/mp4" : file.type }),
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
): Promise<File> {
    try {
        onProgress?.("Merging Dubbed audio...");
        const ff = await getFFmpeg();
        const videoName = "input_video.mp4";
        const audioName = "dubbed_audio.mp3";
        const outputName = "final_dubbed.mp4";

        await ff.writeFile(videoName, new Uint8Array(await videoFile.arrayBuffer()));
        await ff.writeFile(audioName, new Uint8Array(await audioBlob.arrayBuffer()));

        await ff.exec([
            "-i", videoName,
            "-i", audioName,
            "-c:v", "copy", // No re-encoding for video! Preservation 100%
            "-c:a", "aac",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-shortest",
            "-y",
            outputName
        ]);

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
    const [preprocessNeedsCrop, setPreprocessNeedsCrop] = useState(false);
    const [errorLine, setErrorLine] = useState("");
    const [currentTime, setCurrentTime] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

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

    // Auto-scroll to active transcript segment
    useEffect(() => {
        if (!result) return;
        const activeIdx = result.editableTranslations.findIndex(
            (item) => currentTime >= item.start && currentTime <= item.end,
        );
        if (activeIdx !== -1) {
            const el = document.getElementById(`segment-${activeIdx}`);
            if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
        }
    }, [currentTime, result]);

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
            const isTooLong = duration > 60;
            setPreprocessNeedsCrop(isTooLong);

            // Preprocess if > 60s OR if it's a video (to extract audio)
            const isVideo = f.type.startsWith("video");
            if (isTooLong || isVideo) {
                setCropStatus("preparing");
                try {
                    const { videoFile, audioFile } = await preprocessFile(
                        f,
                        isTooLong,
                        (msg: string) => setCropStatus(msg),
                    );
                    setProcessedVideo(videoFile);
                    setProcessedAudio(audioFile);
                    setCropStatus("done");
                } catch (err: any) {
                    setCropStatus("error");
                    setErrorLine(`Preprocessing failed: ${err.message}`);
                }
            } else {
                // For direct audio file under 60s
                setProcessedAudio(f);
                setProcessedVideo(f);
            }
        },
        [],
    );

    const handleDubbing = async () => {
        const uploadFile = processedAudio; // ONLY upload audio
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
                
                const finalVideo = await mergeDubbedAudio(processedVideo, dubbedAudioBlob); // No progress callback
                
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
                const finalVideo = await mergeDubbedAudio(processedVideo, dubbedAudioBlob, (msg) => 
                    setCropStatus(msg)
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

            {/* Crop Status - Only show for long videos */}
            {file && (file.size / 1024 / 1024) > 0 && (
                <>
                    {cropStatus &&
                        cropStatus !== "done" &&
                        cropStatus !== "error" &&
                        preprocessNeedsCrop && ( // Only show IF it actually needs cropping
                            <div
                                style={{
                                    marginTop: "1rem",
                                    padding: "0.75rem 1rem",
                                    background: "rgba(251,146,60,0.05)",
                                    borderRadius: "12px",
                                    border: "1px solid rgba(251,146,60,0.15)",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.6rem",
                                }}
                            >
                                <ScissorsIcon
                                    style={{
                                        width: 16,
                                        height: 16,
                                        color: "#fb923c",
                                    }}
                                />
                                <span
                                    style={{
                                        color: "#ea580c",
                                        fontSize: "0.88rem",
                                        fontWeight: 500,
                                    }}
                                >
                                    1min+ Detected — {cropStatus}
                                </span>
                                <ArrowPathIcon
                                    className="animate-spin"
                                    style={{
                                        width: 14,
                                        height: 14,
                                        color: "#fb923c",
                                    }}
                                />
                            </div>
                        )}
                    {cropStatus === "done" && preprocessNeedsCrop && (
                        <div
                            style={{
                                marginTop: "1rem",
                                padding: "0.75rem 1rem",
                                background: "rgba(52,211,153,0.05)",
                                borderRadius: "12px",
                                border: "1px solid rgba(52,211,153,0.15)",
                                display: "flex",
                                alignItems: "center",
                                gap: "0.6rem",
                            }}
                        >
                            <ScissorsIcon
                                style={{
                                    width: 16,
                                    height: 16,
                                    color: "#059669",
                                }}
                            />
                            <span
                                style={{
                                    color: "#059669",
                                    fontSize: "0.88rem",
                                    fontWeight: 500,
                                }}
                            >
                                Cropped to first 1 minute
                            </span>
                        </div>
                    )}
                </>
            )}

                    {file &&
                        (cropStatus === "done" || cropStatus === "") &&
                        !isProcessing && (
                            <div
                                style={{
                                    marginTop: "var(--section-gap)",
                                    display: "flex",
                                    gap: "1rem",
                                    flexWrap: "wrap",
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
                                    marginBottom: "1.5rem",
                                    outline: "none",
                                    background: "#000",
                                    boxShadow: "0 10px 30px rgba(0,0,0,0.1)",
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
                                    marginBottom: "1.5rem",
                                    outline: "none",
                                }}
                            />
                        )}

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
                                ref={scrollContainerRef}
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
                                            }}
                                        >
                                            <div style={{ marginTop: "4px" }}>
                                                <UserIcon
                                                    style={{
                                                        width: 20,
                                                        height: 20,
                                                        color,
                                                        flexShrink: 0,
                                                    }}
                                                />
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
            `,
                }}
            />
        </div>
    );
}
