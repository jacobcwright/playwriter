---
'playwriter': minor
---

New `playwriter cookies import --from chrome` copies your logins from your everyday Google Chrome into the Playwriter browser (`playwriter browser start`), which has its own profile and starts logged out. Pick a profile with `--profile <dir, name or email>` (`--list-profiles` shows them), scope with `--domains github.com,notion.so` (subdomains included) or pass `--all`; without either it prints a per-domain count and stops. `--dry-run` decrypts and prints the summary without touching the browser. Reads a copy of Chrome's cookie database with the system `sqlite3`, takes the decryption key from the macOS Keychain (one "Chrome Safe Storage" prompt), skips expired cookies, and injects in batches of 200 into the active session (creating one if none exists). Cookie values are never written to logs or files and only ever travel to the local relay on 127.0.0.1. macOS only for now; Windows and Linux print a clear not-supported error.
