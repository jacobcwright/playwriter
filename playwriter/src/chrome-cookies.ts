// Import logins from the user's everyday Google Chrome into a Playwriter session.
//
// Chrome keeps cookies in a SQLite file inside each profile and encrypts the
// values with a per-user key (on macOS the key lives in the login Keychain as
// "Chrome Safe Storage"). This module locates profiles, copies the locked
// database to a temp dir, reads it with the sqlite3 CLI (no native module),
// decrypts the values and maps them to Playwright cookie objects.
//
// Cookie values never touch the log or any file: the only place they go is the
// local relay on 127.0.0.1, and only after the user opted in.
//
// macOS is implemented. Windows and Linux keep the same structure (user data
// dir lookup, key derivation) but throw a clear "not supported yet" error.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type SupportedPlatform = 'darwin' | 'win32' | 'linux'

export interface ChromeProfileInfo {
  /** Directory name inside the user data dir, e.g. "Default" or "Profile 1" */
  dir: string
  /** Display name chosen by the user, e.g. "Work" */
  name: string
  /** Google account email when signed in */
  email: string
  /** Absolute path to the Cookies SQLite file, or null when the profile has none */
  cookiesPath: string | null
}

export interface ChromeCookieRow {
  host_key: string
  name: string
  path: string
  /** hex(encrypted_value): the sqlite3 json mode mangles raw blobs, so we read hex */
  encrypted_value_hex: string
  value: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
  has_expires: number
}

export type PlaywrightSameSite = 'Strict' | 'Lax' | 'None'

export interface PlaywrightCookie {
  name: string
  value: string
  domain: string
  path: string
  /** Unix seconds, or -1 for a session cookie */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: PlaywrightSameSite
}

export interface CookieConversionSummary {
  cookies: PlaywrightCookie[]
  /** Rows dropped because expires_utc is in the past */
  expired: number
  /** Rows dropped because the domain filter excluded them */
  filteredOut: number
  /** Rows whose value could not be decrypted (wrong key, unknown version, corrupt blob) */
  undecryptable: number
}

const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600
const CHROME_ENCRYPTION_PREFIX = 'v10'
const CHROME_AES_IV = Buffer.alloc(16, 0x20)
const CHROME_PBKDF2_SALT = 'saltysalt'
const CHROME_HOST_HASH_LENGTH = 32
/** Default sqlite3 CLI path by platform; falls back to PATH lookup. */
const SQLITE3_DEFAULT_PATHS: Record<SupportedPlatform, string> = {
  darwin: '/usr/bin/sqlite3',
  linux: 'sqlite3',
  win32: 'sqlite3.exe',
}

export function getChromeUserDataDir(options: {
  platform?: NodeJS.Platform
  homeDir?: string
  env?: NodeJS.ProcessEnv
} = {}): string {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local')
    return path.join(localAppData, 'Google', 'Chrome', 'User Data')
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'google-chrome')
}

export function assertCookieImportSupported(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') {
    return
  }
  const name = platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform
  throw new Error(
    `Importing Chrome cookies is not supported yet on ${name}. Only macOS is implemented for now.`,
  )
}

/** Chrome moved the cookie database into a Network/ subfolder in v96, but profiles created earlier keep the old location. */
export function findChromeCookiesPath({
  userDataDir,
  profileDir,
  existsSync = fs.existsSync,
}: {
  userDataDir: string
  profileDir: string
  existsSync?: (filePath: string) => boolean
}): string | null {
  const candidates = [
    path.join(userDataDir, profileDir, 'Network', 'Cookies'),
    path.join(userDataDir, profileDir, 'Cookies'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Reads `Local State` to map profile directories to display names and emails. Profiles missing from it but having a Cookies file are still listed. */
export function listChromeProfiles({ userDataDir }: { userDataDir: string }): ChromeProfileInfo[] {
  if (!fs.existsSync(userDataDir)) {
    return []
  }
  const infoCache = (() => {
    try {
      const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf-8')) as {
        profile?: { info_cache?: Record<string, { name?: string; user_name?: string; gaia_name?: string }> }
      }
      return localState.profile?.info_cache ?? {}
    } catch {
      return {}
    }
  })()

  const dirs = new Set<string>(Object.keys(infoCache))
  for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name))) {
      dirs.add(entry.name)
    }
  }

  return [...dirs]
    .sort((a, b) => {
      if (a === 'Default') return -1
      if (b === 'Default') return 1
      return a.localeCompare(b, undefined, { numeric: true })
    })
    .map((dir) => {
      const info = infoCache[dir] ?? {}
      return {
        dir,
        name: info.name ?? '',
        email: info.user_name ?? '',
        cookiesPath: findChromeCookiesPath({ userDataDir, profileDir: dir }),
      }
    })
}

/** Accepts a directory name ("Profile 1"), a display name ("Work") or an email, case-insensitively. */
export function resolveChromeProfile({
  profiles,
  profile,
}: {
  profiles: ChromeProfileInfo[]
  profile: string
}): ChromeProfileInfo | null {
  const wanted = profile.trim().toLowerCase()
  const byDir = profiles.find((p) => p.dir.toLowerCase() === wanted)
  if (byDir) {
    return byDir
  }
  return profiles.find((p) => p.name.toLowerCase() === wanted || p.email.toLowerCase() === wanted) ?? null
}

export function getSqlite3Path(platform: NodeJS.Platform = process.platform): string {
  const configured = process.env.PLAYWRITER_SQLITE3_PATH
  if (configured) {
    return configured
  }
  if (platform === 'darwin' && !fs.existsSync(SQLITE3_DEFAULT_PATHS.darwin)) {
    return 'sqlite3'
  }
  return SQLITE3_DEFAULT_PATHS[platform as SupportedPlatform] ?? 'sqlite3'
}

const COOKIE_SELECT_SQL =
  'SELECT host_key, name, path, hex(encrypted_value) AS encrypted_value_hex, value, expires_utc, ' +
  'is_secure, is_httponly, samesite, has_expires FROM cookies'

/**
 * Copies the Cookies database to a temp dir (Chrome holds a lock on the live
 * file) and reads every row through the sqlite3 CLI in JSON mode. The copy is
 * removed before returning, success or failure.
 */
export async function readChromeCookieRows({
  cookiesPath,
  sqlite3Path = getSqlite3Path(),
}: {
  cookiesPath: string
  sqlite3Path?: string
}): Promise<ChromeCookieRow[]> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playwriter-chrome-cookies-'))
  try {
    const copyPath = path.join(tempDir, 'Cookies')
    fs.copyFileSync(cookiesPath, copyPath)
    // Chrome may leave a rollback journal or WAL next to the database. Copying
    // them keeps the snapshot consistent; missing ones are simply skipped.
    for (const suffix of ['-journal', '-wal']) {
      const sidecar = `${cookiesPath}${suffix}`
      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${copyPath}${suffix}`)
      }
    }
    const { stdout } = await execFileAsync(sqlite3Path, ['-readonly', '-json', copyPath, COOKIE_SELECT_SQL], {
      maxBuffer: 256 * 1024 * 1024,
    })
    const trimmed = stdout.trim()
    if (!trimmed) {
      return []
    }
    return JSON.parse(trimmed) as ChromeCookieRow[]
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `sqlite3 CLI not found at "${sqlite3Path}". Install sqlite3 or set PLAYWRITER_SQLITE3_PATH to its location.`,
      )
    }
    throw new Error(`Could not read the Chrome cookie database: ${error?.stderr?.toString?.().trim() || error?.message}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

/** Fetches the "Chrome Safe Storage" password from the macOS login Keychain. The first call prompts the user once. */
export async function readChromeSafeStoragePassword({
  platform = process.platform,
}: { platform?: NodeJS.Platform } = {}): Promise<string> {
  assertCookieImportSupported(platform)
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
      { timeout: 5 * 60_000 },
    )
    const password = stdout.replace(/\r?\n$/, '')
    if (!password) {
      throw new Error('empty password')
    }
    return password
  } catch (error: any) {
    const stderr = String(error?.stderr || '').trim()
    const denied = /could not be found|User interaction is not allowed|denied|-128|-25293/i.test(stderr + error?.message)
    throw new Error(
      [
        'Could not read the "Chrome Safe Storage" key from your macOS Keychain.',
        denied
          ? 'The Keychain prompt was dismissed or denied. Run the command again and click "Allow" (or "Always Allow").'
          : stderr || error?.message || 'unknown error',
        'Chrome must have been run at least once on this Mac for the key to exist.',
      ].join('\n'),
    )
  }
}

/** PBKDF2-HMAC-SHA1 over the Safe Storage password: 1003 rounds on macOS, 1 on Linux, 16-byte AES-128 key. */
export function deriveChromeCookieKey({
  password,
  platform = process.platform,
}: {
  password: string
  platform?: NodeJS.Platform
}): Buffer {
  const iterations = platform === 'linux' ? 1 : 1003
  return crypto.pbkdf2Sync(password, CHROME_PBKDF2_SALT, iterations, 16, 'sha1')
}

/**
 * Decrypts a single cookie value. Returns null when the value cannot be
 * recovered. Chrome 130+ prefixes the plaintext with sha256(host_key); the
 * prefix is stripped only when it matches so older rows stay intact.
 */
export function decryptChromeCookieValue({
  encryptedValueHex,
  plainValue,
  hostKey,
  key,
}: {
  encryptedValueHex: string
  plainValue: string
  hostKey: string
  key: Buffer
}): string | null {
  const encrypted = Buffer.from(encryptedValueHex || '', 'hex')
  if (encrypted.length === 0) {
    return plainValue
  }
  if (encrypted.subarray(0, 3).toString('latin1') !== CHROME_ENCRYPTION_PREFIX) {
    return plainValue ? plainValue : null
  }
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, CHROME_AES_IV)
    const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
    return stripHostHashPrefix({ decrypted, hostKey }).toString('utf-8')
  } catch {
    return null
  }
}

function stripHostHashPrefix({ decrypted, hostKey }: { decrypted: Buffer; hostKey: string }): Buffer {
  if (decrypted.length < CHROME_HOST_HASH_LENGTH) {
    return decrypted
  }
  const expected = crypto.createHash('sha256').update(hostKey, 'utf-8').digest()
  if (decrypted.subarray(0, CHROME_HOST_HASH_LENGTH).equals(expected)) {
    return decrypted.subarray(CHROME_HOST_HASH_LENGTH)
  }
  return decrypted
}

/** Test helper and reference implementation of the Chrome format: v10 + AES-128-CBC(sha256(host_key)? + value). */
export function encryptChromeCookieValue({
  value,
  hostKey,
  key,
  withHostHash,
}: {
  value: string
  hostKey: string
  key: Buffer
  withHostHash: boolean
}): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, CHROME_AES_IV)
  const prefix = withHostHash ? crypto.createHash('sha256').update(hostKey, 'utf-8').digest() : Buffer.alloc(0)
  const plaintext = Buffer.concat([prefix, Buffer.from(value, 'utf-8')])
  return Buffer.concat([Buffer.from(CHROME_ENCRYPTION_PREFIX, 'latin1'), cipher.update(plaintext), cipher.final()])
}

/** Chrome stores expiry as microseconds since 1601-01-01 (Windows FILETIME epoch). */
export function chromeExpiresToUnixSeconds(expiresUtc: number): number {
  return Math.floor(expiresUtc / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS)
}

export function unixSecondsToChromeExpires(unixSeconds: number): number {
  return Math.round((unixSeconds + CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000)
}

/** Chrome samesite column: -1 unspecified, 0 None, 1 Lax, 2 Strict. None is only valid on secure cookies. */
export function mapChromeSameSite({ samesite, secure }: { samesite: number; secure: boolean }): PlaywrightSameSite | undefined {
  if (samesite === 2) return 'Strict'
  if (samesite === 1) return 'Lax'
  if (samesite === 0 && secure) return 'None'
  return undefined
}

/** Strips the leading dot Chrome uses for domain cookies. */
export function normalizeCookieDomain(hostKey: string): string {
  return hostKey.replace(/^\./, '').toLowerCase()
}

export function parseDomainList(domains: string | undefined): string[] {
  if (!domains) {
    return []
  }
  return domains
    .split(',')
    .map((domain) => normalizeCookieDomain(domain.trim()))
    .filter(Boolean)
}

/** A host_key matches a filter domain when it equals it or is a subdomain of it, ignoring the leading dot. */
export function matchesDomainFilter({ hostKey, domains }: { hostKey: string; domains: string[] }): boolean {
  if (domains.length === 0) {
    return true
  }
  const host = normalizeCookieDomain(hostKey)
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export function isChromeCookieExpired({ row, nowSeconds }: { row: ChromeCookieRow; nowSeconds: number }): boolean {
  if (!row.has_expires) {
    return false
  }
  return chromeExpiresToUnixSeconds(row.expires_utc) <= nowSeconds
}

export function toPlaywrightCookie({ row, value }: { row: ChromeCookieRow; value: string }): PlaywrightCookie {
  const secure = Boolean(row.is_secure)
  const cookie: PlaywrightCookie = {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || '/',
    expires: row.has_expires ? chromeExpiresToUnixSeconds(row.expires_utc) : -1,
    httpOnly: Boolean(row.is_httponly),
    secure,
  }
  const sameSite = mapChromeSameSite({ samesite: row.samesite, secure })
  if (sameSite) {
    cookie.sameSite = sameSite
  }
  return cookie
}

/** Filters, decrypts and maps rows. `key` may be omitted for a count-only pass (no cookie values are produced then). */
export function convertChromeCookieRows({
  rows,
  key,
  domains = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  rows: ChromeCookieRow[]
  key: Buffer | null
  domains?: string[]
  nowSeconds?: number
}): CookieConversionSummary {
  const summary: CookieConversionSummary = { cookies: [], expired: 0, filteredOut: 0, undecryptable: 0 }
  for (const row of rows) {
    if (!matchesDomainFilter({ hostKey: row.host_key, domains })) {
      summary.filteredOut++
      continue
    }
    if (isChromeCookieExpired({ row, nowSeconds })) {
      summary.expired++
      continue
    }
    if (!key) {
      summary.cookies.push(toPlaywrightCookie({ row, value: '' }))
      continue
    }
    const value = decryptChromeCookieValue({
      encryptedValueHex: row.encrypted_value_hex,
      plainValue: row.value,
      hostKey: row.host_key,
      key,
    })
    if (value === null) {
      summary.undecryptable++
      continue
    }
    summary.cookies.push(toPlaywrightCookie({ row, value }))
  }
  return summary
}

/** Counts cookies per registrable-ish domain (host_key without the leading dot), most cookies first. */
export function summarizeCookiesByDomain(cookies: Array<{ domain: string }>): Array<{ domain: string; count: number }> {
  const counts = new Map<string, number>()
  for (const cookie of cookies) {
    const domain = normalizeCookieDomain(cookie.domain)
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
}

export function chunkCookies<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

export const COOKIE_IMPORT_CHUNK_SIZE = 200

export interface CookieHandoff {
  /** Base URL of the loopback server, e.g. http://127.0.0.1:52123/<token> */
  baseUrl: string
  close: () => Promise<void>
}

/**
 * Serves cookie chunks to the relay over a one-shot loopback HTTP server.
 *
 * The relay logs every executed `-e` snippet to its log file, so embedding
 * cookie values in the snippet would write them to disk. Instead the snippet
 * fetches each chunk from this server (127.0.0.1 only, random path, each chunk
 * served exactly once) and the log only ever sees the URL.
 */
export async function startCookieHandoff({ chunks }: { chunks: PlaywrightCookie[][] }): Promise<CookieHandoff> {
  const token = crypto.randomBytes(24).toString('hex')
  const served = new Set<number>()
  const server = http.createServer((request, response) => {
    const match = new RegExp(`^/${token}/(\\d+)$`).exec(request.url || '')
    const index = match ? Number(match[1]) : NaN
    if (request.method !== 'GET' || !match || !(index in chunks) || served.has(index)) {
      response.writeHead(404).end()
      return
    }
    served.add(index)
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(chunks[index]))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not start the loopback cookie handoff server')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/${token}`,
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections?.()
      })
    },
  }
}

export interface CookieChunkResult {
  added: number
  failed: Array<{ name: string; domain: string }>
}

export const COOKIE_CHUNK_RESULT_MARKER = '__playwriterCookieImport__'

/**
 * Code executed inside the Playwriter session for one chunk. Uses a page-level
 * CDP session and Network.setCookies because Storage.setCookies (what
 * context.addCookies uses) is a root-session command that extension mode does
 * not support. Falls back to one Network.setCookie per cookie to report which
 * ones Chrome rejected, by name and domain only.
 */
export function buildCookieChunkCode({ chunkUrl }: { chunkUrl: string }): string {
  return `
const response = await fetch(${JSON.stringify(chunkUrl)})
if (!response.ok) {
  throw new Error('Cookie handoff returned HTTP ' + response.status)
}
const cookies = await response.json()
const toCdp = (cookie) => {
  const param = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  }
  if (cookie.sameSite) param.sameSite = cookie.sameSite
  if (typeof cookie.expires === 'number' && cookie.expires > 0) param.expires = cookie.expires
  return param
}
const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage())
const cdp = await getCDPSession({ page })
const result = { added: 0, failed: [] }
try {
  await cdp.send('Network.setCookies', { cookies: cookies.map(toCdp) })
  result.added = cookies.length
} catch {
  for (const cookie of cookies) {
    try {
      const single = await cdp.send('Network.setCookie', toCdp(cookie))
      if (single && single.success === false) {
        result.failed.push({ name: cookie.name, domain: cookie.domain })
      } else {
        result.added++
      }
    } catch {
      result.failed.push({ name: cookie.name, domain: cookie.domain })
    }
  }
}
return ${JSON.stringify(COOKIE_CHUNK_RESULT_MARKER)} + JSON.stringify(result)
`.trim()
}

/** Extracts the chunk result from the relay's execute response text. */
export function parseCookieChunkResult(text: string): CookieChunkResult | null {
  const markerIndex = text.indexOf(COOKIE_CHUNK_RESULT_MARKER)
  if (markerIndex === -1) {
    return null
  }
  const rest = text.slice(markerIndex + COOKIE_CHUNK_RESULT_MARKER.length)
  const end = rest.indexOf('\n')
  const json = (end === -1 ? rest : rest.slice(0, end)).trim()
  try {
    const parsed = JSON.parse(json) as CookieChunkResult
    if (typeof parsed.added !== 'number' || !Array.isArray(parsed.failed)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function formatDomainSummary(summary: Array<{ domain: string; count: number }>, { limit = 40 }: { limit?: number } = {}): string {
  const lines = summary.slice(0, limit).map(({ domain, count }) => {
    return `  ${String(count).padStart(5)}  ${domain}`
  })
  if (summary.length > limit) {
    lines.push(`  ... and ${summary.length - limit} more domains`)
  }
  return lines.join('\n')
}
