# 🎙️ Vonnect AI - Multi-Speaker AI Dubbing Platform

[한국어 버전 (README.md)](./README.md)

---

> **The Ultimate AI Dubbing Solution Powered by AI.**
> Solve complex video dubbing from speaker diarization to voice cloning all at once.

<div align="center">

### 🚀 [See Demo](https://vonnect-ai.vercel.app/)

[![Vercel Deployment](https://img.shields.io/badge/Vercel-Deployed-black?logo=vercel&style=for-the-badge)](https://vonnect-ai.vercel.app/)

---

</div>

## 🔒 Access Notice (Closed Beta)

Currently, this service is operated on a **Whitelist** basis to ensure optimal experience and manage high-quality AI resources (ElevenLabs, OpenAI).

- **How to Experience**: Please leave a **Star ⭐️** on the repository and leave your email address in the [Issues](https://github.com/Jin1370/vonnect_ai/issues) tab. We will register you sequentially. We ask for your kind understanding as this is due to resource limits for real-time voice cloning and automated dubbing engines!

---

## 🌟 Introduction & Key Features

**Vonnect AI** is a premium web platform that goes beyond simple voice synthesis to intelligently distinguish multiple speakers in a video and provide dubbing that preserves each person's uniqueness.

-   **🤖 Intelligent Multi-Speaker Diarization**: Automatically recognizes multiple speakers in a video and separates them into individual segments using ElevenLabs AI.
-   **🎙️ Instant Voice Cloning**: Extracts sample audio from each speaker to generate dubbing with the most similar voice to the original.
-   **✍️ Responsive Translation & Editing (Interactive Re-dub)**: Users can directly check the high-quality translation results from GPT-4o and immediately edit them to re-dub.
-   **🎞️ Crop Range Selection**: Allows users to manually specify the range to crop using a dual-handle slider with a real-time preview for convenience.
-   **📜 Translated Subtitle Option**: Users can choose whether to burn translated subtitles into the video.
-   **▶️ Original Video Playback**: Includes a built-in player to instantly check the original video and compare it with the dubbed result.
-   **⚡ Client-Side Preprocessing**: Optimized for fast processing by handling large files directly in the browser using FFmpeg WASM.
- **📱 Premium Responsive UI**: Provides a sophisticated design and mobile interface.

---

## 🛠 Tech Stack

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

## 🚀 Local Run Method

To run this project locally, follow the steps below.

### 1. Environment Setup (`.env.local`)

Create a `.env.local` file in the root directory and enter the following keys.

```env
TURSO_DATABASE_URL=your_turso_url
TURSO_AUTH_TOKEN=your_turso_token
ELEVENLABS_API_KEY=your_elevenlabs_key
OPENAI_API_KEY=your_openai_key
NEXTAUTH_SECRET=your_nextauth_secret
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=your_google_id
GOOGLE_CLIENT_SECRET=your_google_secret
USE_BASE_VOICE=false # If true, skips cloning and uses base voices to save quota.
```

### 2. Install & Run

```bash
# Install dependencies
npm install

# Database push (Drizzle)
npm run db:push

# Run server
npm run dev
```

Connect to `http://localhost:3000` in your browser.

---

## 🤖 Coding Agent Insights & Best Practices

This project was built by strategically utilizing various state-of-the-art AI models within the **Google Antigravity** platform.

#### 🛠️ AI Model Strategy

| Model                 | Key Responsibility                      | Characteristics                                                               |
| :-------------------- | :-------------------------------------- | :---------------------------------------------------------------------------- |
| **Claude 4.6 Sonnet** | Complex Logic & Backend Implementation  | Exceptional reasoning for deep code analysis and refactoring.                 |
| **Gemini 3.1 Pro**    | Multi-modal Analysis & Deployment Fixes | Massive context handling for complex error resolution and redeployment logic. |
| **Gemini 3 Flash**    | UI Design & Documentation (README)      | High-speed response for simple code edits and text-heavy tasks.               |

#### 💡 Development Workflow Tips

1.  **Antigravity Mode Optimization**:
    - **Planning Mode**: Used for complex tasks requiring architectural design and structured `implementation_plans`.
    - **Fast Mode**: Used for rapid development of simple features or style adjustments.
2.  **Selective Approval Process**: The greatest strength of Google Antigravity is the developer's ability to review every individual code change and **selectively approve only the desired modifications**, ensuring high code quality and absolute ownership.
3.  **Agnostic Model Infrastructure**: Leveraged the flexibility to switch between first-party and third-party models (like Claude) to select the best tool for each specific technical challenge.

> **Tip!** If you liked this project, please press the **Star ⭐️** button at the top! We will continue to update more wonderful open-source projects created by the collaboration of AI and humans.
