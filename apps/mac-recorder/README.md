# Playwriter Recorder.app (macOS)

A double-clickable launcher for the fork's narrated skill recorder, for people
who should never see a terminal: internal staff, contractors, clients.

Opening the app:

1. starts the local Playwriter relay (`127.0.0.1:19988`) if it is not running,
2. downloads Chrome for Testing into `~/.playwriter/browsers/` the first time,
3. opens Chrome for Testing with the fork's extension preloaded and a
   persistent profile, on a short "ready" page.

The in-browser toolbar (Record Skill / Mic) is the whole UI. The app is only a
launcher; opening it again while the browser is running just opens the ready
page in a new tab of the existing window.

## Build

```bash
# from the repo root
cd extension && pnpm build && cd ..        # only if extension/dist is missing
apps/mac-recorder/build-app.sh             # --rebuild-extension to force a rebuild
                                           # --no-binary for a development-mode app
```

Output:

```
apps/mac-recorder/dist/Playwriter Recorder.app
apps/mac-recorder/dist/Playwriter-Recorder-<version>.zip
```

The build copies `extension/dist` into `Contents/Resources/extension` and, when
`playwriter/dist-bin/playwriter-recorder` (the single-file CLI + relay) exists,
copies it into `Contents/Resources/bin/`. Without that binary the app runs in
development mode: it executes `tsx <repo>/playwriter/src/cli.ts`, resolving
`<repo>` from `$PLAYWRITER_REPO`, then `Contents/Resources/dev-repo-path`
(written at build time), then `~/playwriter`, `~/dev/playwriter`,
`~/dev/work/playwriter`, `~/code/playwriter`. Development mode needs Node.js on
the Mac (found via PATH, `/opt/homebrew/bin`, `/usr/local/bin`, fnm, nvm, volta
or `$PLAYWRITER_NODE_BIN`).

Bundle layout:

```
Contents/Info.plist                       com.playwriter.recorder, NSMicrophoneUsageDescription
Contents/MacOS/launcher                   bash (src/launcher.sh)
Contents/Resources/lib/common.sh          shared helpers
Contents/Resources/extension/             the fork's extension
Contents/Resources/bin/playwriter-recorder  CLI + relay binary (optional)
Contents/Resources/ready.html             page shown on launch
Contents/Resources/install-relay-agent.sh / uninstall-relay-agent.sh
Contents/Resources/icon.icns
```

Sources live in `src/`; `dist/` is build output and git-ignored.

## Install (for the person receiving the zip)

1. Unzip `Playwriter-Recorder-<version>.zip`.
2. Drag `Playwriter Recorder.app` to `Applications` (or anywhere).
3. The first time, **right-click the app > Open > Open**. Double-clicking
   shows "cannot be opened because the developer cannot be verified" because
   the app is not signed with an Apple Developer ID (see Limitations). On
   macOS 15 and later the right-click route may still refuse; then open
   **System Settings > Privacy & Security**, scroll down and click **Open
   Anyway** next to the Playwriter Recorder message, and open the app again.
   Someone technical can skip all of this with
   `xattr -dr com.apple.quarantine "/Applications/Playwriter Recorder.app"`.

## First run

- A notification says Chrome for Testing is being downloaded (about 200 MB).
  Chrome for Testing opens by itself when the download finishes, on the ready
  page. Later launches are immediate.
- Follow the four steps on the ready page: click the Playwriter icon on the
  tab to record, **Mic off > Mic on**, **Record Skill**, **Stop recording**.
- Turning the mic on the first time shows two prompts: Chrome's own
  "Playwriter wants to use your microphone" (per browser profile, remembered)
  and the macOS microphone prompt. The macOS prompt is attributed to the
  process that owns the browser: Chrome for Testing has its own bundle and
  `NSMicrophoneUsageDescription`, and the app carries one too because the
  browser is launched as a child of the app. Either way, click **Allow**. To
  change it later: System Settings > Privacy & Security > Microphone.
- The app shows every error in a dialog (relay failed to start, download
  failed, extension did not connect) with a **Show Log** button.
- If the extension has not reached the relay 20 seconds after the browser
  opened, the launcher restarts the relay once and waits again before showing
  an error. This was seen once on a very first run (see Limitations).

## Where files go

| What | Where |
| --- | --- |
| Recordings (timeline, screenshots, `narration.webm`) | `~/.playwriter/recordings/<id>/` (see NARRATION.md) |
| Browser profile (logins, mic permission) | `~/Library/Application Support/Playwriter Recorder/profile/` |
| Chrome for Testing | `~/.playwriter/browsers/chrome-<version>/` |
| Launcher log | `~/Library/Application Support/Playwriter Recorder/launcher.log` |
| Relay log (stdout) | `~/Library/Application Support/Playwriter Recorder/relay.log` |
| Relay log (file logger) | `~/.playwriter/relay-server.log` |

`~/.playwriter` is hidden in Finder: Cmd+Shift+G, then `~/.playwriter/recordings`.

## Keeping the relay alive at login (optional)

The toolbar's Record Skill needs the relay. Opening the app starts it, but if
someone wants it up at login without opening the app:

```bash
open -a "Playwriter Recorder" --args --install-login-item
# or
"/Applications/Playwriter Recorder.app/Contents/Resources/install-relay-agent.sh"
```

This writes `~/Library/LaunchAgents/com.playwriter.recorder.relay.plist`
(RunAtLoad + KeepAlive, running `playwriter-recorder serve --host 127.0.0.1
--replace`, logging to `~/Library/Application Support/Playwriter
Recorder/relay-agent.log`) and loads it. Remove it with
`--uninstall-login-item` or `uninstall-relay-agent.sh`. The plist records the
app's path, so re-run the installer after moving the app.

## Limitations

- **Unsigned.** There is no Apple code-signing identity on the build machine,
  so the app is ad-hoc signed (`codesign --sign -`). That keeps macOS from
  reporting it as damaged, but Gatekeeper still flags it as from an
  unidentified developer (see Install). Proper signing and notarization need
  an Apple Developer account (Developer ID certificate + `notarytool`).
- **Not the user's everyday Chrome.** Recording happens in Chrome for Testing
  with its own profile, so sites need a sign-in once. An "Import logins"
  command is coming separately.
- **Mac only today.** Apple Silicon and Intel are both supported by Chrome for
  Testing, but the bundled CLI binary is built for the architecture of the
  build machine (arm64 here).
- The launcher mirrors the Chrome flags from `playwriter/src/browser-launch.ts`
  (`getBrowserLaunchArgs`) instead of calling `playwriter browser start`,
  because `browser start` cannot open a URL and would add an `about:blank`
  tab on every launch. Keep the two in sync when the flags change.
- The app quits as soon as the browser is up (it is a launcher); the relay and
  the browser keep running. To stop everything: quit Chrome for Testing and
  run `lsof -ti :19988 | xargs kill` (or uninstall the login item).
- Chrome for Testing is pinned to the version `playwriter browser install`
  downloads (latest Stable at first run); it does not auto-update.
- Observed once, on the very first run on a machine (fresh profile, fresh
  Chrome download, Bun-built `playwriter-recorder` relay): the extension's
  startup probe (`HEAD http://127.0.0.1:19988`) timed out inside Chrome for
  minutes while `GET` requests and `curl -I` to the same relay process
  succeeded; killing that relay process fixed it and it did not reproduce
  afterwards. The launcher's one-time relay restart covers this; if the
  toolbar still says "Relay not connected", quit the browser and open the app
  again.
- If the relay goes away while the browser sits idle, the extension's
  service worker can be suspended by Chrome and only reconnects on the next
  tab activity (navigate, click the icon). Opening the app again also works.
