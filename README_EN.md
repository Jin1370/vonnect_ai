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

- **🤖 Intelligent Multi-Speaker Diarization**: Automatically recognizes multiple speakers in a video and separates them into individual segments using ElevenLabs AI.
- **🎙️ Instant Voice Cloning**: Extracts sample audio from each speaker to generate dubbing with the most similar voice to the original.
- **✍️ Responsive Translation & Editing (Interactive Re-dub)**: Users can directly check the high-quality translation results from GPT-4o and immediately edit them to re-dub.
- **⚡ Client-Side Preprocessing**: Handles large files by instantly cropping them to around 1 minute in the browser using FFmpeg WASM for fast processing.
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

## 🤖 Coding Agent Usage & Know-how

This project was completed in a short time through collaboration with a **High-Performance AI Coding Agent (Antigravity)**. We share the know-how gained from developing together with AI.

1.  **Purpose-Oriented Pair Programming**: It provided the most powerful solutions when **specific technical problems** were defined for the AI, rather than just leaving the code to it.
2.  **Repetitive UI Refinement**: The AI perfectly transformed abstract design requests like "apply a sophisticated theme and Glassmorphism" into CSS variables and Utility Classes, maximizing productivity.
3.  **Acceleration of Debugging**: In case of WASM memory issues or log analysis, the AI shortened development time by more than 70% by analyzing thousands of lines of logs in real-time to pinpoint the cause.
4.  **Global Localization**: Simplified the process of expanding to a global project by perfectly localizing interaction messages into English through AI.

> **Tip!** If you liked this repository, please press the **Star ⭐️** button at the top! We will continue to update more wonderful open-source projects created by the collaboration of AI and humans.
