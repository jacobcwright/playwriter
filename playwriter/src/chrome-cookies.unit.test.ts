// Unit tests for the Chrome cookie importer. Builds a fake Cookies SQLite
// database with the sqlite3 CLI in a temp dir and encrypts values with a fixed
// passphrase, so nothing here touches the real Chrome profile or the Keychain.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  assertCookieImportSupported,
  buildCookieChunkCode,
  chunkCookies,
  chromeExpiresToUnixSeconds,
  convertChromeCookieRows,
  decryptChromeCookieValue,
  deriveChromeCookieKey,
  encryptChromeCookieValue,
  findChromeCookiesPath,
  getSqlite3Path,
  listChromeProfiles,
  mapChromeSameSite,
  matchesDomainFilter,
  parseCookieChunkResult,
  parseDomainList,
  readChromeCookieRows,
  resolveChromeProfile,
  startCookieHandoff,
  summarizeCookiesByDomain,
  unixSecondsToChromeExpires,
  type ChromeCookieRow,
} from './chrome-cookies.js'

const sqlite3Path = getSqlite3Path()
const key = deriveChromeCookieKey({ password: 'fixed-test-passphrase', platform: 'darwin' })
const NOW = 1_800_000_000
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-chrome-cookies-unit-'))

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function sqlBlob(buffer: Buffer): string {
  return `X'${buffer.toString('hex')}'`
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

interface FakeCookie {
  host: string
  name: string
  value: string
  mode: 'hash' | 'legacy' | 'plain'
  expiresUnix: number | null
  secure?: boolean
  httpOnly?: boolean
  samesite?: number
  path?: string
}

function buildFakeCookiesDb({ dir, cookies }: { dir: string; cookies: FakeCookie[] }): string {
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'Cookies')
  const rows = cookies.map((cookie) => {
    const encrypted =
      cookie.mode === 'plain'
        ? Buffer.alloc(0)
        : encryptChromeCookieValue({ value: cookie.value, hostKey: cookie.host, key, withHostHash: cookie.mode === 'hash' })
    const plain = cookie.mode === 'plain' ? cookie.value : ''
    return [
      sqlText(cookie.host),
      sqlText(cookie.name),
      sqlText(cookie.path ?? '/'),
      sqlBlob(encrypted),
      sqlText(plain),
      String(cookie.expiresUnix === null ? 0 : unixSecondsToChromeExpires(cookie.expiresUnix)),
      cookie.secure ? '1' : '0',
      cookie.httpOnly ? '1' : '0',
      String(cookie.samesite ?? -1),
      cookie.expiresUnix === null ? '0' : '1',
    ].join(', ')
  })
  const sql = [
    'CREATE TABLE cookies (host_key TEXT, name TEXT, path TEXT, encrypted_value BLOB, value TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER);',
    ...rows.map((row) => `INSERT INTO cookies VALUES (${row});`),
  ].join('\n')
  execFileSync(sqlite3Path, [dbPath], { input: sql })
  return dbPath
}

const fakeCookies: FakeCookie[] = [
  { host: '.github.com', name: 'user_session', value: 'gh-secret-with-hash', mode: 'hash', expiresUnix: NOW + 86_400, secure: true, httpOnly: true, samesite: 1 },
  { host: 'api.github.com', name: 'legacy', value: 'no-hash-prefix', mode: 'legacy', expiresUnix: NOW + 3_600, secure: true, samesite: 0 },
  { host: '.example.com', name: 'old', value: 'already-expired', mode: 'hash', expiresUnix: NOW - 10, secure: false },
  { host: 'example.com', name: 'plain', value: 'plaintext-value', mode: 'plain', expiresUnix: null, samesite: 2 },
  { host: '.example.com', name: 'lax', value: 'unicode-✓', mode: 'hash', expiresUnix: NOW + 500, samesite: 1 },
  { host: 'insecure.test', name: 'none-without-secure', value: 'x', mode: 'hash', expiresUnix: NOW + 500, secure: false, samesite: 0 },
]

describe('chrome cookie decryption', () => {
  it('decrypts v10 values with and without the sha256(host_key) prefix', () => {
    const withHash = encryptChromeCookieValue({ value: 'hello', hostKey: '.github.com', key, withHostHash: true })
    const withoutHash = encryptChromeCookieValue({ value: 'hello', hostKey: '.github.com', key, withHostHash: false })
    expect(withHash.subarray(0, 3).toString('latin1')).toBe('v10')
    expect(decryptChromeCookieValue({ encryptedValueHex: withHash.toString('hex'), plainValue: '', hostKey: '.github.com', key })).toBe('hello')
    expect(decryptChromeCookieValue({ encryptedValueHex: withoutHash.toString('hex'), plainValue: '', hostKey: '.github.com', key })).toBe('hello')
  })

  it('only strips the prefix when it matches the host hash', () => {
    const withHash = encryptChromeCookieValue({ value: 'hello', hostKey: '.github.com', key, withHostHash: true })
    const decrypted = decryptChromeCookieValue({ encryptedValueHex: withHash.toString('hex'), plainValue: '', hostKey: 'other.com', key })
    expect(decrypted).not.toBe('hello')
    expect(decrypted?.endsWith('hello')).toBe(true)
  })

  it('uses the plaintext column when the blob is empty or not v10, and null when undecryptable', () => {
    expect(decryptChromeCookieValue({ encryptedValueHex: '', plainValue: 'plain', hostKey: 'a.com', key })).toBe('plain')
    expect(decryptChromeCookieValue({ encryptedValueHex: Buffer.from('v99abc').toString('hex'), plainValue: 'plain', hostKey: 'a.com', key })).toBe('plain')
    expect(decryptChromeCookieValue({ encryptedValueHex: Buffer.from('v99abc').toString('hex'), plainValue: '', hostKey: 'a.com', key })).toBeNull()
    const wrongKey = deriveChromeCookieKey({ password: 'another-passphrase', platform: 'darwin' })
    const encrypted = encryptChromeCookieValue({ value: 'hello', hostKey: 'a.com', key, withHostHash: true })
    const result = decryptChromeCookieValue({ encryptedValueHex: encrypted.toString('hex'), plainValue: '', hostKey: 'a.com', key: wrongKey })
    // Wrong keys either fail padding (null) or produce garbage; never the real value.
    expect(result).not.toBe('hello')
  })

  it('derives a 16 byte key with 1003 PBKDF2 rounds on macOS', () => {
    expect(key.length).toBe(16)
    expect(key.toString('hex')).toBe(
      deriveChromeCookieKey({ password: 'fixed-test-passphrase', platform: 'darwin' }).toString('hex'),
    )
    expect(deriveChromeCookieKey({ password: 'fixed-test-passphrase', platform: 'linux' }).equals(key)).toBe(false)
  })
})

describe('chrome cookie conversion', () => {
  it('converts Chrome epoch microseconds to unix seconds and back', () => {
    expect(chromeExpiresToUnixSeconds(13_000_000_000_000_000)).toBe(1_355_526_400)
    expect(chromeExpiresToUnixSeconds(unixSecondsToChromeExpires(NOW))).toBe(NOW)
  })

  it('maps Chrome samesite ints to Playwright values', () => {
    expect(mapChromeSameSite({ samesite: -1, secure: true })).toBeUndefined()
    expect(mapChromeSameSite({ samesite: 0, secure: true })).toBe('None')
    expect(mapChromeSameSite({ samesite: 0, secure: false })).toBeUndefined()
    expect(mapChromeSameSite({ samesite: 1, secure: false })).toBe('Lax')
    expect(mapChromeSameSite({ samesite: 2, secure: false })).toBe('Strict')
  })

  it('matches domains with and without the leading dot, including subdomains', () => {
    const domains = parseDomainList(' GitHub.com, .Example.com ,,')
    expect(domains).toEqual(['github.com', 'example.com'])
    expect(matchesDomainFilter({ hostKey: '.github.com', domains })).toBe(true)
    expect(matchesDomainFilter({ hostKey: 'github.com', domains })).toBe(true)
    expect(matchesDomainFilter({ hostKey: 'api.github.com', domains })).toBe(true)
    expect(matchesDomainFilter({ hostKey: 'notgithub.com', domains })).toBe(false)
    expect(matchesDomainFilter({ hostKey: 'github.com.evil.net', domains })).toBe(false)
    expect(matchesDomainFilter({ hostKey: 'anything.net', domains: [] })).toBe(true)
  })

  it('reads a sqlite Cookies file and produces Playwright cookie objects', async () => {
    const dbPath = buildFakeCookiesDb({ dir: path.join(tempRoot, 'Default'), cookies: fakeCookies })
    const rows = await readChromeCookieRows({ cookiesPath: dbPath, sqlite3Path })
    expect(rows).toHaveLength(fakeCookies.length)
    expect(fs.existsSync(dbPath)).toBe(true)

    const all = convertChromeCookieRows({ rows, key, nowSeconds: NOW })
    expect(all.expired).toBe(1)
    expect(all.filteredOut).toBe(0)
    expect(all.undecryptable).toBe(0)
    expect(all.cookies.map((cookie) => cookie.name).sort()).toEqual(['lax', 'legacy', 'none-without-secure', 'plain', 'user_session'])

    const session = all.cookies.find((cookie) => cookie.name === 'user_session')
    expect(session).toEqual({
      name: 'user_session',
      value: 'gh-secret-with-hash',
      domain: '.github.com',
      path: '/',
      expires: NOW + 86_400,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    })

    const legacy = all.cookies.find((cookie) => cookie.name === 'legacy')
    expect(legacy).toMatchObject({ value: 'no-hash-prefix', domain: 'api.github.com', secure: true, httpOnly: false, sameSite: 'None', expires: NOW + 3_600 })

    const plain = all.cookies.find((cookie) => cookie.name === 'plain')
    expect(plain).toMatchObject({ value: 'plaintext-value', expires: -1, sameSite: 'Strict', secure: false })

    const lax = all.cookies.find((cookie) => cookie.name === 'lax')
    expect(lax?.value).toBe('unicode-✓')

    const noneInsecure = all.cookies.find((cookie) => cookie.name === 'none-without-secure')
    expect(noneInsecure).not.toHaveProperty('sameSite')

    const filtered = convertChromeCookieRows({ rows, key, domains: ['github.com'], nowSeconds: NOW })
    expect(filtered.cookies.map((cookie) => cookie.domain).sort()).toEqual(['.github.com', 'api.github.com'])
    expect(filtered.filteredOut).toBe(4)

    const countOnly = convertChromeCookieRows({ rows, key: null, nowSeconds: NOW })
    expect(countOnly.cookies.every((cookie) => cookie.value === '')).toBe(true)
    expect(summarizeCookiesByDomain(countOnly.cookies)).toEqual([
      { domain: 'example.com', count: 2 },
      { domain: 'api.github.com', count: 1 },
      { domain: 'github.com', count: 1 },
      { domain: 'insecure.test', count: 1 },
    ])
  })

  it('counts undecryptable rows instead of throwing', () => {
    const rows: ChromeCookieRow[] = [
      { host_key: 'a.com', name: 'bad', path: '/', encrypted_value_hex: Buffer.from('v10garbage-not-a-block').toString('hex'), value: '', expires_utc: 0, is_secure: 0, is_httponly: 0, samesite: -1, has_expires: 0 },
    ]
    const result = convertChromeCookieRows({ rows, key, nowSeconds: NOW })
    expect(result.cookies).toHaveLength(0)
    expect(result.undecryptable).toBe(1)
  })

  it('rejects platforms that are not implemented yet with a clear message', () => {
    expect(() => assertCookieImportSupported('darwin')).not.toThrow()
    expect(() => assertCookieImportSupported('win32')).toThrow(/not supported yet on Windows/)
    expect(() => assertCookieImportSupported('linux')).toThrow(/not supported yet on Linux/)
  })

  it('chunks cookies into batches', () => {
    const items = Array.from({ length: 450 }, (_, index) => index)
    const chunks = chunkCookies(items, 200)
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 50])
  })
})

describe('chrome profile discovery', () => {
  it('lists profiles from Local State and finds the Cookies file in either location', () => {
    const userDataDir = path.join(tempRoot, 'user-data')
    fs.mkdirSync(path.join(userDataDir, 'Default', 'Network'), { recursive: true })
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Network', 'Cookies'), '')
    fs.mkdirSync(path.join(userDataDir, 'Profile 2'), { recursive: true })
    fs.writeFileSync(path.join(userDataDir, 'Profile 2', 'Cookies'), '')
    fs.mkdirSync(path.join(userDataDir, 'Profile 10'), { recursive: true })
    fs.writeFileSync(
      path.join(userDataDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: 'Personal', user_name: 'me@gmail.com' },
            'Profile 2': { name: 'Work', user_name: 'me@work.com' },
          },
        },
      }),
    )

    const profiles = listChromeProfiles({ userDataDir })
    expect(profiles.map((profile) => profile.dir)).toEqual(['Default', 'Profile 2', 'Profile 10'])
    expect(profiles[0]).toMatchObject({ name: 'Personal', email: 'me@gmail.com' })
    expect(profiles[0].cookiesPath).toBe(path.join(userDataDir, 'Default', 'Network', 'Cookies'))
    expect(profiles[1].cookiesPath).toBe(path.join(userDataDir, 'Profile 2', 'Cookies'))
    expect(profiles[2]).toMatchObject({ name: '', email: '', cookiesPath: null })

    expect(resolveChromeProfile({ profiles, profile: 'profile 2' })?.dir).toBe('Profile 2')
    expect(resolveChromeProfile({ profiles, profile: 'work' })?.dir).toBe('Profile 2')
    expect(resolveChromeProfile({ profiles, profile: 'ME@GMAIL.COM' })?.dir).toBe('Default')
    expect(resolveChromeProfile({ profiles, profile: 'nope' })).toBeNull()
    expect(findChromeCookiesPath({ userDataDir, profileDir: 'Profile 10' })).toBeNull()
    expect(listChromeProfiles({ userDataDir: path.join(tempRoot, 'missing') })).toEqual([])
  })
})

describe('cookie handoff to the relay', () => {
  it('serves each chunk exactly once on 127.0.0.1 and the generated code never embeds values', async () => {
    const chunks = chunkCookies(
      [
        { name: 'a', value: 'secret-a', domain: '.a.com', path: '/', expires: -1, httpOnly: false, secure: true },
        { name: 'b', value: 'secret-b', domain: '.b.com', path: '/', expires: NOW, httpOnly: true, secure: true },
      ],
      1,
    )
    const handoff = await startCookieHandoff({ chunks })
    try {
      expect(handoff.baseUrl.startsWith('http://127.0.0.1:')).toBe(true)
      const code = buildCookieChunkCode({ chunkUrl: `${handoff.baseUrl}/0` })
      expect(code).not.toContain('secret-a')
      expect(code).toContain('Network.setCookies')

      const first = await fetch(`${handoff.baseUrl}/0`)
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual(chunks[0])
      const again = await fetch(`${handoff.baseUrl}/0`)
      expect(again.status).toBe(404)
      const wrongToken = await fetch(`${handoff.baseUrl.replace(/\/[0-9a-f]+$/, '/deadbeef')}/1`)
      expect(wrongToken.status).toBe(404)
      const second = await fetch(`${handoff.baseUrl}/1`)
      expect(second.status).toBe(200)
    } finally {
      await handoff.close()
    }
  })

  it('parses the chunk result out of the relay output', () => {
    const text = 'Console output:\n[log] hi\n\n[return value] __playwriterCookieImport__{"added":3,"failed":[{"name":"x","domain":".y.com"}]}\n'
    expect(parseCookieChunkResult(text)).toEqual({ added: 3, failed: [{ name: 'x', domain: '.y.com' }] })
    expect(parseCookieChunkResult('Code executed successfully (no output)')).toBeNull()
  })
})
