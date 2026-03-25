import { NextResponse } from "next/server";
import { db } from "@/db";
import { dubbingJobs } from "@/db/schema";
import { eq } from "drizzle-orm";

// Voice Clone 삭제 헬퍼
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
 * 탭/창 닫기 시 navigator.sendBeacon으로 호출됨.
 * ElevenLabs Voice Clone 삭제 + DB cloneVoiceMapJson 정리.
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

    // 병렬 삭제 (실패 무시)
    await Promise.all(cloneIds.map((id) => deleteVoice(ELEVENLABS_API_KEY, id)));

    // DB 정리
    await db.update(dubbingJobs)
      .set({ cloneVoiceMapJson: null, segmentsJson: null, translationsJson: null })
      .where(eq(dubbingJobs.id, jobId));

    console.log(`[Cleanup] Job ID ${jobId} 의 Voice Clone(${cloneIds.length}개) 및 DB 캐시가 삭제되었습니다.`);

  } catch {
    // cleanup은 조용히 실패
  }

  return new Response(null, { status: 204 });
}
