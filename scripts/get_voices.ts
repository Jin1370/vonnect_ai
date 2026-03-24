import { config } from 'dotenv';
config({ path: '.env.local' });

async function getVoices() {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! }
  });
  const data = await res.json();
  if (data.voices) {
    console.log("== 사용 가능한 무료 보이스 리스트 ==");
    const premades = data.voices.filter((v: any) => v.category === "premade").slice(0, 5);
    for (const v of premades) {
       console.log(`이름: ${v.name}, ID: ${v.voice_id}`);
    }
  } else {
    console.error("에러:", data);
  }
}
getVoices();
