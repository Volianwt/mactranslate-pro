# MacTranslate Pro

MacTranslate Pro is a local real-time English and Chinese interpretation app. It captures microphone audio in the browser, streams PCM audio to an Express server, runs speech recognition through a selectable ASR provider, translates the result with OpenAI, and sends live transcripts back to the React UI.

## Features

- Real-time bilingual English and Chinese transcription.
- Switchable ASR providers:
  - Azure Speech, the stable default.
  - Qwen3-ASR through DashScope, optional experimental provider.
  - Soniox Realtime, optional experimental provider.
- OpenAI-based transcript correction and translation.
- Live partial transcription and final translated message panels.
- Click-to-pronounce English words with dictionary lookup and TTS fallback.
- Microphone and audio output device selection.
- Local session timing and daily usage tracking in the browser.

## Tech Stack

- React 19
- Vite 6
- Express 4
- TypeScript
- WebSocket audio streaming
- Azure Speech SDK, OpenAI SDK, DashScope, and Soniox integrations

## Requirements

- Node.js 20 or newer.
- npm.
- A browser with microphone permissions enabled.
- API credentials for the providers you plan to use.

## Setup

Install dependencies:

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Fill in `.env` with your own credentials. Do not commit `.env`.

Required variables:

| Variable | Purpose |
| --- | --- |
| `AZURE_SPEECH_KEY` | Azure Speech recognition key. |
| `AZURE_SPEECH_REGION` | Azure Speech region, such as `eastus`. |
| `OPENAI_API_KEY` | OpenAI key for correction, translation, and optional TTS fallback. |

Optional variables:

| Variable | Purpose |
| --- | --- |
| `DASHSCOPE_API_KEY` | Enables Qwen3-ASR. |
| `DASHSCOPE_REGION` | Optional DashScope region override. |
| `SONIOX_API_KEY` | Enables Soniox Realtime. |
| `SONIOX_WS_URL` | Optional Soniox WebSocket endpoint override. |
| `MW_MEDICAL_API_KEY` | Optional Merriam-Webster Medical Dictionary key. |
| `MW_COLLEGIATE_API_KEY` | Optional Merriam-Webster Collegiate Dictionary key. |
| `AZURE_TTS_VOICE` | Optional Azure TTS voice for pronunciation fallback. |
| `OPENAI_TTS_MODEL` | Optional OpenAI TTS model for pronunciation fallback. |
| `OPENAI_TTS_VOICE` | Optional OpenAI TTS voice for pronunciation fallback. |

## Development

Start the local dev server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Build for production:

```bash
npm run build
```

Run the production server:

```bash
npm run start
```

On macOS, you can also run:

```bash
./Start.command
```

## Project Structure

```text
.
├── server.ts                 # Express server, WebSocket handling, ASR, translation, and TTS APIs
├── asr-engines.ts            # ASR provider implementations
├── src/
│   ├── App.tsx               # Main React application
│   ├── components/           # UI components
│   ├── hooks/                # Microphone and speech hooks
│   ├── services/             # Browser-side helper services
│   └── worklets/             # Audio worklet for PCM capture
├── .env.example              # Safe environment template
├── package.json
└── vite.config.ts
```

## Security Notes

The repository intentionally excludes local secrets, generated logs, cached pronunciation audio, transcripts, dependencies, and build output. The following paths are ignored by Git:

- `.env`
- `.env.*`
- `logs/`
- `node_modules/`
- `dist/`
- `.claude/`
- local editor and OS metadata

If a real API key was ever committed by mistake, revoke it in the provider dashboard and generate a new key.

## Available Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local Express and Vite dev server. |
| `npm run build` | Build the React client. |
| `npm run start` | Start the production server. |
| `npm run preview` | Preview the Vite build. |
| `npm run clean` | Remove `dist/`. |
| `npm run lint` | Type-check the project with TypeScript. |
