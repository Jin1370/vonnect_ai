# 🎙️ Vonnect AI - Multi-Speaker AI Dubbing Platform

[English Version (README_EN.md)](./README_EN.md)

---

> **AI가 제안하는 완벽한 더빙 솔루션.**
> 복잡한 영상 더빙을 화자 분리(Diarization)부터 목소리 복제(Cloning)까지 한 번에 해결하세요.

<div align="center">

### 🚀 [데모 보러가기](https://vonnect-ai.vercel.app/)

[![Vercel Deployment](https://img.shields.io/badge/Vercel-Deployed-black?logo=vercel&style=for-the-badge)](https://vonnect-ai.vercel.app/)

---

</div>

## 🔒 서비스 이용 안내 (Closed Beta)

현재 본 서비스는 고품질 AI 리소스(ElevenLabs, OpenAI) 관리 및 최적의 경험을 위해 **화이트리스트(Whitelist)** 제도로 운영되고 있습니다.

- **체험 방법**: 레포지토리에 **Star ⭐️**를 남겨주시고, [Issues](https://github.com/Jin1370/vonnect_ai/issues) 탭에 체험을 원하시는 이메일 주소를 남겨주시면 확인 후 순차적으로 등록해 드립니다. 실시간 보이스 클로닝 및 자동 더빙 엔진 사용에 따른 리소스 제한 때문이니 너그러운 양해 부탁드립니다!

---

## 🌟 서비스 소개 및 주요 기능

**Vonnect AI**는 단순한 목소리 합성을 넘어, 영상 속 여러 화자를 지능적으로 구분하고 각 화자의 개성을 살린 더빙을 제공하는 프리미엄 웹 플랫폼입니다.

- **🤖 지능형 다화자 분리(Diarization)**: ElevenLabs AI를 통해 영상 속 여러 화자를 자동으로 인식하고 개별 세그먼트로 분리합니다.
- **🎙️ 실시간 보이스 클로닝(Instant Voice Cloning)**: 각 화자의 샘플 오디오를 추출하여, 원본과 가장 흡사한 목소리로 더빙을 생성합니다.
- **✍️ 반응형 번역 및 편집(Interactive Re-dub)**: GPT-4o를 이용한 고품질 번역 결과물을 사용자가 직접 확인하고, 즉시 수정하여 다시 더빙할 수 있습니다.
- **⚡ 클라이언트 기반 전처리**: FFmpeg WASM을 사용하여 대용량 파일도 브라우저에서 즉시 1분 내외로 크롭하여 빠른 처리가 가능합니다.
- **📱 프리미엄 반응형 UI**: 세련된 디자인과 모바일 인터페이스를 제공합니다.

---

## 🛠 사용한 기술 스택

### **Frontend / UI**

- **Framework**: `Next.js` (App Router)
- **Styling**: `Tailwind CSS`, `Vanilla CSS`
- **Icons**: `Heroicons` (Solid), `Lucide React`
- **Logic**: `FFmpeg/WASM` (Client-side), `React Hooks`

### **Backend / Database**

- **Runtime**: `Node.js` (Vercel Serverless)
- **Database**: `Turso` (LibSQL)
- **ORM**: `Drizzle ORM`
- **Authentication**: `NextAuth.js` (Google OAuth)

### **AI Core**

- **Audio Processing**: `ElevenLabs API` (STT, TTS, Diarization, Voice Cloning)
- **Translation**: `OpenAI GPT-4o`
- **Video/Audio Logic**: `fluent-ffmpeg` (Server-side)

---

## 🚀 로컬 실행 방법

이 프로젝트를 로컬에서 실행하려면 아래 과정을 따르세요.

### 1. 환경 설정 (`.env.local`)

루트 디렉토리에 `.env.local` 파일을 생성하고 다음 키를 입력하세요.

```env
TURSO_DATABASE_URL=your_turso_url
TURSO_AUTH_TOKEN=your_turso_token
ELEVENLABS_API_KEY=your_elevenlabs_key
OPENAI_API_KEY=your_openai_key
NEXTAUTH_SECRET=your_nextauth_secret
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=your_google_id
GOOGLE_CLIENT_SECRET=your_google_secret
```

### 2. 설치 및 실행

```bash
# 의존성 설치
npm install

# 데이터베이스 푸시 (Drizzle)
npm run db:push

# 서버 실행
npm run dev
```

브라우저에서 `http://localhost:3000`에 접속하세요.

---

## 🤖 코딩 에이전트 활용 방법 및 노하우

이 프로젝트는 **고성능 AI 코딩 에이전트(Antigravity)**와의 협업을 통해 단기간에 완성되었습니다. AI와 함께 개발하며 얻은 노하우를 공유합니다.

1.  **목적 중심의 페어 프로그래밍**: 단순히 코드를 맡기는 것이 아니라 **구체적인 기술적 문제**를 AI에게 정의해주었을 때 가장 강력한 해결책을 제시했습니다.
2.  **반복적인 UI 정교화**: "세련된 테마와 Glassmorphism을 적용해줘"와 같은 디자인 추상화를 AI가 CSS 변수와 Utility Class로 완벽하게 변환하여 생산성을 극대화했습니다.
3.  **디버깅 가속화**: WASM 메모리 이슈나 로그 분석 시, AI가 수천 줄의 로그를 실시간 분석하여 원인을 짚어줌으로써 개발 시간을 70% 이상 단축했습니다.
4.  **글로벌 현지화**: 상호작용 메시지를 AI를 통해 완벽하게 영문화하여 글로벌 프로젝트로 확장하는 과정을 단순화했습니다.

> **Tip!** 이 레포지토리가 마음에 드셨다면 상단의 **Star ⭐️** 버튼을 눌러주세요! AI와 인간의 협업이 만들어낸 더 멋진 오픈소스 프로젝트를 지속적으로 업데이트하겠습니다.
