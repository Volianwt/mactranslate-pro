# Architecture and tradeoffs

## Live path

1. `useMicrophone` obtains the selected browser audio input.
2. `useSpeechRecognition` creates an AudioContext and PCM capture worklet. It targets 16 kHz and sends the actual context sample rate to the server.
3. The browser sends audio through `/api/ws` to the local Express process.
4. `asr-engines.ts` adapts Azure, Qwen, or Soniox recognition events.
5. The server merges nearby speech fragments, maintains context, and requests correction and translation from OpenAI.
6. `App.tsx` updates interim and final messages. Display updates are throttled separately from the recognition pipeline.

English source messages use the left panel; Chinese source messages use the right. Final corrected text can be displayed as a difference from the original recognition, rather than silently replacing it.

## Decisions I kept explicit

**Provider timing belongs to the provider.** Endpointing differs between ASR services. The merge, incomplete-utterance, debounce, and commit settings are separate for Azure, Qwen, and Soniox.

**A responsive interface does not imply a final translation.** Partial results can change. The panel distinguishes translation in progress, and the text export retains that label.

**Scrolling should respect review.** The panel follows incoming content while it is near the bottom. Scrolling up suspends that automatic following so earlier text can be read.

**The sample has a separate entry point.** `/demo` is selected before the live app mounts. It uses fixed fictional messages and the shared panels, with pronunciation disabled. It never mounts the microphone or speech-recognition hooks. It is useful for checking layout and export behavior, but does not demonstrate ASR quality, latency, or recovery.

**Export reads the current state.** Exporting merges copies of the two panel arrays by creation time; it does not modify them, reset the session, or call the server. Original and corrected text remain separate. Only the entries currently retained in the UI are included.

## Boundaries

The server binds to localhost. There is no authentication or tenant isolation. Reconnection and session recording are designed around local use, not concurrent remote users.

Credentials are loaded by the server from `.env`; they are not bundled into the frontend. Live audio and text still cross the relevant cloud-provider boundaries. Local session files are an additional copy of the conversation, not a substitute for understanding the providers' own data handling.

## Remaining work

I would want provider-aware health checks, repeatable live-audio fixtures, and measured interruption/recovery tests before making broader reliability claims. Those changes need independent validation because they touch the streaming behavior.
