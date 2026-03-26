import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { dubbingJobs, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

// Dynamic import at runtime to prevent module reference errors during build
const getFFmpeg = () => {
  const ffmpeg = require("fluent-ffmpeg");
  const ffmpegStatic = require("ffmpeg-static");
  if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
  }
  return ffmpeg;
};



// ElevenLabs STT Diarization response type definition
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

// Check if word token is a sound effect (word-level, short bracketed text)
const WORD_SOUND_PATTERN = /^[\(\[\{《【「].*[\)\]\}》】」]$/;
function isSoundWord(text: string): boolean {
  return WORD_SOUND_PATTERN.test(text.trim());
}

// Merge word list into speaker-based speech segments
// Sound effect tokens are always separated into independent segments for original audio extraction
function buildSegments(words: ELWord[]): Segment[] {
  const segments: Segment[] = [];
  let cur: Segment | null = null;

  for (const w of words) {
    const spk = w.speaker_id ?? "speaker_0";
    const isSound = isSoundWord(w.text);

    // New segment starts if sound effect token or speaker changes
    if (!cur || cur.speaker !== spk || isSound || isSoundWord(cur.text)) {
      if (cur) segments.push(cur);
      cur = { speaker: spk, text: w.text, start: w.start, end: w.end };
    } else {
      cur.text += " " + w.text;
      cur.end = w.end;
    }

    // Sound effect tokens are closed immediately as independent segments
    if (isSound) {
      segments.push(cur!);
      cur = null;
    }
  }
  if (cur) segments.push(cur);
  return segments;
}



// Remove non-verbal sound expressions in text
// Replace bracketed patterns like (laughter), [applause], {music} with spaces
const INLINE_SOUND_PATTERN = /[\(\[\{《【「][^\)\]\}》】」]{1,40}[\)\]\}》】」]/g;
function cleanText(text: string): string {
  return text.replace(INLINE_SOUND_PATTERN, " ").replace(/\s{2,}/g, " ").trim();
}

// Extract specific duration (start~end seconds) from original audio
async function extractAudioClip(
  sourcePath: string,
  start: number,
  duration: number,
  outputPath: string,
): Promise<void> {
  const ffmpeg = getFFmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setStartTime(start)
      .setDuration(duration)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`Failed to extract original clip: ${err.message}`)))
      .run();
  });
}

async function mixAudioClips(
  clips: { buffer: Buffer; start: number; duration: number }[],
  totalDuration: number,
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dubbing-"));

  try {
    // 1. Save each clip file to temporary directory
    const clipPaths: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const p = path.join(tmpDir, `clip_${i}.mp3`);
      await fs.writeFile(p, clips[i].buffer);
      clipPaths.push(p);
    }

    // 2. Create silence base track as pure Node.js WAV Buffer (lavfi not required)
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


    // 3. Measure actual playback duration for each clip → Calculate atempo speed correction ratio
    const outputPath = path.join(tmpDir, "output.mp3");
    const filterParts: string[] = [];
    const inputArgs: string[] = [];

    inputArgs.push("-i", silencePath);
    for (let i = 0; i < clips.length; i++) {
      inputArgs.push("-i", clipPaths[i]);
    }

    // Filter graph: Adjust each clip's speed to match original duration, then apply delay
    let mixInputs = "[0:a]";
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const targetDuration = clip.duration;
      
      // Get actual clip duration using ffprobe for 1ms precision
      const actualDuration = await getAudioDuration(clipPaths[i]);
      
      const tempo = Math.min(2.0, Math.max(0.5, actualDuration / targetDuration));
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

    const ffmpeg = getFFmpeg();
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg();
      for (const arg of inputArgs) {
        if (arg === "-i") continue;
      }
      // Specify inputArgs and filter directly in fluent-ffmpeg
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
    // Temporary file cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Video MIME or extension detection
function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["mp4", "mov", "webm", "avi", "mkv", "m4v"].includes(ext);
}

// Shared utility to get exact duration of an audio file using ffprobe
async function getAudioDuration(filePath: string): Promise<number> {
  const ffmpeg = getFFmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
      const duration = metadata.format.duration;
      if (duration === undefined) return reject(new Error("ffprobe: could not determine duration"));
      resolve(Number(duration));
    });
  });
}

// Extract audio only from video (MP3)
async function extractAudioFromVideo(videoPath: string, outputAudioPath: string): Promise<void> {
  const ffmpeg = getFFmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .output(outputAudioPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`Failed to extract audio: ${err.message}`)))
      .run();
  });
}

// Overwrite original video with dubbed audio (remove original audio)
async function mergeAudioIntoVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
    const ffmpeg = getFFmpeg();
    return new Promise((resolve, reject) => {
      ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v:0",   // Original video track
        "-map", "1:a:0",   // Dubbed audio track
        "-c:v", "copy",    // Fast copy for video without re-encoding
        "-c:a", "aac",     // Encode audio as AAC (MP4 compatible)
        "-shortest",       // Exit based on shortest duration
        "-movflags", "+faststart", // Better for web/mobile streaming
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`Failed to merge video: ${err.message}`)))
      .run();
  });
}

// Concatenate speaker speech segments using FFmpeg concat to create sample audio
// Collect 30s min, 3min max for voice cloning quality
async function buildSpeakerSample(
  sourcePath: string,
  segments: { start: number; end: number }[],
  outputPath: string,
): Promise<number> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sample-"));
  try {
    const partPaths: string[] = [];
    let totalSecs = 0;
    for (let i = 0; i < segments.length; i++) {
      const dur = segments[i].end - segments[i].start;
      if (dur < 0.5) continue;
      const p = path.join(tmpDir, `part_${i}.mp3`);
      const ffmpeg = getFFmpeg();
      await new Promise<void>((resolve, reject) => {
        ffmpeg(sourcePath)
          .setStartTime(segments[i].start)
          .setDuration(dur)
          .noVideo()
          .audioCodec("libmp3lame")
          .audioBitrate("128k")
          .output(p)
          .on("end", () => resolve())
          .on("error", (e: Error) => reject(e))
          .run();
      });
      partPaths.push(p);
      totalSecs += dur;
      if (totalSecs >= 180) break; // max 3 minutes
    }
    if (partPaths.length === 0) throw new Error("No sample clips found");

    // Copy directly if single part, otherwise concat
    if (partPaths.length === 1) {
      await fs.copyFile(partPaths[0], outputPath);
    } else {
      const listFile = path.join(tmpDir, "list.txt");
      await fs.writeFile(listFile, partPaths.map((p) => `file '${p}'`).join("\n"));
      const ffmpeg = getFFmpeg();
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .audioCodec("libmp3lame")
          .audioBitrate("128k")
          .output(outputPath)
          .on("end", () => resolve())
          .on("error", (e: Error) => reject(e))
          .run();
      });
    }
    return totalSecs;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Create ElevenLabs Instant Voice Clone → Return Clone Voice ID
async function cloneVoice(
  apiKey: string,
  name: string,
  samplePath: string,
): Promise<string> {
  const sampleBuf = await fs.readFile(samplePath);
  const form = new FormData();
  form.append("name", name);
  form.append("description", "Auto-generated clone for dubbing");
  form.append(
    "files",
    new Blob([sampleBuf], { type: "audio/mpeg" }),
    path.basename(samplePath),
  );
  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!res.ok) throw new Error(`Failed to create Voice Clone: ${await res.text()}`);
  const data = await res.json();
  return data.voice_id as string;
}

// Delete Clone voice after dubbing completed (Free up slot)
async function deleteVoice(apiKey: string, voiceId: string): Promise<void> {
  await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": apiKey },
  }).catch(() => {}); // Ignore deletion failure
}

export async function POST(request: Request) {

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

  if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY) {
    return NextResponse.json(
      { error: "Missing API keys in environment variables." },
      { status: 500 }
    );
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  // Authentication
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

    if (!file) return NextResponse.json({ error: "No file uploaded." }, { status: 400 });

    const isVideo = isVideoFile(file);
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract and save temporary audio for STT if it's a video
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
    // [STEP 1] ElevenLabs STT — Speaker diarization using diarize=true
    // ────────────────────────────────────────────────────────────────
    const sttForm = new FormData();
    sttForm.append("file", new Blob([sttBuffer], { type: sttMime }), sttFileName);
    sttForm.append("model_id", "scribe_v1");
    sttForm.append("diarize", "true");  // Core for speaker diarization

    const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: sttForm,
    });
    if (!sttRes.ok) throw new Error(`STT failed: ${await sttRes.text()}`);
    const sttData = await sttRes.json();

    // Construct speech segments using word-level timestamps
    const words: ELWord[] = sttData.words ?? [];
    if (words.length === 0) throw new Error("Could not extract speech text.");

    const segments = buildSegments(words);
    const totalDuration = segments[segments.length - 1].end;

    // ────────────────────────────────────────────────────────────────
    // [STEP 2] OpenAI GPT-4o — Translate while preserving segment structure
    // ────────────────────────────────────────────────────────────────
    await db.update(dubbingJobs).set({ status: "TRANSLATING" }).where(eq(dubbingJobs.id, jobId));

    const speechSegments = segments.filter((s) => s.text.trim().length > 0);
    const segmentsJson = JSON.stringify(
      // Pass all segments including sound effects to GPT for translation context
      speechSegments.map((s) => ({ speaker: s.speaker, text: s.text }))
    );

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a professional dubbing translator.
You will receive a JSON array of speech segments. Some segments may contain non-verbal sounds in parentheses like (laughter), [applause] etc.
For regular speech: translate into ${targetLanguage} naturally and concisely.
For parenthetical sounds: translate the label too (e.g., (laughter) → (sound/laughter translation)).
Return a JSON object: {"segments": [{"speaker": "...", "translatedText": "..."}]}`,
        },
        { role: "user", content: segmentsJson },
      ],
    });

    const parsed = JSON.parse(completion.choices[0].message.content || "{}");
    const rawTranslated: { speaker: string; translatedText: string }[] =
      parsed.segments ?? [];

    // Realign translation results with original segment order (including empty ones)
    // Handle empty text segments as "" (exclude from summary)
    let translationIdx = 0;
    const translatedSegments: string[] = segments.map((s) => {
      if (!s.text.trim()) return ""; // Empty segment → Skip
      return rawTranslated[translationIdx++]?.translatedText ?? s.text;
    });

    // ────────────────────────────────────────────────────────────────
    // [STEP 3-A] Collect speech samples per speaker → Create Instant Voice Clone
    // ────────────────────────────────────────────────────────────────
    await db.update(dubbingJobs).set({ status: "SYNTHESIZING" }).where(eq(dubbingJobs.id, jobId));

    const sourceAudioForSample = isVideo ? extractedAudioPath : origVideoPath;

    // Group speech segments by speaker
    const speakerSegs: Record<string, { start: number; end: number }[]> = {};
    for (const seg of segments) {
      if (cleanText(seg.text).trim() === "") continue; // Exclude sound effects
      if (!speakerSegs[seg.speaker]) speakerSegs[seg.speaker] = [];
      speakerSegs[seg.speaker].push({ start: seg.start, end: seg.end });
    }

    // Create Clone Voice ID per speaker (fallback to premade voices on failure)
    const FALLBACK_VOICES = [
      "EXAVITQu4vr4xnSDxMaL", // Sarah
      "IKne3meq5aSn9XLyUdCD", // Charlie
      "JBFqnCBsd6RMkjVDRZzb", // George
      "FGY2WhTYpPnrIDTdsKH5", // Laura
    ];
    const speakerVoiceMap: Record<string, string> = {};
    const clonedVoiceIds: string[] = []; // List of Clone IDs to be deleted later
    let fallbackIdx = 0;

    for (const [speaker, segs] of Object.entries(speakerSegs)) {
      try {
        const samplePath = path.join(workDir, `sample_${speaker}.mp3`);
        const sampleSecs = await buildSpeakerSample(sourceAudioForSample, segs, samplePath);
        const cloneId = await cloneVoice(
          ELEVENLABS_API_KEY,
          `dub_${jobId.slice(0, 8)}_${speaker}`,
          samplePath,
        );
        speakerVoiceMap[speaker] = cloneId;
        clonedVoiceIds.push(cloneId);
      } catch (e) {
        speakerVoiceMap[speaker] = FALLBACK_VOICES[fallbackIdx % FALLBACK_VOICES.length];
        fallbackIdx++;
      }
    }

    // Assign fallback to speakers without clones (e.g., sound effects or cloning failed)
    for (const seg of segments) {
      if (!(seg.speaker in speakerVoiceMap)) {
        speakerVoiceMap[seg.speaker] = FALLBACK_VOICES[fallbackIdx % FALLBACK_VOICES.length];
        fallbackIdx++;
      }
    }

    // ────────────────────────────────────────────────────────────────
    // [STEP 3-B] Per-segment TTS (Using Clone or fallback voice)
    // ────────────────────────────────────────────────────────────────
    const clips: { buffer: Buffer; start: number; duration: number }[] = [];
    const MIN_CLIP_DURATION = 0.15;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const translated = translatedSegments[i];
      const segDuration = seg.end - seg.start;

      const isSoundSeg = cleanText(seg.text).trim() === "";

      if (isSoundSeg) {
        if (segDuration < MIN_CLIP_DURATION) continue;
        const clipPath = path.join(workDir, `sound_${i}.mp3`);
        const sourceForClip = isVideo ? extractedAudioPath : origVideoPath;
        try {
          await extractAudioClip(sourceForClip, seg.start, segDuration, clipPath);
          const clipBuf = await fs.readFile(clipPath);
          if (clipBuf.length > 1000) {
            clips.push({ buffer: clipBuf, start: seg.start, duration: segDuration });
          }
        } catch (e) {
          // ignore error
        }
        continue;
      }

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
      if (!ttsRes.ok) throw new Error(`TTS failed (${seg.speaker}): ${await ttsRes.text()}`);

      clips.push({
        buffer: Buffer.from(await ttsRes.arrayBuffer()),
        start: seg.start,
        duration: segDuration,
      });
    }

    // Don't delete Clone immediately for Re-dub → Save Clone ID map to DB


    // ────────────────────────────────────────────────────────────────
    // [STEP 4] FFmpeg mixing — Timestamp-based audio synthesis
    // ────────────────────────────────────────────────────────────────
    const mixedAudioBuffer = await mixAudioClips(clips, totalDuration);

    // Combine dubbed audio with original video and return as MP4 if video
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

    // Temporary work directory cleanup
    await fs.rm(workDir, { recursive: true, force: true });

    // Re-dub support: Save segments/translations/cloneVoiceMap to DB
    await db.update(dubbingJobs)
      .set({
        status: "COMPLETED",
        dubbedFileUrl: "base64_encoded",
        segmentsJson: JSON.stringify(segments),
        translationsJson: JSON.stringify(translatedSegments),
        cloneVoiceMapJson: JSON.stringify(speakerVoiceMap),
      })
      .where(eq(dubbingJobs.id, jobId));

    // Display without empty lines, keep sound effects as original
    const transcriptSummary = segments
      .filter((s) => s.text.trim().length > 0)
      .map((s) => `[${s.speaker}] ${s.text}`)
      .join("\n");
    const translatedSummary = segments
      .map((s, i) => ({ s, t: translatedSegments[i] }))
      .filter(({ s, t }) => s.text.trim().length > 0 && t && t.trim().length > 0)
      .map(({ s, t }) => `[${s.speaker}] ${t}`)
      .join("\n");

    // For Re-dub: List of translated texts per segment (pass to frontend for editing)
    const editableTranslations = segments.map((s, i) => ({
      speaker: s.speaker,
      original: s.text,
      translated: translatedSegments[i] ?? "",
      start: s.start,
      end: s.end,
      isSoundEffect: cleanText(s.text).trim() === "",
    }));

    return NextResponse.json({
      success: true,
      jobId,
      mediaUrl: `data:${resultMime};base64,${resultBase64}`,
      mediaType: isVideo ? "video" : "audio",
      fileExt: resultExt,
      transcript: transcriptSummary,
      translatedText: translatedSummary,
      speakerCount: Object.keys(speakerVoiceMap).length,
      editableTranslations,
    });

  } catch (error: any) {
    if (jobId)
      await db.update(dubbingJobs)
        .set({ status: "FAILED", errorMessage: error.message })
        .where(eq(dubbingJobs.id, jobId));
    return NextResponse.json(
      { error: error.message || "Unknown error" },
      { status: 500 }
    );
  }
}
