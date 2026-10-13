// Microphone narration for the skill recorder, relay side.
//
// The relay process cannot open a microphone. The extension captures it in its
// offscreen document (MediaRecorder, opus in webm) and streams base64 chunks
// over the extension WebSocket. This module owns the file, the timing metadata
// that aligns audio with the action timeline, and the optional local
// transcript that `recorder events` merges into that timeline.
//
// Nothing here uploads audio. Transcription is a separate, local-only step
// (`playwriter recorder transcribe`) that shells out to a tool already on the
// machine.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { RecordingOutput } from './recording-relay.js'
import type {
  NarrationEndReason,
  NarrationFailureReason,
  StartNarrationParams,
  StartNarrationResult,
  StopNarrationParams,
  StopNarrationResult,
} from './protocol.js'

export const NARRATION_METADATA_FILE = 'narration.json'
export const NARRATION_TRANSCRIPT_FILE = 'narration.transcript.json'
export const DEFAULT_NARRATION_STOP_TIMEOUT_MS = 10_000
export const DEFAULT_NARRATION_START_TIMEOUT_MS = 15_000

interface NarrationLogger {
  log: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** The relay -> extension side of narration. Implemented over sendToExtension
 *  in the relay; tests inject a fake. */
export interface NarrationTransport {
  start(params: StartNarrationParams): Promise<StartNarrationResult>
  stop(params: StopNarrationParams): Promise<StopNarrationResult>
  cancel(params: StopNarrationParams): Promise<void>
}

/** Written to `<recordingsDir>/<id>/narration.json` and embedded in the
 *  `recording-stopped` event. Everything an agent needs to line speech up
 *  with actions: audio second `s` happened at timeline `audioStartMs + s*1000`. */
export type NarrationMetadata = {
  recordingId: string
  source: 'microphone'
  audioPath: string
  mimeType: string
  /** ms since recording start at which the audio file begins */
  audioStartMs: number
  durationMs: number
  sizeBytes: number
  endReason: NarrationEndReason
  error?: string
  deviceLabel?: string
  /** Set once a local transcript exists next to the audio */
  transcriptPath: string | null
}

export type NarrationStartOutcome =
  | { active: true; audioPath: string; audioStartMs: number; mimeType: string; deviceLabel?: string }
  | { active: false; reason: NarrationFailureReason; error: string }

export function narrationDir({ recordingsDir, recordingId }: { recordingsDir: string; recordingId: string }): string {
  return path.join(recordingsDir, recordingId)
}

function audioExtensionFor(mimeType: string): string {
  const lower = mimeType.toLowerCase()
  if (lower.includes('ogg')) {
    return 'ogg'
  }
  if (lower.includes('mp4') || lower.includes('aac')) {
    return 'm4a'
  }
  if (lower.includes('wav')) {
    return 'wav'
  }
  return 'webm'
}

export function readNarrationMetadata({
  recordingsDir,
  recordingId,
}: {
  recordingsDir: string
  recordingId: string
}): NarrationMetadata | null {
  const file = path.join(narrationDir({ recordingsDir, recordingId }), NARRATION_METADATA_FILE)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as NarrationMetadata
  } catch {
    return null
  }
}

export function writeNarrationMetadata({
  recordingsDir,
  metadata,
}: {
  recordingsDir: string
  metadata: NarrationMetadata
}): string {
  const dir = narrationDir({ recordingsDir, recordingId: metadata.recordingId })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, NARRATION_METADATA_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 })
  if (process.platform === 'win32' && fs.existsSync(file)) {
    fs.unlinkSync(file)
  }
  fs.renameSync(tmp, file)
  return file
}

/**
 * One microphone capture bound to one action recording. Lifecycle:
 *
 *   start()  -> transport.start -> extension opens the mic, MediaRecorder runs
 *   chunks   -> handleChunk() appends to a temp file
 *   stop()   -> transport.stop -> extension flushes, sends narrationEnded
 *   ended    -> handleEnded() renames the temp file into place
 *
 * handleEnded() can also arrive on its own (device unplugged, recorder error,
 * extension gone). The partial audio is kept: a half narration is still useful.
 */
export class NarrationCapture {
  readonly recordingId: string
  private recordingsDir: string
  private recordingStartedAt: number
  private transport: NarrationTransport
  private logger: NarrationLogger
  private stopTimeoutMs: number
  private state: 'idle' | 'starting' | 'recording' | 'stopping' | 'ended' | 'failed' = 'idle'
  private output: RecordingOutput | null = null
  private audioPath: string | null = null
  private mimeType = ''
  private deviceLabel: string | undefined
  private audioStartMs = 0
  private startedAtEpoch = 0
  private endedResult: { reason: NarrationEndReason; error?: string; durationMs?: number } | null = null
  private resolveEnded: (() => void) | null = null
  private metadataCache: NarrationMetadata | null = null
  private failure: { reason: NarrationFailureReason; error: string } | null = null

  constructor({
    recordingId,
    recordingsDir,
    recordingStartedAt,
    transport,
    logger,
    stopTimeoutMs,
  }: {
    recordingId: string
    recordingsDir: string
    /** Epoch ms of the action recording start; audio offsets are relative to it */
    recordingStartedAt: number
    transport: NarrationTransport
    logger: NarrationLogger
    stopTimeoutMs?: number
  }) {
    this.recordingId = recordingId
    this.recordingsDir = recordingsDir
    this.recordingStartedAt = recordingStartedAt
    this.transport = transport
    this.logger = logger
    this.stopTimeoutMs = stopTimeoutMs ?? DEFAULT_NARRATION_STOP_TIMEOUT_MS
  }

  get isActive(): boolean {
    return this.state === 'starting' || this.state === 'recording' || this.state === 'stopping'
  }

  async start(): Promise<NarrationStartOutcome> {
    if (this.state !== 'idle') {
      return { active: false, reason: 'already-active', error: 'Narration already started' }
    }
    this.state = 'starting'
    const result = await this.transport
      .start({ recordingId: this.recordingId })
      .catch((error: unknown): StartNarrationResult => {
        return {
          success: false,
          reason: 'capture-failed',
          error: error instanceof Error ? error.message : String(error),
        }
      })
    if (!result.success) {
      this.state = 'failed'
      this.failure = { reason: result.reason, error: result.error }
      return { active: false, reason: result.reason, error: result.error }
    }
    // The extension may have been cancelled while we waited (recording stopped)
    if (this.state !== 'starting') {
      await this.transport.cancel({ recordingId: this.recordingId }).catch(() => {})
      return { active: false, reason: 'capture-failed', error: 'Recording stopped before narration started' }
    }
    this.mimeType = result.mimeType || 'audio/webm'
    this.deviceLabel = result.deviceLabel
    this.startedAtEpoch = result.startedAt
    // Both timestamps come from the same machine clock (extension + relay are
    // local). Clamp: MediaRecorder cannot have started before the recording.
    this.audioStartMs = Math.max(0, Math.round(result.startedAt - this.recordingStartedAt))
    const dir = narrationDir({ recordingsDir: this.recordingsDir, recordingId: this.recordingId })
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.audioPath = path.join(dir, `narration.${audioExtensionFor(this.mimeType)}`)
    try {
      this.output = RecordingOutput.open({ outputPath: this.audioPath })
    } catch (error) {
      this.state = 'failed'
      const message = error instanceof Error ? error.message : String(error)
      this.failure = { reason: 'capture-failed', error: `Could not open narration file: ${message}` }
      await this.transport.cancel({ recordingId: this.recordingId }).catch(() => {})
      return { active: false, reason: 'capture-failed', error: this.failure.error }
    }
    this.state = 'recording'
    return {
      active: true,
      audioPath: this.audioPath,
      audioStartMs: this.audioStartMs,
      mimeType: this.mimeType,
      deviceLabel: this.deviceLabel,
    }
  }

  handleChunk(dataBase64: string): void {
    if (!this.output || (this.state !== 'recording' && this.state !== 'stopping')) {
      return
    }
    try {
      this.output.append(Buffer.from(dataBase64, 'base64'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('[narration] failed to write chunk:', error)
      this.finalize({ reason: 'error', error: `Failed to write narration: ${message}` })
      void this.transport.cancel({ recordingId: this.recordingId }).catch(() => {})
    }
  }

  handleEnded(params: { reason: NarrationEndReason; error?: string; durationMs?: number }): void {
    if (this.state === 'ended' || this.state === 'failed') {
      return
    }
    this.finalize(params)
  }

  /** Ask the extension to stop, wait for the final chunk + narrationEnded. */
  async stop(): Promise<NarrationMetadata | null> {
    if (this.state === 'idle' || this.state === 'failed') {
      return null
    }
    if (this.state === 'ended') {
      return this.metadataCache
    }
    if (this.state === 'starting') {
      // start() will see the state change and cancel on the extension
      this.state = 'ended'
      return null
    }
    this.state = 'stopping'
    const ended = new Promise<void>((resolve) => {
      this.resolveEnded = resolve
    })
    const stopResult = await this.transport.stop({ recordingId: this.recordingId }).catch((error: unknown) => {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      }
    })
    if (!stopResult.success) {
      this.finalize({ reason: 'error', error: stopResult.error })
      return this.metadataCache
    }
    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        resolve('timeout')
      }, this.stopTimeoutMs)
      timer.unref?.()
    })
    const winner = await Promise.race([ended.then(() => 'ended' as const), timeout])
    if (winner === 'timeout') {
      this.finalize({
        reason: 'error',
        error: `Timed out waiting ${this.stopTimeoutMs}ms for the final narration chunk`,
        durationMs: stopResult.durationMs,
      })
    }
    return this.metadataCache
  }

  /** Extension gone / relay shutting down: keep what we have. */
  destroy(reason: string): void {
    if (!this.isActive) {
      return
    }
    this.finalize({ reason: 'error', error: reason })
  }

  metadata(): NarrationMetadata | null {
    return this.metadataCache
  }

  failureInfo(): { reason: NarrationFailureReason; error: string } | null {
    return this.failure
  }

  private finalize(params: { reason: NarrationEndReason; error?: string; durationMs?: number }): void {
    const wasStarting = this.state === 'starting'
    this.state = 'ended'
    this.endedResult = params
    if (!this.output || !this.audioPath || wasStarting) {
      this.resolveEnded?.()
      this.resolveEnded = null
      return
    }
    let finished: { path: string; size: number } | null = null
    try {
      finished = this.output.finish()
    } catch (error) {
      this.logger.error('[narration] failed to finish audio file:', error)
      this.output.cancel()
    }
    this.output = null
    const durationMs = params.durationMs ?? Math.max(0, Date.now() - this.startedAtEpoch)
    if (finished && finished.size > 0) {
      this.metadataCache = {
        recordingId: this.recordingId,
        source: 'microphone',
        audioPath: finished.path,
        mimeType: this.mimeType,
        audioStartMs: this.audioStartMs,
        durationMs,
        sizeBytes: finished.size,
        endReason: params.reason,
        error: params.error,
        deviceLabel: this.deviceLabel,
        transcriptPath: null,
      }
      try {
        writeNarrationMetadata({ recordingsDir: this.recordingsDir, metadata: this.metadataCache })
      } catch (error) {
        this.logger.error('[narration] failed to write metadata:', error)
      }
    } else {
      // Empty file: nothing was captured. Do not leave a 0-byte audio around.
      try {
        if (finished) {
          fs.unlinkSync(finished.path)
        }
      } catch {}
      this.failure = { reason: 'capture-failed', error: params.error || 'No audio was captured' }
    }
    this.resolveEnded?.()
    this.resolveEnded = null
  }
}

// ============================================================================
// Transcripts. Local only. The canonical on-disk shape is
// { segments: [{ start, end, text }] } with seconds relative to the audio file.
// normalizeTranscript also accepts the raw output of whisper.cpp (`-oj`) and
// openai-whisper (`--output_format json`) so `recorder transcribe` can write
// the canonical file from either tool.
// ============================================================================

export type TranscriptSegment = {
  /** seconds from the start of the audio file */
  start: number
  end: number
  text: string
}

export type NarrationTranscript = {
  recordingId?: string
  /** which local tool produced it, e.g. 'whisper-cli', 'openai-whisper', 'command', 'manual' */
  source?: string
  createdAt?: string
  segments: TranscriptSegment[]
}

function toSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    // whisper.cpp timestamps: "00:00:01,240"
    const match = value.match(/^(\d+):(\d+):(\d+)[,.](\d+)$/)
    if (match) {
      const [, h, m, s, frac] = match
      return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`)
    }
    const num = Number(value)
    if (Number.isFinite(num)) {
      return num
    }
  }
  return null
}

export function normalizeTranscript(raw: unknown): TranscriptSegment[] {
  const candidates: unknown[] = (() => {
    if (Array.isArray(raw)) {
      return raw
    }
    if (raw && typeof raw === 'object') {
      const record = raw as Record<string, unknown>
      if (Array.isArray(record.segments)) {
        return record.segments
      }
      // whisper.cpp -oj
      if (Array.isArray(record.transcription)) {
        return record.transcription
      }
      if (typeof record.text === 'string') {
        return [{ start: 0, end: 0, text: record.text }]
      }
    }
    return []
  })()
  const segments: TranscriptSegment[] = []
  for (const item of candidates) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text) {
      continue
    }
    const offsets = (record.offsets ?? null) as { from?: unknown; to?: unknown } | null
    const timestamps = (record.timestamps ?? null) as { from?: unknown; to?: unknown } | null
    const start =
      toSeconds(record.start) ??
      (offsets && typeof offsets.from === 'number' ? offsets.from / 1000 : null) ??
      toSeconds(timestamps?.from) ??
      0
    const end =
      toSeconds(record.end) ??
      (offsets && typeof offsets.to === 'number' ? offsets.to / 1000 : null) ??
      toSeconds(timestamps?.to) ??
      start
    segments.push({ start: Math.max(0, start), end: Math.max(start, end), text })
  }
  segments.sort((a, b) => {
    return a.start - b.start
  })
  return segments
}

export function readNarrationTranscript({
  recordingsDir,
  recordingId,
}: {
  recordingsDir: string
  recordingId: string
}): NarrationTranscript | null {
  const file = path.join(narrationDir({ recordingsDir, recordingId }), NARRATION_TRANSCRIPT_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
  const segments = normalizeTranscript(raw)
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    recordingId,
    source: typeof record.source === 'string' ? record.source : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    segments,
  }
}

export function writeNarrationTranscript({
  recordingsDir,
  recordingId,
  transcript,
}: {
  recordingsDir: string
  recordingId: string
  transcript: NarrationTranscript
}): string {
  const dir = narrationDir({ recordingsDir, recordingId })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, NARRATION_TRANSCRIPT_FILE)
  fs.writeFileSync(file, JSON.stringify({ recordingId, ...transcript }, null, 2) + '\n', { mode: 0o600 })
  const metadata = readNarrationMetadata({ recordingsDir, recordingId })
  if (metadata) {
    writeNarrationMetadata({ recordingsDir, metadata: { ...metadata, transcriptPath: file } })
  }
  return file
}

type TimelineEvent = { t: number; type: string; ms?: number; [key: string]: unknown }

/**
 * Interleave transcript segments into the event timeline as `narration`
 * events. Ids are `n<index>` so they never collide with numeric event ids and
 * cannot be passed to `recorder events <id>` (they are already complete).
 */
export function mergeTranscriptIntoEvents<T extends TimelineEvent>({
  events,
  audioStartMs,
  segments,
}: {
  events: T[]
  audioStartMs: number
  segments: TranscriptSegment[]
}): Array<T | TimelineEvent> {
  if (segments.length === 0) {
    return events
  }
  const narration: TimelineEvent[] = segments.map((segment, index) => {
    const ms = Math.round(audioStartMs + segment.start * 1000)
    return {
      id: `n${index + 1}`,
      t: Math.round(ms / 100) / 10,
      ms,
      endMs: Math.round(audioStartMs + segment.end * 1000),
      type: 'narration',
      text: segment.text,
    }
  })
  const merged: Array<T | TimelineEvent> = []
  let n = 0
  for (const event of events) {
    const eventMs = typeof event.ms === 'number' ? event.ms : Math.round(event.t * 1000)
    // Narration spoken before this event goes first. Keep the recording-stopped
    // event last so the timeline still ends with it.
    while (n < narration.length && (narration[n]!.ms! <= eventMs || event.type === 'recording-stopped')) {
      merged.push(narration[n]!)
      n += 1
    }
    merged.push(event)
  }
  while (n < narration.length) {
    merged.push(narration[n]!)
    n += 1
  }
  return merged
}

// ============================================================================
// Local transcription. Shells out to a speech-to-text tool that is already
// installed. Never contacts a network service.
// ============================================================================

export type TranscribeOptions = {
  recordingsDir: string
  recordingId: string
  /** Shell command template with {input} and {output} placeholders. {output}
   *  must receive a JSON file in any shape normalizeTranscript understands. */
  command?: string
  /** whisper.cpp model path (or WHISPER_CPP_MODEL env) */
  model?: string
  logger?: NarrationLogger
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function runShell(commandLine: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const shell =
    process.platform === 'win32'
      ? (['cmd.exe', ['/d', '/s', '/c', commandLine]] as const)
      : (['/bin/sh', ['-c', commandLine]] as const)
  return run(shell[0], [...shell[1]])
}

async function hasBinary(name: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const result = await run(probe, [name])
    return result.code === 0
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`
  }
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function convertToWav16k({ input, output }: { input: string; output: string }): Promise<void> {
  if (!(await hasBinary('ffmpeg'))) {
    throw new Error(
      'ffmpeg is required to convert the narration to 16 kHz wav for whisper.cpp. Install ffmpeg or pass --command.',
    )
  }
  const result = await run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    input,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    output,
  ])
  if (result.code !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr.trim() || result.code}`)
  }
}

/**
 * Transcribe the narration of a recording with a local tool. Resolution order:
 * explicit `command` template, then whisper.cpp (`whisper-cli` / `whisper-cpp`,
 * needs a model via `model` or WHISPER_CPP_MODEL), then openai-whisper (`whisper`).
 * Writes narration.transcript.json next to the audio and returns its path.
 */
export async function transcribeNarration(
  options: TranscribeOptions,
): Promise<{ transcriptPath: string; segments: TranscriptSegment[]; tool: string }> {
  const { recordingsDir, recordingId } = options
  const logger = options.logger ?? { log: () => {}, error: () => {} }
  const metadata = readNarrationMetadata({ recordingsDir, recordingId })
  if (!metadata) {
    throw new Error(
      `Recording ${recordingId} has no narration (no ${NARRATION_METADATA_FILE}). Record with --mic first.`,
    )
  }
  if (!fs.existsSync(metadata.audioPath)) {
    throw new Error(`Narration audio not found: ${metadata.audioPath}`)
  }
  const dir = narrationDir({ recordingsDir, recordingId })
  const workDir = fs.mkdtempSync(path.join(dir, '.transcribe-'))
  const outputJson = path.join(workDir, 'transcript.json')
  try {
    const tool = await (async (): Promise<string> => {
      if (options.command) {
        const commandLine = options.command
          .split('{input}')
          .join(shellQuote(metadata.audioPath))
          .split('{output}')
          .join(shellQuote(outputJson))
        logger.log(`[transcribe] ${commandLine}`)
        const result = await runShell(commandLine)
        if (result.code !== 0) {
          throw new Error(
            `Transcription command failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
          )
        }
        return 'command'
      }
      const whisperCpp = (await hasBinary('whisper-cli'))
        ? 'whisper-cli'
        : (await hasBinary('whisper-cpp'))
          ? 'whisper-cpp'
          : null
      const model = options.model || process.env.WHISPER_CPP_MODEL
      if (whisperCpp && model) {
        const wav = path.join(workDir, 'narration.wav')
        await convertToWav16k({ input: metadata.audioPath, output: wav })
        const base = path.join(workDir, 'transcript')
        const result = await run(whisperCpp, ['-m', model, '-f', wav, '-oj', '-of', base, '-np'])
        if (result.code !== 0) {
          throw new Error(`${whisperCpp} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
        }
        return whisperCpp
      }
      if (await hasBinary('whisper')) {
        const result = await run('whisper', [
          metadata.audioPath,
          '--output_format',
          'json',
          '--output_dir',
          workDir,
          '--verbose',
          'False',
        ])
        if (result.code !== 0) {
          throw new Error(`whisper failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
        }
        const produced = fs.readdirSync(workDir).find((file) => {
          return file.endsWith('.json')
        })
        if (!produced) {
          throw new Error('whisper produced no JSON output')
        }
        fs.renameSync(path.join(workDir, produced), outputJson)
        return 'openai-whisper'
      }
      throw new Error(
        [
          'No local transcription tool found. Options:',
          '  - whisper.cpp: install whisper-cli and pass --model <ggml-model.bin> (or set WHISPER_CPP_MODEL)',
          '  - openai-whisper: pip install openai-whisper (provides the `whisper` CLI)',
          '  - any tool: --command "<cmd> {input} {output}" where {output} receives a JSON transcript',
          `Audio file: ${metadata.audioPath}`,
        ].join('\n'),
      )
    })()
    if (!fs.existsSync(outputJson)) {
      throw new Error(`Transcription produced no output at ${outputJson}`)
    }
    const raw: unknown = JSON.parse(fs.readFileSync(outputJson, 'utf-8'))
    const segments = normalizeTranscript(raw)
    const transcriptPath = writeNarrationTranscript({
      recordingsDir,
      recordingId,
      transcript: { source: tool, createdAt: new Date().toISOString(), segments },
    })
    return { transcriptPath, segments, tool }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}
