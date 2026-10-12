# Verification

## Automated checks

```bash
npm run lint
npm test
npm run build
```

The export tests exercise mixed-language ordering, non-mutation of the source arrays, corrected and original text, incomplete translations, fictional-sample labels, and repeated IDs on opposite language panels.

These checks do not make a claim about microphone capture, ASR accuracy, translation accuracy, or cloud-service availability.

## Offline sample

Run `npm run demo`, then open `/demo`.

- Both language directions are labeled, and all six fictional entries appear.
- Replay reveals the entries in order. Pause holds the current position; Continue resumes it.
- Show all stops playback and restores the six entries.
- Export sample downloads readable UTF-8 text with a fictional-sample heading.
- English words have no pronunciation interaction in this mode.
- Browser network inspection shows no `/api/` calls or speech-service connections. No microphone permission is requested.
- At narrow widths, the panels stack and the toolbar remains usable without horizontal scrolling.

## Live session

These checks require credentials and a working microphone. The offline sample cannot substitute for them.

1. Start the Express server, open `/`, and confirm the selected provider and microphone.
2. Speak in English, then Chinese. Confirm the original text and translated text appear on the expected sides.
3. Read an earlier entry while new speech arrives; check that the panel does not force the scroll position down.
4. Click an English word and verify pronunciation output and volume.
5. Stop the session, export it, and compare the file with both panels.
6. Change ASR provider, start again, and verify that the intended provider is active.
7. Test interruption and recovery with a non-sensitive conversation. Check that reconnects do not duplicate committed entries.

I keep this checklist separate from the sample because network timing, provider endpointing, and audio-device behavior need to be observed in a real session.
