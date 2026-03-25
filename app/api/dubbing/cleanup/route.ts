import { NextResponse } from "next/server";
import { db } from "@/db";
import { dubbingJobs } from "@/db/schema";
import { eq } from "drizzle-orm";

// Voice Clone deletion helper
async function deleteVoice(apiKey: string, voiceId: string): Promise<void> {
  await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": apiKey },
  }).catch(() => {});
}

/**
 * POST /api/dubbing/cleanup
 * Body: { jobId: string }
 *
 * Called via navigator.sendBeacon on tab/window close.
 * Deletes ElevenLabs Voice Clones + Cleans up DB cloneVoiceMapJson.
 */
export async function POST(request: Request) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) return new Response(null, { status: 204 });

  try {
    const body = await request.json().catch(() => ({}));
    const jobId = body?.jobId as string | undefined;
    if (!jobId) return new Response(null, { status: 204 });

    const [job] = await db.select().from(dubbingJobs).where(eq(dubbingJobs.id, jobId)).limit(1);
    if (!job?.cloneVoiceMapJson) return new Response(null, { status: 204 });

    const cloneVoiceMap: Record<string, string> = JSON.parse(job.cloneVoiceMapJson);
    const cloneIds = Object.values(cloneVoiceMap);

    // Parallel deletion (ignore failures)
    await Promise.all(cloneIds.map((id) => deleteVoice(ELEVENLABS_API_KEY, id)));

    // DB cleanup
    await db.update(dubbingJobs)
      .set({ cloneVoiceMapJson: null, segmentsJson: null, translationsJson: null })
      .where(eq(dubbingJobs.id, jobId));

    console.log(`[Cleanup] Voice Clones (${cloneIds.length}) and DB cache for Job ID ${jobId} have been deleted.`);

  } catch {
    // Cleanup fails silently
  }

  return new Response(null, { status: 204 });
}
