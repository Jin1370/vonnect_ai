import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('./db');
  const { whitelist } = await import('./db/schema');
  
  try {
    await db.insert(whitelist).values({ 
      email: 'kts123@estsoft.com' 
    }).onConflictDoNothing();
    
    console.log("✅ 성공적으로 화이트리스트에 kts123@estsoft.com 계정을 추가했습니다!");
  } catch (error) {
    console.error("❌ 에러 발생:", error);
  }
  process.exit(0);
}

main();

main();
