import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { dubbingJobs, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

// ── 화자별 Voice ID 매핑 (무료 플랜에서 사용 가능한 premade 보이스) ──
const SPEAKER_VOICES = [
  "EXAVITQu4vr4xnSDxMaL", // Sarah     - 여성, 차분함
  "IKne3meq5aSn9XLyUdCD", // Charlie   - 남성, 활기참
  "JBFqnCBsd6RMkjVDRZzb", // George    - 남성, 따뜻함
  "FGY2WhTYpPnrIDTdsKH5", // Laura     - 여성, 활발함
  "CwhRBWXzGAHq8TQ4Fs17", // Roger     - 남성, 차분함
];

// ElevenLabs STT Diarization 응답 타입 정의
interface ELWord {
  text: string;
  start: number;
  end: number;
  speaker_id?: string;
}

interface Segment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

// ── 단어 토큰이 소리 효과인지 확인 (단어 단위, 짧은 괄호 텍스트) ──
const WORD_SOUND_PATTERN = /^[\(\[\{《【「].*[\)\]\}》】」]$/;
function isSoundWord(text: string): boolean {
  return WORD_SOUND_PATTERN.test(text.trim());
}

// ── 단어 목록에서 화자별 발화 세그먼트로 병합 ──
// 소리 효과 토큰은 항상 독립 세그먼트로 분리하여 원본 오디오 추출 가능하게 함
function buildSegments(words: ELWord[]): Segment[] {
  const segments: Segment[] = [];
  let cur: Segment | null = null;

  for (const w of words) {
    const spk = w.speaker_id ?? "speaker_0";
    const isSound = isSoundWord(w.text);

    // 소리 효과 토큰이거나 화자가 바뀌면 새 세그먼트 시작
    if (!cur || cur.speaker !== spk || isSound || isSoundWord(cur.text)) {
      if (cur) segments.push(cur);
      cur = { speaker: spk, text: w.text, start: w.start, end: w.end };
    } else {
      cur.text += " " + w.text;
      cur.end = w.end;
    }

    // 소리 효과 토큰은 즉시 닫아서 독립 세그먼트로 확정
    if (isSound) {
      segments.push(cur!);
      cur = null;
    }
  }
  if (cur) segments.push(cur);
  return segments;
}



// ── 텍스트 내 비언어 소리 표현 제거 ──
// (웃음소리), (laughter), [박수], {music} 등 괄호로 감싸진 패턴을 공백으로 치환
const INLINE_SOUND_PATTERN = /[\(\[\{《【「][^\)\]\}》】」]{1,40}[\)\]\}》】」]/g;
function cleanText(text: string): string {
  return text.replace(INLINE_SOUND_PATTERN, " ").replace(/\s{2,}/g, " ").trim();
}

// ── 원본 오디오에서 특정 구간(start~end 초)만 잘라내기 ──
async function extractAudioClip(
  sourcePath: string,
  start: number,
  duration: number,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setStartTime(start)
      .setDuration(duration)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`원본 구간 추출 실패: ${err.message}`)))
      .run();
  });
}

async function mixAudioClips(
  clips: { buffer: Buffer; start: number; duration: number }[],
  totalDuration: number,
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dubbing-"));

  try {
    // 1. 각 클립 파일을 임시 디렉토리에 저장
    const clipPaths: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const p = path.join(tmpDir, `clip_${i}.mp3`);
      await fs.writeFile(p, clips[i].buffer);
      clipPaths.push(p);
    }

    // 2. 무음(silence) 베이스 트랙을 순수 Node.js WAV Buffer로 생성 (lavfi 불필요)
    const sampleRate = 44100;
    const channels = 2;
    const silenceDuration = Math.ceil(totalDuration) + 2;
    const numSamples = sampleRate * silenceDuration * channels;
    const dataBytes = numSamples * 2; // 16-bit PCM
    const wavBuf = Buffer.alloc(44 + dataBytes, 0);
    wavBuf.write("RIFF", 0); wavBuf.writeUInt32LE(36 + dataBytes, 4);
    wavBuf.write("WAVE", 8); wavBuf.write("fmt ", 12);
    wavBuf.writeUInt32LE(16, 16); wavBuf.writeUInt16LE(1, 20);          // PCM
    wavBuf.writeUInt16LE(channels, 22);
    wavBuf.writeUInt32LE(sampleRate, 24);
    wavBuf.writeUInt32LE(sampleRate * channels * 2, 28);                // ByteRate
    wavBuf.writeUInt16LE(channels * 2, 32);                             // BlockAlign
    wavBuf.writeUInt16LE(16, 34);                                       // BitsPerSample
    wavBuf.write("data", 36); wavBuf.writeUInt32LE(dataBytes, 40);
    const silencePath = path.join(tmpDir, "silence.wav");
    await fs.writeFile(silencePath, wavBuf);


    // 3. 각 클립의 실제 재생 시간 측정 → atempo 속도 보정 비율 계산
    const outputPath = path.join(tmpDir, "output.mp3");
    const filterParts: string[] = [];
    const inputArgs: string[] = [];

    inputArgs.push("-i", silencePath);
    for (let i = 0; i < clips.length; i++) {
      inputArgs.push("-i", clipPaths[i]);
    }

    // 필터 그래프: 각 클립의 속도를 원본 구간 길이에 맞게 조절 후 delay 배치
    let mixInputs = "[0:a]";
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const targetDuration = clip.duration;
      // ffprobe로 실제 클립 길이 구하기 (동기 대신 임시 추정: Buffer 크기 기반)
      // 128kbps MP3 → 1초당 약 16KB
      const estimatedDuration = (clip.buffer.length / 16000);
      const tempo = Math.min(2.0, Math.max(0.5, estimatedDuration / targetDuration));
      const delayMs = Math.round(clip.start * 1000);
      const inputIdx = i + 1;

      filterParts.push(
        `[${inputIdx}:a]atempo=${tempo.toFixed(3)}[s${i}]`
      );
      filterParts.push(
        `[s${i}]adelay=${delayMs}|${delayMs}[d${i}]`
      );
      mixInputs += `[d${i}]`;
    }
    filterParts.push(
      `${mixInputs}amix=inputs=${clips.length + 1}:normalize=0[out]`
    );

    const filterComplex = filterParts.join(";");

    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg();
      for (const arg of inputArgs) {
        if (arg === "-i") continue;
      }
      // fluent-ffmpeg에서 직접 inputArgs 및 filter 지정
      let f = ffmpeg();
      f = f.input(silencePath);
      for (const cp of clipPaths) f = f.input(cp);
      f
        .complexFilter(filterComplex, "out")
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(new Error(`ffmpeg: ${err.message}`)))
        .run();
    });

    return await fs.readFile(outputPath);
  } finally {
    // 임시 파일 정리
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ── 비디오 MIME 또는 확장자 감지 ──
function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["mp4", "mov", "webm", "avi", "mkv", "m4v"].includes(ext);
}

// ── 비디오에서 오디오만 추출 (MP3) ──
async function extractAudioFromVideo(videoPath: string, outputAudioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .output(outputAudioPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`오디오 추출 실패: ${err.message}`)))
      .run();
  });
}

// ── 더빙 오디오를 원본 비디오에 덮어씌우기 (원본 오디오 제거) ──
async function mergeAudioIntoVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v:0",   // 원본 영상 트랙
        "-map", "1:a:0",   // 더빙 오디오 트랙
        "-c:v", "copy",    // 영상은 재인코딩 없이 빠르게 복사
        "-c:a", "aac",     // 오디오는 AAC로 인코딩 (mp4 호환)
        "-shortest",       // 짧은 쪽에 맞춰 종료
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`비디오 합성 실패: ${err.message}`)))
      .run();
  });
}

export async function POST(request: Request) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

  if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY) {
    return NextResponse.json(
      { error: "환경변수에 API 키가 누락되었습니다." },
      { status: 500 }
    );
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  // ── 인증 ──
  const session = await getServerSession(authOptions);
  let userId = (session?.user as any)?.id;
  if (!userId && session?.user?.email) {
    const found = await db.select().from(users).where(eq(users.email, session.user.email)).limit(1);
    if (found.length > 0) userId = found[0].id;
  }
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let jobId = "";

  try {
    const formData = await request.formData();
    const file = formData.get("audio_file") as File;
    const targetLanguage = (formData.get("target_language") as string) || "en";

    if (!file) return NextResponse.json({ error: "파일이 없습니다." }, { status: 400 });

    const isVideo = isVideoFile(file);
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 비디오인 경우 STT용 임시 오디오를 추출해 저장
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dub-main-"));
    const origVideoPath = path.join(workDir, "original" + (file.name.includes(".") ? "." + file.name.split(".").pop() : ".mp4"));
    const extractedAudioPath = path.join(workDir, "extracted.mp3");

    await fs.writeFile(origVideoPath, buffer);
    let sttBuffer = buffer;
    let sttMime = file.type || "audio/mpeg";
    let sttFileName = file.name;

    if (isVideo) {
      await extractAudioFromVideo(origVideoPath, extractedAudioPath);
      sttBuffer = await fs.readFile(extractedAudioPath);
      sttMime = "audio/mpeg";
      sttFileName = "extracted.mp3";
    }

    const [job] = await db.insert(dubbingJobs).values({
      userId,
      originalFileUrl: "local_memory_" + file.name,
      targetLanguage,
      status: "TRANSCRIBING",
    }).returning();
    jobId = job.id;

    // ────────────────────────────────────────────────────────────────
    // [STEP 1] ElevenLabs STT — diarize=true 로 화자 분리
    // ────────────────────────────────────────────────────────────────
    const sttForm = new FormData();
    sttForm.append("file", new Blob([sttBuffer], { type: sttMime }), sttFileName);
    sttForm.append("model_id", "scribe_v1");
    sttForm.append("diarize", "true");  // ← 다화자 분리 핵심

    const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: sttForm,
    });
    if (!sttRes.ok) throw new Error(`STT 실패: ${await sttRes.text()}`);
    const sttData = await sttRes.json();

    // 단어 단위 타임스탬프로 발화 세그먼트 구성
    const words: ELWord[] = sttData.words ?? [];
    if (words.length === 0) throw new Error("음성 텍스트를 추출하지 못했습니다.");

    const segments = buildSegments(words);
    const totalDuration = segments[segments.length - 1].end;

    // ────────────────────────────────────────────────────────────────
    // [STEP 2] OpenAI GPT-4o — 세그먼트 구조 보존하며 번역
    // ────────────────────────────────────────────────────────────────
    await db.update(dubbingJobs).set({ status: "TRANSLATING" }).where(eq(dubbingJobs.id, jobId));

    const speechSegments = segments.filter((s) => s.text.trim().length > 0);
    const segmentsJson = JSON.stringify(
      // 소리 효과 포함 모든 세그먼트를 GPT에 전달 → (웃음소리) → (laughter) 자동 번역
      speechSegments.map((s) => ({ speaker: s.speaker, text: s.text }))
    );

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a professional dubbing translator.
You will receive a JSON array of speech segments. Some segments may contain non-verbal sounds in parentheses like (웃음소리), (laughter), [applause] etc.
For regular speech: translate into ${targetLanguage} naturally and concisely.
For parenthetical sounds: translate the label too (e.g., (웃음소리) → (laughter), [박수] → [applause]).
Return a JSON object: {"segments": [{"speaker": "...", "translatedText": "..."}]}`,
        },
        { role: "user", content: segmentsJson },
      ],
    });

    const parsed = JSON.parse(completion.choices[0].message.content || "{}");
    const rawTranslated: { speaker: string; translatedText: string }[] =
      parsed.segments ?? [];

    // 원본 세그먼트(빈 것 포함) 순서에 맞춰 번역 결과 재배치
    // 빈 텍스트 세그먼트는 "" 처리 (요약에서 제외)
    let translationIdx = 0;
    const translatedSegments: string[] = segments.map((s) => {
      if (!s.text.trim()) return ""; // 빈 세그먼트 → 건너뜀
      return rawTranslated[translationIdx++]?.translatedText ?? s.text;
    });

    // ────────────────────────────────────────────────────────────────
    // [STEP 3] ElevenLabs TTS — 화자별 다른 목소리로 세그먼트 합성
    // ────────────────────────────────────────────────────────────────
    await db.update(dubbingJobs).set({ status: "SYNTHESIZING" }).where(eq(dubbingJobs.id, jobId));

    // 화자 → 고정 voice index 매핑
    const speakerVoiceMap: Record<string, string> = {};
    let voiceIdx = 0;
    for (const seg of segments) {
      if (!(seg.speaker in speakerVoiceMap)) {
        speakerVoiceMap[seg.speaker] = SPEAKER_VOICES[voiceIdx % SPEAKER_VOICES.length];
        voiceIdx++;
      }
    }

    const clips: { buffer: Buffer; start: number; duration: number }[] = [];
    const MIN_CLIP_DURATION = 0.15; // 0.15초 미만은 ffmpeg이 빈 파일 생성 가능 → 제외

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const translated = translatedSegments[i];
      const segDuration = seg.end - seg.start;

      const isSoundSeg = cleanText(seg.text).trim() === "";

      if (isSoundSeg) {
        // 소리 효과: 너무 짧은 구간은 원본 추출이 불안정하므로 건너뜀
        if (segDuration < MIN_CLIP_DURATION) continue;
        const clipPath = path.join(workDir, `sound_${i}.mp3`);
        const sourceForClip = isVideo ? extractedAudioPath : origVideoPath;
        try {
          await extractAudioClip(sourceForClip, seg.start, segDuration, clipPath);
          const clipBuf = await fs.readFile(clipPath);
          if (clipBuf.length > 1000) { // 1KB 미만은 유효하지 않은 MP3로 간주, 제외
            clips.push({ buffer: clipBuf, start: seg.start, duration: segDuration });
          }
        } catch (e) {
          console.warn(`소리 효과 구간 추출 실패 (무시): ${seg.text} @ ${seg.start}-${seg.end}`, e);
        }
        continue;
      }

      // TTS 구간: 원본 duration이 짧아도 무조건 합성 (필터 적용 안 함)
      if (!translated || !translated.trim()) continue;


      const voiceId = speakerVoiceMap[seg.speaker];
      const ttsRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ text: translated, model_id: "eleven_multilingual_v2" }),
        }
      );
      if (!ttsRes.ok) throw new Error(`TTS 실패 (${seg.speaker}): ${await ttsRes.text()}`);

      clips.push({
        buffer: Buffer.from(await ttsRes.arrayBuffer()),
        start: seg.start,
        duration: segDuration,
      });
    }

    // ────────────────────────────────────────────────────────────────
    // [STEP 4] ffmpeg 믹싱 — 타임스탬프 기반 오디오 합성
    // ────────────────────────────────────────────────────────────────
    const mixedAudioBuffer = await mixAudioClips(clips, totalDuration);

    // 비디오인 경우 원본 영상에 더빙 오디오를 합쳐서 mp4로 반환
    let resultBase64: string;
    let resultMime: string;
    let resultExt: string;

    if (isVideo) {
      const mixedAudioPath = path.join(workDir, "dubbed.mp3");
      const outputVideoPath = path.join(workDir, "output.mp4");
      await fs.writeFile(mixedAudioPath, mixedAudioBuffer);
      await mergeAudioIntoVideo(origVideoPath, mixedAudioPath, outputVideoPath);
      const videoBuffer = await fs.readFile(outputVideoPath);
      resultBase64 = videoBuffer.toString("base64");
      resultMime = "video/mp4";
      resultExt = "mp4";
    } else {
      resultBase64 = mixedAudioBuffer.toString("base64");
      resultMime = "audio/mpeg";
      resultExt = "mp3";
    }

    // 임시 작업 디렉토리 정리
    await fs.rm(workDir, { recursive: true, force: true });

    await db.update(dubbingJobs)
      .set({ status: "COMPLETED", dubbedFileUrl: "base64_encoded" })
      .where(eq(dubbingJobs.id, jobId));

    // 빈 라인 없이, 소리효과는 원본 그대로 표시
    const transcriptSummary = segments
      .filter((s) => s.text.trim().length > 0)
      .map((s) => `[${s.speaker}] ${s.text}`)
      .join("\n");
    const translatedSummary = segments
      .map((s, i) => ({ s, t: translatedSegments[i] }))
      .filter(({ s, t }) => s.text.trim().length > 0 && t && t.trim().length > 0)
      .map(({ s, t }) => `[${s.speaker}] ${t}`)
      .join("\n");

    return NextResponse.json({
      success: true,
      mediaUrl: `data:${resultMime};base64,${resultBase64}`,
      mediaType: isVideo ? "video" : "audio",
      fileExt: resultExt,
      transcript: transcriptSummary,
      translatedText: translatedSummary,
      speakerCount: Object.keys(speakerVoiceMap).length,
    });

  } catch (error: any) {
    if (jobId)
      await db.update(dubbingJobs)
        .set({ status: "FAILED", errorMessage: error.message })
        .where(eq(dubbingJobs.id, jobId));
    return NextResponse.json(
      { error: error.message || "알 수 없는 에러" },
      { status: 500 }
    );
  }
}
