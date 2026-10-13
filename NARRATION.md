# Narrated skill recordings (fork feature)

This fork adds **microphone narration** to the Playwriter skill recorder. An
expert records a workflow in their own Chrome, talks through it, and an agent
turns the clicks, screenshots, network events and speech into a reusable skill.

Everything stays on the computer that records. There is no cloud service,
no upload, and transcription is an optional local step.

## Contents

- [For the person recording (no terminal)](#for-the-person-recording-no-terminal)
- [One-time setup (someone technical)](#one-time-setup-someone-technical)
- [Commands](#commands)
- [Output files](#output-files)
- [Timing: how speech lines up with actions](#timing-how-speech-lines-up-with-actions)
- [Transcribing locally](#transcribing-locally)
- [Full example](#full-example)
- [Microphone permission details](#microphone-permission-details)
- [Limitations](#limitations)

## For the person recording (no terminal)

Once the setup below has been done on your computer, recording is three clicks:

1. On the page where the workflow starts, click the Playwriter extension icon
   so it turns green. A small toolbar appears on the page.
2. The first time only: click **Mic off** so it reads **Mic on**. A Playwriter
   tab opens with one button, **Allow microphone**. Click it, accept Chrome's
   prompt, and the tab closes itself. Playwriter remembers this.
3. Click **Record Skill**. The toolbar shows **Mic live** (red, pulsing) and
   the extension icon shows a red **MIC** badge. Do the workflow and say what
   you are doing and why, as if explaining it to a colleague. Mistakes and
   pauses are fine; say "ignore that" and keep going.
4. Made a mistake? Click **Oops**, then redo the step. The agent will skip
   the wrong attempt. The Stop button shows how long you have been recording.
5. Click **Stop recording**. The microphone turns off immediately, a short
   summary appears ("Recorded: 23 events, voice saved"), and a message for
   your AI agent is copied to the clipboard. Paste it into the agent's chat.
   Done.

If the microphone cannot be used (blocked, unplugged, in use by another app),
the recording still happens without audio and the toolbar tells you why.

## Easiest setup: the macOS app

`apps/mac-recorder/dist/Playwriter-Recorder-<version>.zip` (build it with
`apps/mac-recorder/build-app.sh`) is a double-clickable app that needs no
terminal, no Node and no Chrome developer mode. Unzip, drag to Applications,
right-click → Open the first time (it is not notarized). It starts the relay,
downloads its own Chrome on first run, and opens a ready page with the four
steps above. Details and limitations: `apps/mac-recorder/README.md`.

That browser is not your everyday Chrome, so you are logged out of your tools
until you copy your logins over once (macOS, one Keychain prompt):

```bash
playwriter cookies import --from chrome --list-profiles
playwriter cookies import --from chrome --domains github.com,notion.so
```

## Manual setup (someone technical, any Chrome)

The fork is not on the Chrome Web Store, so the extension is loaded unpacked.

```bash
git clone https://github.com/jacobcwright/playwriter.git
cd playwriter
pnpm bootstrap              # submodule, deps, playwright fork build
pnpm --filter playwriter build
cd extension && pnpm build  # writes extension/dist
```

Load it in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/dist` folder.
4. If the Web Store Playwriter extension is also installed, disable it so the
   two do not both try to attach to tabs.

The toolbar and the CLI talk to a local relay on port 19988. Any `playwriter`
command starts it. From this checkout:

```bash
tsx playwriter/src/cli.ts serve start   # or: npm i -g playwriter (upstream CLI, without narration commands)
```

For the narration commands below, run the fork's CLI with
`tsx playwriter/src/cli.ts ...`, or `pnpm --filter playwriter build` and run
`node playwriter/dist/cli.js ...`. The examples write `playwriter` for brevity.

## Commands

```bash
playwriter recorder start --mic        # record actions + microphone (narration is OFF without --mic)
playwriter recorder start              # actions only, unchanged
playwriter recorder status             # shows "mic live" or "mic unavailable (<reason>)"
playwriter recorder stop               # stops; prints the narration audio path and duration
playwriter recorder narration -r <id>  # audio path, audioStartMs, duration, transcript path (JSON)
playwriter recorder transcribe -r <id> # local transcription -> narration.transcript.json
playwriter recorder events -r <id>     # timeline; transcript segments inline as type "narration"
playwriter recorder events --no-transcript
```

`--mic` pre-flights the microphone: if Chrome has not been asked yet, the
permission page opens and the command waits (up to two minutes) for the
answer. A denied or missing microphone prints a warning and the recording
starts anyway, without audio.

The relay HTTP API gained the matching endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /recorder/start` body `{ "microphone": true }` | start with narration; response has `narration: { active, audioPath, audioStartMs, ... }` or `{ active: false, reason, error }` |
| `GET /recorder/microphone` | `{ state: granted \| denied \| prompt \| unavailable, hasMicrophone }` |
| `POST /recorder/microphone` | open the permission page and wait for the answer |
| `GET /recorder/narration/:id` | narration metadata plus transcript, for remote relays |

Video recordings (`recording.start` in the sandbox) accept `microphone: true`
to mix the microphone into the tab capture. `audio: true` alone is unchanged.

## Output files

```
~/.playwriter/recordings/<id>.json                       events: actions, navigations, network, narration lifecycle
~/.playwriter/recordings/<id>/frames/<ms>.jpg            one jpeg per visual change
~/.playwriter/recordings/<id>/narration.webm             microphone audio, opus, 48 kbps mono
~/.playwriter/recordings/<id>/narration.json             audio metadata (below)
~/.playwriter/recordings/<id>/narration.transcript.json  optional, written by `recorder transcribe` or by hand
```

`narration.json`:

```json
{
  "recordingId": "3",
  "source": "microphone",
  "audioPath": "/Users/you/.playwriter/recordings/3/narration.webm",
  "mimeType": "audio/webm;codecs=opus",
  "audioStartMs": 412,
  "durationMs": 95210,
  "sizeBytes": 571904,
  "endReason": "stopped",
  "deviceLabel": "MacBook Pro Microphone",
  "transcriptPath": null
}
```

Events added to the timeline:

| Event | When |
| --- | --- |
| `narration-started` | mic is live: `audioPath`, `audioStartMs`, `mimeType`, `deviceLabel` |
| `narration-unavailable` | mic was requested but could not be used: `reason` (`permission-denied`, `permission-pending`, `no-microphone`, `capture-failed`, `unsupported`) and `error` |
| `narration-stopped` | mic released: `reason` (`stopped`, `device-lost`, `cancelled`, `error`), duration, size |
| `narration` | one transcript segment (`text`, `ms`, `endMs`); only once a transcript exists |
| `marker` | the user pressed **Oops** (`kind: "mistake"`, optional `note`): the actions just before it were a mistake they redid. Also `POST /recorder/mark` |

`recording-stopped.narration` repeats the full metadata so an agent reading
the end of the timeline has everything.

## Timing: how speech lines up with actions

All events share one clock: `ms` since the recording started. The audio file
does not start at 0 (the mic opens a few hundred ms after the recorder), so
`audioStartMs` tells where it begins on that clock:

```
timeline ms = audioStartMs + audio_second * 1000
```

Transcript segments carry seconds relative to the audio file. `recorder
events` applies the offset and interleaves them, so each `narration` event
already has the right `ms` and sits right before the action it describes.

## Transcribing locally

Transcription never happens automatically. When the agent (or you) wants the
text:

```bash
playwriter recorder transcribe -r 3                                    # auto-detects a local tool
playwriter recorder transcribe -r 3 --model ~/models/ggml-base.en.bin  # whisper.cpp
playwriter recorder transcribe -r 3 --command 'my-stt {input} --json-out {output}'
```

Detection order: an explicit `--command`; whisper.cpp (`whisper-cli` or
`whisper-cpp` on PATH plus a model from `--model` or `WHISPER_CPP_MODEL`,
needs `ffmpeg` for the 16 kHz wav conversion); openai-whisper (`whisper` on
PATH, `pip install openai-whisper`). With `--command`, `{input}` is the audio
path and `{output}` is a JSON file your tool must write. Accepted shapes:
`{ "segments": [{ "start", "end", "text" }] }` (canonical, seconds),
whisper.cpp `-oj` output, openai-whisper JSON output, or `{ "text": "..." }`.

You can also write `narration.transcript.json` by hand in the canonical shape.

If no tool is installed the command prints these options and the audio path.
The agent can still listen to the file or ask you for the gist.

## Full example

Expert side, in Chrome: toolbar **Mic on** (once), **Record Skill**, do the
work while talking, **Stop recording**, paste the copied prompt to the agent.

Agent side, the same thing from the CLI:

```bash
$ playwriter recorder start --mic
Chrome needs permission to use the microphone. A Playwriter tab just opened: click "Allow microphone" there.
Recording 3 started on session 1.
Events file: /Users/you/.playwriter/recordings/3.json
Narration: microphone is live (MacBook Pro Microphone). Audio file: /Users/you/.playwriter/recordings/3/narration.webm
Tell the user: talk through what you are doing and why. Click Stop (or say done) when finished.
... (skill-authoring instructions) ...

# the expert submits a product to a directory site and narrates

$ playwriter recorder stop
Recording 3 stopped. 23 events captured.
Events file: /Users/you/.playwriter/recordings/3.json
Narration audio: /Users/you/.playwriter/recordings/3/narration.webm (95s, starts at timeline ms 412)
  Transcribe locally (optional): playwriter recorder transcribe -r 3

$ playwriter recorder transcribe -r 3 --model ~/models/ggml-base.en.bin
Transcript written (whisper-cli, 14 segments): /Users/you/.playwriter/recordings/3/narration.transcript.json

$ playwriter recorder events -r 3 | jq -r '[.id, .t, .type, (.text // .code // .url // empty)] | @tsv'
1    0      recording-started     https://directory.example.com
2    0.4    narration-started     /Users/you/.playwriter/recordings/3/narration.webm
n1   1.1    narration             okay, submitting a product. it's always under Products, then Submit
3    2.1    action                await page.getByRole('link', { name: 'Submit a product' }).click()
4    2.4    navigation            https://directory.example.com/submit
n2   3.2    narration             the name is whatever the product is called, this one's just an example
5    3.8    action                await page.getByRole('textbox', { name: 'Product name' }).fill('[redacted]')
n3   5.0    narration             website URL has to include https or it rejects it silently
6    5.2    action                await page.getByRole('textbox', { name: 'Website URL' }).fill('[redacted]')
n4   6.4    narration             and submit. wait for the green banner, don't click twice
7    7.0    action                await page.getByRole('button', { name: 'Submit' }).click()
8    7.3    network               POST 200 https://directory.example.com/api/products
9    95.6   narration-stopped
10   95.6   recording-stopped
```

The agent then writes `SKILL.md` with `name` and `url` as parameters, an
`https://` check on the URL, and a wait for the confirmation banner, because
the narration said so. The skill-authoring instructions printed by `recorder
start` (see `playwriter/src/recorder-prompt.md`) spell out how to use
narration for step intent, conditions, parameters and dropped mistakes.

## Microphone permission details

- The microphone is a runtime permission, not a manifest permission. Chrome
  shows its normal "Playwriter wants to use your microphone" prompt.
- The capture runs in the extension's offscreen document, which cannot show
  that prompt. That is why a visible page (`extension/src/microphone.html`)
  asks first. All extension pages share one origin, so one answer covers the
  offscreen capture too.
- The answer is per Chrome profile and persists. To revoke: `chrome://settings/content/microphone`,
  or `chrome://extensions` > Playwriter > Details > Site settings.
- While capturing: toolbar **Mic live**, extension badge **MIC**, and Chrome's
  own microphone-in-use indicator. The stream is stopped (tracks ended) when
  the recording stops, is cancelled, the relay disconnects, or the recording
  hits its 20 minute limit.
- Narration is refused over Remote control: a remote agent can never turn on
  the local microphone.
- The microphone is only opened for a recording the user started. Nothing
  listens between recordings.

## Limitations

- **Unpacked install.** The fork's extension must be loaded in developer mode
  (steps above); it will not auto-update. Someone technical does this once per
  machine.
- **Relay must be running.** The toolbar's Record Skill needs the local relay
  (started by any `playwriter` command). If it is not, the toolbar says
  "Relay not connected".
- **Mic-only for the skill recorder.** Skill recordings span tabs, and
  `chrome.tabCapture` captures one tab, so narration does not include page
  audio. Mixed microphone + tab audio exists for `recording.start` video
  recordings (`audio: true, microphone: true`).
- **Chunk granularity.** MediaRecorder emits data about once per second; the
  last fraction of a second before Stop can be missing.
- **Timing precision** is tens of milliseconds (two clocks on one machine).
  Good enough to pair sentences with clicks, not for lip sync.
- **Relay restart mid-recording** ends the narration with
  `endReason: "error"`; the audio captured so far is kept.
- **No transcription built in.** `recorder transcribe` needs a local tool
  (whisper.cpp or openai-whisper) or a `--command`.
- **Not tested with a real microphone in this fork's CI.** The automated test
  runs Chrome with a fake audio device and an auto-accepted prompt; it covers
  permission state, the offscreen capture, chunk transport, file output,
  timeline events and mic release, but not the real OS/Chrome prompts.
