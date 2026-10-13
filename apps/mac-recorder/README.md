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
`src/entitlements.plist` is only used at signing time (see below).

## Signing and notarizing

Without any configuration the build is **ad-hoc signed** (`codesign --sign -`):
it runs, but Gatekeeper treats it as from an unidentified developer and every
recipient has to go through the "Open Anyway" dance (see Install). With an
Apple Developer Program membership the same script signs with a Developer ID
and notarizes, and recipients just double-click. Both are controlled by
environment variables; the script fails before building anything if they are
set but unusable.

### One-time setup

1. **Developer ID Application certificate.** In Xcode: **Settings > Accounts**,
   select your Apple ID and team, **Manage Certificates...**, click **+** and
   choose **Developer ID Application**. The certificate and its private key
   land in your login keychain. Check with:

   ```bash
   security find-identity -v -p codesigning
   #  1) ABCDEF... "Developer ID Application: Your Name (TEAMID1234)"
   ```

   Use that quoted string, exactly, as the identity below.

2. **Notarization credentials.** Create an app-specific password at
   <https://account.apple.com> (Sign-In and Security > App-Specific
   Passwords), then store it once in the keychain under a profile name:

   ```bash
   xcrun notarytool store-credentials playwriter \
     --apple-id you@example.com --team-id TEAMID1234 --password <app-specific password>
   ```

### Building a signed, notarized app

```bash
PLAYWRITER_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID1234)" \
PLAYWRITER_NOTARY_PROFILE=playwriter \
apps/mac-recorder/build-app.sh
```

The script then:

1. signs inner-first with the hardened runtime and a secure timestamp
   (needs network): `Contents/Resources/bin/playwriter-recorder` with
   `src/entitlements.plist` (the Bun-compiled CLI needs
   `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory` and
   `disable-executable-page-protection`), then any other Mach-O file in the
   bundle, then the `.app`;
2. verifies with `codesign --verify --deep --strict` and prints the
   `spctl --assess --type execute` verdict (before notarization that is
   "rejected, Unnotarized Developer ID", which is expected);
3. zips the app with `ditto -c -k --keepParent`, submits it with
   `xcrun notarytool submit --wait` (a few minutes), and on success staples
   the ticket with `xcrun stapler staple` and re-checks `spctl`. On failure
   it prints `notarytool log` for the submission and exits non-zero;
4. writes the stapled app and the distributable zip to `dist/`.

Instead of a keychain profile you can pass the credentials inline with
`PLAYWRITER_NOTARY_APPLE_ID`, `PLAYWRITER_NOTARY_PASSWORD` (app-specific
password) and `PLAYWRITER_NOTARY_TEAM_ID`, all three together. Setting
`PLAYWRITER_SIGN_IDENTITY` alone signs without notarizing, which is only
useful for testing the signature: for recipients it is no better than ad-hoc.

### What recipients see

| Build | Double-click on macOS 14/15 |
| --- | --- |
| Ad-hoc (default) | "Apple could not verify ... is free of malware". Right-click > Open may work on macOS 14; on macOS 15 they must go to **System Settings > Privacy & Security** and click **Open Anyway**, then open the app again. |
| Developer ID, not notarized | Same as ad-hoc, with the developer's name in the message. |
| Developer ID + notarized + stapled | Opens. Nothing to click. |

The app only needs to be opened this way once; later launches are normal.
Signing does not change what the app does: Chrome for Testing is still
downloaded unsigned by Google's own process and asks for the microphone itself.

## Releasing

`dist/Playwriter-Recorder-<version>.zip` is the file to hand out, where
`<version>` comes from `playwriter/package.json`. To publish it as a GitHub
release of this fork:

```bash
VERSION=$(node -p "require('./playwriter/package.json').version")
gh release create "recorder-app@$VERSION" "apps/mac-recorder/dist/Playwriter-Recorder-$VERSION.zip" \
  --repo jacobcwright/playwriter \
  --title "Playwriter Recorder $VERSION (macOS)" \
  --notes "Double-clickable macOS launcher for the narrated skill recorder. Unzip, drag to Applications, open."
```

Recipients then download it from the release page, or from the stable URL

```
https://github.com/jacobcwright/playwriter/releases/latest/download/Playwriter-Recorder-<version>.zip
```

Caveat: `releases/latest/download/` only resolves to the release GitHub
marks as **Latest**, which is the most recent non-prerelease, non-draft
release in the whole repo, not just the `recorder-app@*` tags. If another
kind of release is published later, that URL stops pointing at the recorder;
link to the specific release
(`releases/download/recorder-app@<version>/Playwriter-Recorder-<version>.zip`)
when it must not move, or pass `--latest` to `gh release create` to force it.
A notarized build inside a zip keeps its stapled ticket; do not re-zip it
with Finder's "Compress" (use the zip the build produced).

## Install (for the person receiving the zip)

1. Unzip `Playwriter-Recorder-<version>.zip`.
2. Drag `Playwriter Recorder.app` to `Applications` (or anywhere).
3. **Notarized build:** double-click it. **Ad-hoc build** (the default when no
   signing identity is configured, see Signing and notarizing): the first time,
   **right-click the app > Open > Open**. Double-clicking shows "cannot be
   opened because the developer cannot be verified" because the app is not
   signed with an Apple Developer ID. On macOS 15 and later the right-click
   route may still refuse; then open **System Settings > Privacy & Security**,
   scroll down and click **Open Anyway** next to the Playwriter Recorder
   message, and open the app again. Someone technical can skip all of this
   with `xattr -dr com.apple.quarantine "/Applications/Playwriter Recorder.app"`.

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
- Once the browser is up, the app asks once: **Copy your logins from Chrome
  into Playwriter Recorder?** with **Not now** / **Copy logins**. Copy logins
  imports every current login (cookie) from the everyday Chrome's Default
  profile into this browser, so sites do not need a fresh sign-in. macOS shows
  one Keychain prompt ("security wants to access Chrome Safe Storage"): click
  **Always Allow**. A dialog then reports "Imported N cookies..." or the error.
  See Copying logins from Chrome.
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

## Copying logins from Chrome

Recording happens in Chrome for Testing with its own profile, so the
launcher offers, once, to copy the user's logins over. It runs the fork's
`playwriter cookies import --from chrome --profile Default --all` (the
bundled binary, or the tsx fallback in development mode) through the relay
into the running browser, logs the command and its full output to
`launcher.log`, and shows the summary line in a dialog. Nothing leaves the
Mac: the cookies are read from Chrome's database on disk, decrypted with the
key from the login Keychain, and handed to the local relay on 127.0.0.1.

- **Asked once.** The question is asked on the first launch after the
  extension connects, and `~/Library/Application Support/Playwriter
  Recorder/logins-offered` is written whichever button is clicked (and even if
  the import then fails). Delete that file to be asked again on the next
  launch.
- **Run it again** (new sign-ins in Chrome, or they clicked Not now):

  ```bash
  open -a "Playwriter Recorder" --args --import-logins
  ```

  This does the normal launch and then imports without asking. Someone
  technical can also run the CLI directly:
  `"/Applications/Playwriter Recorder.app/Contents/Resources/bin/playwriter-recorder" cookies import --from chrome --all`
  (add `--list-profiles` to see profiles, `--profile <name>` to pick one,
  `--domains a.com,b.com` to limit).
- **Default profile only.** The launcher always imports Chrome's `Default`
  profile. If the person uses a different Chrome profile (several Google
  accounts in Chrome), their logins are in another directory (`Profile 1`,
  ...), and the app's offer copies the wrong set. There is no picker in the
  app; use the CLI with `--profile` for them, or have them sign in by hand.
- **Cookies only.** Logins kept in local storage, IndexedDB or passkeys are
  not copied; those sites need one sign-in in the recorder browser.
- **Test hooks** (for automated checks; no dialogs, no screen needed):
  `PLAYWRITER_RECORDER_AUTOANSWER=copy` or `=skip` answers the question
  without showing it, replaces the result dialog with a log line, and runs
  the import with `--dry-run` (decrypts and lists, sends nothing to the
  browser). `--dry-run` still reads the Chrome Safe Storage key, so a
  Keychain prompt can still appear with `copy`. Example:

  ```bash
  rm -f ~/Library/Application\ Support/Playwriter\ Recorder/logins-offered
  PLAYWRITER_RECORDER_AUTOANSWER=skip open -a "Playwriter Recorder"
  # launcher.log: "Logins: PLAYWRITER_RECORDER_AUTOANSWER=skip ..." and the marker exists
  ```

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

- **Ad-hoc signed unless configured.** Without `PLAYWRITER_SIGN_IDENTITY` the
  app is ad-hoc signed (`codesign --sign -`). That keeps macOS from reporting
  it as damaged, but Gatekeeper still flags it as from an unidentified
  developer (see Install). Developer ID signing and notarization are built
  into `build-app.sh` (see Signing and notarizing) but need an Apple Developer
  account; that path has not been exercised on a machine with a certificate
  yet.
- **Not the user's everyday Chrome.** Recording happens in Chrome for Testing
  with its own profile. The first-launch offer copies cookies from Chrome's
  Default profile only (see Copying logins from Chrome); other profiles and
  non-cookie logins still need a sign-in once.
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
