import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { dubbingJobs, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

// Dynamic import at runtime to prevent module reference errors during build
const getFFmpeg = () => {
  const ffmpeg = require("fluent-ffmpeg");
  const ffmpegStatic = require("ffmpeg-static");
  const ffprobeStatic = require("ffprobe-static");
  
  if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
  }
  if (ffprobeStatic) {
    ffmpeg.setFfprobePath(ffprobeStatic.path);
  }
  return ffmpeg;
};

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

// Shared utility re-import (same helpers as route.ts)
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

async function extractAudioClip(source: string, start: number, duration: number, output: string): Promise<void> {
  const ffmpeg = getFFmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg(source)
      .setStartTime(start)
      .setDuration(duration)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .output(output)
      .on("end", () => resolve())
      .on("error", (e: Error) => reject(new Error(`ffmpeg clip: ${e.message}`)))
      .run();
  });
}

interface Segment { speaker: string; text: string; start: number; end: number; }

function cleanText(t: string): string {
  return t.replace(/[\(（【《\[「{][^)\)】》\]」}]{0,30}[\)）】》\]」}]/g, "").trim();
}

async function mixAudioClips(
  clips: { buffer: Buffer; start: number; duration: number }[],
  totalDuration: number,
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remix-mix-"));
  try {
    const silencePath = path.join(tmpDir, "silence.wav");
    const outputPath = path.join(tmpDir, "output.mp3");
    const sampleRate = 44100;
    const numSamples = Math.ceil(totalDuration * sampleRate);
    const dataSize = numSamples * 2;
    const fileSize = 44 + dataSize;
    const wav = Buffer.alloc(fileSize);
    wav.write("RIFF", 0); wav.writeUInt32LE(fileSize - 8, 4); wav.write("WAVE", 8);
    wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(dataSize, 40);
    await fs.writeFile(silencePath, wav);

    const clipPaths: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const p = path.join(tmpDir, `clip_${i}.mp3`);
      await fs.writeFile(p, clips[i].buffer);
      clipPaths.push(p);
    }

    const filterParts: string[] = [];
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
      filterParts.push(`[${inputIdx}:a]atempo=${tempo.toFixed(3)}[s${i}]`);
      filterParts.push(`[s${i}]adelay=${delayMs}|${delayMs}[d${i}]`);
      mixInputs += `[d${i}]`;
    }
    filterParts.push(`${mixInputs}amix=inputs=${clips.length + 1}:normalize=0[out]`);
    const filterComplex = filterParts.join(";");

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = getFFmpeg();
      let f = ffmpeg();
      f = f.input(silencePath);
      for (const cp of clipPaths) f = f.input(cp);
      f.complexFilter(filterComplex, "out")
        .audioCodec("libmp3lame").audioBitrate("128k")
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(new Error(`ffmpeg: ${err.message}`)))
        .run();
    });
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function mergeAudioIntoVideo(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  const ffmpeg = getFFmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath).input(audioPath)
      .outputOptions([
        "-c:v copy", 
        "-c:a aac", 
        "-map 0:v:0", 
        "-map 1:a:0", 
        "-shortest",
        "-movflags +faststart"
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`Failed to merge video: ${err.message}`)))
      .run();
  });
}

function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["mp4", "mov", "webm", "avi", "mkv", "m4v"].includes(ext);
}

export async function POST(request: Request) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
  if (!ELEVENLABS_API_KEY) return NextResponse.json({ error: "Missing API key" }, { status: 500 });

  const session = await getServerSession(authOptions);
  let userId = (session?.user as any)?.id;
  if (!userId && session?.user?.email) {
    const found = await db.select().from(users).where(eq(users.email, session.user.email)).limit(1);
    if (found.length > 0) userId = found[0].id;
  }
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const formData = await request.formData();
    const jobId = formData.get("job_id") as string;
    const editedTranslationsRaw = formData.get("edited_translations") as string;
    const file = formData.get("audio_file") as File;

    if (!jobId || !editedTranslationsRaw || !file)
      return NextResponse.json({ error: "job_id, edited_translations, audio_file are required" }, { status: 400 });

    // Load existing job from DB
    const [job] = await db.select().from(dubbingJobs).where(eq(dubbingJobs.id, jobId)).limit(1);
    if (!job || job.userId !== userId) return NextResponse.json({ error: "Job not found or unauthorized" }, { status: 404 });

    const segments: Segment[] = JSON.parse(job.segmentsJson ?? "[]");
    const speakerVoiceMap: Record<string, string> = JSON.parse(job.cloneVoiceMapJson ?? "{}");
    const editedTranslations: string[] = JSON.parse(editedTranslationsRaw);

    if (segments.length === 0) return NextResponse.json({ error: "No stored segment data (re-upload required)" }, { status: 400 });

    const totalDuration = segments[segments.length - 1].end;

    // Prepare original file work directory
    const isVideo = isVideoFile(file);
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "remix-"));
    const origPath = path.join(workDir, "original" + (file.name.includes(".") ? "." + file.name.split(".").pop() : ".mp4"));
    const extractedAudioPath = path.join(workDir, "extracted.mp3");
    await fs.writeFile(origPath, buffer);
    if (isVideo) await extractAudioFromVideo(origPath, extractedAudioPath);

    const MIN_CLIP_DURATION = 0.15;
    const clips: { buffer: Buffer; start: number; duration: number }[] = [];

    // Per-segment TTS or original audio extraction
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDuration = seg.end - seg.start;
      const translated = editedTranslations[i] ?? "";
      const isSoundSeg = cleanText(seg.text).trim() === "";

      if (isSoundSeg) {
        if (segDuration < MIN_CLIP_DURATION) continue;
        const clipPath = path.join(workDir, `sound_${i}.mp3`);
        const sourceForClip = isVideo ? extractedAudioPath : origPath;
        try {
          await extractAudioClip(sourceForClip, seg.start, segDuration, clipPath);
          const clipBuf = await fs.readFile(clipPath);
          if (clipBuf.length > 1000) clips.push({ buffer: clipBuf, start: seg.start, duration: segDuration });
        } catch (e) {
          console.warn(`Ignore sound effect extraction failure: ${seg.text}`, e);
        }
        continue;
      }

      if (!translated.trim()) continue;

      const voiceId = speakerVoiceMap[seg.speaker];
      if (!voiceId) continue;

      const ttsRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ text: translated, model_id: "eleven_multilingual_v2" }),
        }
      );
      if (!ttsRes.ok) throw new Error(`TTS failed (${seg.speaker}): ${await ttsRes.text()}`);
      clips.push({ buffer: Buffer.from(await ttsRes.arrayBuffer()), start: seg.start, duration: segDuration });
    }

    const mixedAudioBuffer = await mixAudioClips(clips, totalDuration);

    let resultBase64: string;
    let resultMime: string;
    let resultExt: string;

    if (isVideo) {
      const mixedAudioPath = path.join(workDir, "dubbed.mp3");
      const outputVideoPath = path.join(workDir, "output.mp4");
      await fs.writeFile(mixedAudioPath, mixedAudioBuffer);
      await mergeAudioIntoVideo(origPath, mixedAudioPath, outputVideoPath);
      resultBase64 = (await fs.readFile(outputVideoPath)).toString("base64");
      resultMime = "video/mp4";
      resultExt = "mp4";
    } else {
      resultBase64 = mixedAudioBuffer.toString("base64");
      resultMime = "audio/mpeg";
      resultExt = "mp3";
    }

    await fs.rm(workDir, { recursive: true, force: true });

    // Save updated translation to DB
    await db.update(dubbingJobs)
      .set({ translationsJson: JSON.stringify(editedTranslations) })
      .where(eq(dubbingJobs.id, jobId));

    return NextResponse.json({
      success: true,
      mediaUrl: `data:${resultMime};base64,${resultBase64}`,
      mediaType: isVideo ? "video" : "audio",
      fileExt: resultExt,
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Unknown error" }, { status: 500 });
  }
}
