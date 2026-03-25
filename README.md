# Vonnect AI - Multi-Speaker AI Dubbing Platform

Vonnect AI is a premium web application that provides automated AI dubbing with speaker diarization, client-side media cropping, and an interactive re-dubbing workflow.

## Key Features

- **Automated AI Dubbing**: Powered by ElevenLabs and OpenAI GPT-4o.
- **Multi-Speaker Support**: Automatically identifies and clones different speakers using ElevenLabs Diarization.
- **Interactive Re-dubbing**: Review and edit translations at the segment level and regenerate dubbed audio without re-cloning voices.
- **Client-Side Cropping**: Handles long media files by automatically cropping them to the first minute using FFmpeg WASM before uploading.
- **Premium UI/UX**: Professional Indigo-themed design with Heroicons and smooth micro-animations.
- **Mobile Responsive**: Fully optimized layout for desktop and mobile devices.

## Tech Stack

- **Frontend**: Next.js (App Router), TailwindCSS, Heroicons.
- **Backend**: Next.js API Routes, Turso (SQLite), Drizzle ORM.
- **AI/ML**: ElevenLabs API (TTS, STT, Voice Cloning), OpenAI API (Translation).
- **Media Processing**: FFmpeg (WASM on client, fluent-ffmpeg on server).
- **Auth**: NextAuth.js (Google Provider).

## Getting Started

### Prerequisites

Create a `.env.local` file with the following keys:

```env
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
ELEVENLABS_API_KEY=
OPENAI_API_KEY=
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the development server:
   ```bash
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000) to see the result.

## Deployment

Deploy easily on [Vercel](https://vercel.com).
Ensure `SharedArrayBuffer` support by adding COOP/COEP headers in `next.config.ts` (already included in the repo).
