import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { dubbingJobs, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import OpenAI from "openai";

export async function POST(request: Request) {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

    if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY) {
        return NextResponse.json(
            {
                error: "환경변수에 API 키(OPENAI_API_KEY 또는 ELEVENLABS_API_KEY)가 제대로 등록되지 않았습니다.",
            },
            { status: 500 },
        );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    // 무료 요금제(Free 플랜)에서도 사용 가능한 프리메이드 보이스 (Sarah - 성숙하고 차분한 톤)
    const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

    // 1. 보안 인가 체크
    const session = await getServerSession(authOptions);
    let userId = (session?.user as any)?.id;
    
    // 만약 이전 세션 캐시 때문에 JWT에 ID가 안 들어있다면 이메일로 DB 직접 조회 보완
    if (!userId && session?.user?.email) {
        const found = await db.select().from(users).where(eq(users.email, session.user.email)).limit(1);
        if (found.length > 0) userId = found[0].id;
    }

    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let jobId = "";

    try {
        const formData = await request.formData();
        const file = formData.get("audio_file") as File;
        const targetLanguage =
            (formData.get("target_language") as string) || "ko";

        if (!file) {
            return NextResponse.json(
                { error: "파일이 업로드되지 않았습니다." },
                { status: 400 },
            );
        }

        // 파일 로드
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 2. DB 이력 생성
        const [job] = await db
            .insert(dubbingJobs)
            .values({
                userId,
                originalFileUrl: "local_memory_" + file.name,
                targetLanguage,
                status: "TRANSCRIBING",
            })
            .returning();
        jobId = job.id;

        // --------------------------------------------------------------------------
        // [Step 1] ElevenLabs STT (음성 전사, Speech-To-Text)
        // --------------------------------------------------------------------------
        const sttFormData = new FormData();
        const audioBlob = new Blob([buffer], {
            type: file.type || "audio/mpeg",
        });
        sttFormData.append("file", audioBlob, file.name);
        sttFormData.append("model_id", "scribe_v1"); // ElevenLabs 필수 파라미터 추가

        const sttResponse = await fetch(
            "https://api.elevenlabs.io/v1/speech-to-text",
            {
                method: "POST",
                headers: { "xi-api-key": ELEVENLABS_API_KEY },
                body: sttFormData,
            },
        );

        if (!sttResponse.ok) {
            throw new Error(`전사(STT) API 실패: ${await sttResponse.text()}`);
        }
        const sttData = await sttResponse.json();
        const transcript = sttData.text;

        if (!transcript) throw new Error("추출된 음성 텍스트가 없습니다.");

        // --------------------------------------------------------------------------
        // [Step 2] OpenAI Translation (전문 번역)
        // --------------------------------------------------------------------------
        await db
            .update(dubbingJobs)
            .set({ status: "TRANSLATING" })
            .where(eq(dubbingJobs.id, jobId));

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a highly skilled professional emotional dubbing translator. Translate the given script fluently into ${targetLanguage}. Maintain the speaker's original emotional tone and brevity. Reply ONLY with the translated text without quotes or explanations.`,
                },
                { role: "user", content: transcript },
            ],
        });

        const translatedText = completion.choices[0].message.content || "";

        // --------------------------------------------------------------------------
        // [Step 3] ElevenLabs TTS (음성 합성)
        // --------------------------------------------------------------------------
        await db
            .update(dubbingJobs)
            .set({ status: "SYNTHESIZING" })
            .where(eq(dubbingJobs.id, jobId));

        const ttsResponse = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE_ID}?output_format=mp3_44100_128`,
            {
                method: "POST",
                headers: {
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    text: translatedText,
                    model_id: "eleven_multilingual_v2", // 다국어 자연스러운 합성 필수
                }),
            },
        );

        if (!ttsResponse.ok) {
            throw new Error(`합성(TTS) API 실패: ${await ttsResponse.text()}`);
        }

        const audioBuffer = await ttsResponse.arrayBuffer();
        // 브라우저로 즉시 쏴주기 위해 Base64로 인코딩합니다 (원래는 S3 저장 권장)
        const base64Audio = Buffer.from(audioBuffer).toString("base64");
        const audioUrl = `data:audio/mpeg;base64,${base64Audio}`;

        // 3. DB 완료 업데이트
        await db
            .update(dubbingJobs)
            .set({
                status: "COMPLETED",
                dubbedFileUrl: "base64_encoded",
            })
            .where(eq(dubbingJobs.id, jobId));

        // 결과 반환
        return NextResponse.json({
            success: true,
            audioUrl,
            transcript,
            translatedText,
        });
    } catch (error: any) {
        if (jobId)
            await db
                .update(dubbingJobs)
                .set({ status: "FAILED", errorMessage: error.message })
                .where(eq(dubbingJobs.id, jobId));
        return NextResponse.json(
            { error: error.message || "알 수 없는 에러가 발생했습니다." },
            { status: 500 },
        );
    }
}
