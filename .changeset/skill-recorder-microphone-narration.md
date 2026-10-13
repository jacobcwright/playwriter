---
'playwriter': minor
---

Skill recorder: optional microphone narration. Turn the toolbar **Mic** on (or run `playwriter recorder start --mic`) to record what you say while you demonstrate a workflow. Chrome asks for the microphone once on a visible Playwriter page; the toolbar shows **Mic live** and the extension badge shows **MIC** while capturing. Audio is saved locally as `~/.playwriter/recordings/<id>/narration.webm` with timing metadata that aligns it to the event timeline. New commands: `playwriter recorder narration` and `playwriter recorder transcribe` (local-only, uses whisper.cpp, openai-whisper, or any `--command`); transcripts appear inline in `recorder events`. `recording.start` gains `microphone: true` to mix the microphone into tab video recordings. Off by default; a denied or missing microphone never cancels the recording; nothing is uploaded.
