/**
 * Screen recording utility for playwriter using chrome.tabCapture.
 * Recording happens in the extension context, so it survives page navigation.
 *
 * This module communicates with the relay server which forwards commands to the extension.
 * sessionId (pw-tab-* format) is used to identify which tab to record.
 */

import os from 'node:os'
import path from 'node:path'
import type { BrowserContext, Page } from '@xmorse/playwright-core'
import { shouldUseHeadlessByDefault } from './browser-config.js'
import type {
  StartRecordingResult,
  StopRecordingResult,
  IsRecordingResult,
  CancelRecordingResult,
  StartStreamParams,
  StartStreamResult,
  StopStreamResult,
  StreamStatusResult,
} from './protocol.js'
import { GhostCursorController } from './ghost-cursor-controller.js'

/**
 * Build headers for the relay's privileged /recording/* HTTP endpoints.
 * Reads PLAYWRITER_TOKEN from env so in-process callers (executor running
 * inside `playwriter serve --token …`) authenticate against their own relay.
 * The `serve` command sets the env var at startup.
 */
function recordingHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = process.env.PLAYWRITER_TOKEN
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

/**
 * Generate a CLI command that starts a managed Playwriter browser with the
 * bundled extension preloaded. This enables screen recording without a manual
 * extension click on fresh automation sessions.
 */
export function getChromeRestartCommand(): string {
  const headlessFlag = shouldUseHeadlessByDefault({ platform: os.platform() }) ? ' --headless' : ''
  return `playwriter browser start${headlessFlag}`
}

const DEFAULT_ASPECT_RATIO = { width: 16, height: 9 }

/** Default max recording duration: 15 minutes in milliseconds */
const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000

/**
 * Compute the largest viewport that fits inside `current` at the target aspect ratio.
 * Never increases width or height beyond current values — only shrinks the
 * dimension that's "too large" relative to the target ratio.
 */
export function fitToAspectRatio(
  current: { width: number; height: number },
  ratio: { width: number; height: number } = DEFAULT_ASPECT_RATIO,
): { width: number; height: number } {
  const targetRatio = ratio.width / ratio.height
  const currentRatio = current.width / current.height
  if (currentRatio > targetRatio) {
    // Too wide — keep height, shrink width
    return { width: Math.round(current.height * targetRatio), height: current.height }
  }
  // Too tall (or already exact) — keep width, shrink height
  return { width: current.width, height: Math.round(current.width / targetRatio) }
}

/**
 * Check if an error is related to missing activeTab permission for recording.
 */
function isActiveTabPermissionError(error: string): boolean {
  return (
    error.includes('Extension has not been invoked') ||
    error.includes('activeTab') ||
    error.includes('enable recording')
  )
}

export interface StartRecordingOptions {
  /** CDP tab session ID (pw-tab-* format) to identify which tab to record */
  sessionId?: string
  /** Frame rate (default: 30) */
  frameRate?: number
  /** Video bitrate in bps (default: 2500000 = 2.5 Mbps) */
  videoBitsPerSecond?: number
  /** Audio bitrate in bps (default: 128000 = 128 kbps) */
  audioBitsPerSecond?: number
  /** Include audio from tab (default: false) */
  audio?: boolean
  /** Mix the user's microphone into the audio track (default: false). With
   *  `audio: true` both tab audio and microphone are mixed. Requires the
   *  one-time microphone permission (toolbar Mic toggle or `playwriter recorder start --mic`). */
  microphone?: boolean
  /** Path to save the video file */
  outputPath: string
  /** Relay server port (default: 19988) */
  relayPort?: number
  /** Aspect ratio to fit viewport to before recording (default: { width: 16, height: 9 }).
   *  Set to null to skip viewport resizing. */
  aspectRatio?: { width: number; height: number } | null
  /** Max recording duration in ms (default: 15 min = 900000). Auto-stops recording
   *  when exceeded to prevent accidentally filling disk. Set to 0 or Infinity to disable. */
  maxDurationMs?: number
}

export interface StopRecordingOptions {
  /** CDP tab session ID (pw-tab-* format) to identify which tab to stop recording */
  sessionId?: string
  /** Relay server port (default: 19988) */
  relayPort?: number
}

export interface RecordingState {
  isRecording: boolean
  startedAt?: number
  tabId?: number
}

export interface ExecutionTimestamp {
  start: number
  end: number
}

interface RecordingTargetOptions {
  page?: Page
  sessionId?: string
}

interface CreateRecordingApiOptions {
  context: BrowserContext
  relayPort: number
  ghostCursorController: GhostCursorController
  onStart: () => void
  onFinish: () => void
  getExecutionTimestamps: () => ExecutionTimestamp[]
}

interface StartRecordingWithDefaultsOptions extends Omit<StartRecordingOptions, 'relayPort'>, RecordingTargetOptions {}
type StopRecordingWithDefaultsOptions = RecordingTargetOptions

const RECORDING_TARGET_REQUIRED =
  'requires an explicit target tab, e.g. ({ page: state.page }). There is no default page; create one with `state.page = await context.newPage()`.'

/** Resolve the tab to record/stream. There is no default page: require page or a known sessionId. */
function resolveTarget(options: {
  helper: string
  context?: BrowserContext
  ghostCursorController?: GhostCursorController
  target?: RecordingTargetOptions
}): { page: Page | null; sessionId: string } {
  const { helper, context, ghostCursorController, target } = options
  const page = context && ghostCursorController
    ? ghostCursorController.resolveRecordingTargetPage({ context, target })
    : target?.page || null
  const sessionId = target?.sessionId || page?.sessionId() || undefined
  if (!sessionId) {
    throw new Error(`${helper} ${RECORDING_TARGET_REQUIRED}`)
  }
  return { page, sessionId }
}

export function createRecordingApi(options: CreateRecordingApiOptions): {
  start: (opts: StartRecordingWithDefaultsOptions) => Promise<RecordingState>
  stop: (opts: StopRecordingWithDefaultsOptions) => Promise<{ path: string; duration: number; size: number; executionTimestamps: ExecutionTimestamp[] }>
  isRecording: (opts: RecordingTargetOptions) => Promise<RecordingState>
  cancel: (opts: RecordingTargetOptions) => Promise<void>
} {
  const { context, relayPort, ghostCursorController, onStart, onFinish, getExecutionTimestamps } = options
  const resolve = (helper: string, target?: RecordingTargetOptions) => {
    return resolveTarget({ helper, context, ghostCursorController, target })
  }

  // Stores the original viewport before aspect-ratio resize so we can restore on stop/cancel
  let preRecordingViewport: { width: number; height: number } | null = null
  // Auto-stop timer to prevent unbounded recordings
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null

  const start = async (opts: StartRecordingWithDefaultsOptions): Promise<RecordingState> => {
    const { page: targetPage, sessionId } = resolve('recording.start', opts)

    // Resize viewport to target aspect ratio (default 16:9) before recording.
    // Only shrinks — never increases width or height beyond current values.
    const aspectRatio = opts?.aspectRatio === undefined ? DEFAULT_ASPECT_RATIO : opts.aspectRatio
    if (aspectRatio && targetPage) {
      const current = targetPage.viewportSize()
      if (current) {
        const fitted = fitToAspectRatio(current, aspectRatio)
        if (fitted.width !== current.width || fitted.height !== current.height) {
          preRecordingViewport = current
          await targetPage.setViewportSize(fitted)
        }
      }
    }

    const result = await startRecording({ ...opts, sessionId, relayPort })
    onStart()

    // Schedule auto-stop to prevent unbounded recordings filling disk.
    // Default 15 min. Set maxDurationMs to 0 or Infinity to disable.
    const maxMs = opts?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
    if (maxMs > 0 && maxMs < Infinity) {
      maxDurationTimer = setTimeout(() => {
        maxDurationTimer = null
        stop({ page: opts.page, sessionId }).catch(() => {})
      }, maxMs)
    }

    return result
  }

  const clearMaxDurationTimer = (): void => {
    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer)
      maxDurationTimer = null
    }
  }

  const restoreViewport = async (targetPage: Page | null): Promise<void> => {
    if (!preRecordingViewport || !targetPage) {
      return
    }
    const saved = preRecordingViewport
    preRecordingViewport = null
    await targetPage.setViewportSize(saved)
  }

  const stop = async (
    opts: StopRecordingWithDefaultsOptions,
  ): Promise<{ path: string; duration: number; size: number; executionTimestamps: ExecutionTimestamp[] }> => {
    const { page: targetPage, sessionId } = resolve('recording.stop', opts)
    clearMaxDurationTimer()
    const result = await stopRecording({ sessionId, relayPort })
    const executionTimestamps = [...getExecutionTimestamps()]
    onFinish()
    await restoreViewport(targetPage)
    return { ...result, executionTimestamps }
  }

  const cancel = async (opts: RecordingTargetOptions): Promise<void> => {
    const { page: targetPage, sessionId } = resolve('recording.cancel', opts)
    clearMaxDurationTimer()
    await cancelRecording({ sessionId, relayPort })
    onFinish()
    await restoreViewport(targetPage)
  }

  return {
    start,
    stop,
    isRecording: async (opts) => {
      const { sessionId } = resolve('recording.isRecording', opts)
      return isRecording({ sessionId, relayPort })
    },
    cancel,
  }
}

/**
 * Start recording the page.
 * The recording is handled by the extension, so it survives page navigation.
 */
export async function startRecording(options: StartRecordingOptions): Promise<RecordingState> {
  const {
    sessionId,
    frameRate = 30,
    videoBitsPerSecond = 2500000,
    audioBitsPerSecond = 128000,
    audio = false,
    microphone = false,
    outputPath,
    relayPort = 19988,
  } = options

  // Resolve relative paths to absolute using the caller's cwd.
  // The relay server may have a different cwd, so we must resolve here.
  const absoluteOutputPath = path.resolve(outputPath)

  const response = await fetch(`http://127.0.0.1:${relayPort}/recording/start`, {
    method: 'POST',
    headers: recordingHeaders(),
    body: JSON.stringify({
      sessionId,
      frameRate,
      videoBitsPerSecond,
      audioBitsPerSecond,
      audio,
      microphone,
      outputPath: absoluteOutputPath,
    }),
  })

  const result = (await response.json()) as StartRecordingResult

  if (!result.success) {
    const errorMsg = result.error || 'Unknown error'

    // If the error is about missing activeTab permission, provide helpful guidance
    if (isActiveTabPermissionError(errorMsg)) {
      const restartCmd = getChromeRestartCommand()
      throw new Error(
        `Failed to start recording: ${errorMsg}\n\n` +
          `For automated recording, start a managed Playwriter browser with the bundled extension loaded:\n\n` +
          `  ${restartCmd}\n\n` +
          `Or click the Playwriter extension icon on the tab once to grant permission.`,
      )
    }

    throw new Error(`Failed to start recording: ${errorMsg}`)
  }

  return {
    isRecording: true,
    startedAt: result.startedAt,
    tabId: result.tabId,
  }
}

/**
 * Stop recording and save to file.
 * Returns the path to the saved video file.
 */
export async function stopRecording(
  options: StopRecordingOptions,
): Promise<{ path: string; duration: number; size: number }> {
  const { sessionId, relayPort = 19988 } = options

  const response = await fetch(`http://127.0.0.1:${relayPort}/recording/stop`, {
    method: 'POST',
    headers: recordingHeaders(),
    body: JSON.stringify({ sessionId }),
  })

  const result = (await response.json()) as StopRecordingResult

  if (!result.success) {
    throw new Error(`Failed to stop recording: ${result.error}`)
  }

  return { path: result.path, duration: result.duration, size: result.size }
}

/**
 * Check if recording is currently active.
 */
export async function isRecording(options: {
  sessionId?: string
  relayPort?: number
}): Promise<RecordingState> {
  const { sessionId, relayPort = 19988 } = options

  const url = new URL(`http://127.0.0.1:${relayPort}/recording/status`)
  if (sessionId) {
    url.searchParams.set('sessionId', sessionId)
  }
  // GET request — only the Authorization header matters here
  const response = await fetch(url.toString(), { headers: recordingHeaders() })
  const result = (await response.json()) as IsRecordingResult

  return { isRecording: result.isRecording, startedAt: result.startedAt, tabId: result.tabId }
}

// ============================================================================
// Live RTMP streaming (reuses the tabCapture pipeline; the relay pipes chunks
// to ffmpeg instead of writing a file). ffmpeg runs inside the relay process,
// so streams keep running after the CLI or executor call returns.
// ============================================================================

export interface StartStreamOptions extends Omit<StartStreamParams, 'sessionId'> {
  /** Target page to stream (required unless sessionId is given) */
  page?: Page
  /** CDP tab session ID (pw-tab-*) to identify which tab to stream */
  sessionId?: string
}

/** Start streaming a tab to one or more RTMP destinations. */
export async function startStream(
  options: StartStreamOptions & { relayPort?: number },
): Promise<StartStreamResult & { success: true }> {
  const { page: _page, relayPort = 19988, ...params } = options

  const response = await fetch(`http://127.0.0.1:${relayPort}/stream/start`, {
    method: 'POST',
    headers: recordingHeaders(),
    body: JSON.stringify(params),
  })

  const result = (await response.json()) as StartStreamResult

  if (!result.success) {
    const errorMsg = result.error || 'Unknown error'
    if (isActiveTabPermissionError(errorMsg)) {
      const restartCmd = getChromeRestartCommand()
      throw new Error(
        `Failed to start stream: ${errorMsg}\n\n` +
          `For automated streaming, start a managed Playwriter browser with the bundled extension loaded:\n\n` +
          `  ${restartCmd}\n\n` +
          `Or click the Playwriter extension icon on the tab once to grant permission.`,
      )
    }
    throw new Error(`Failed to start stream: ${errorMsg}`)
  }

  return result
}

/** Stop an active stream. Closes ffmpeg gracefully and waits for it to exit. */
export async function stopStream(options: {
  sessionId?: string
  relayPort?: number
}): Promise<{ duration: number; bytesReceived: number }> {
  const { sessionId, relayPort = 19988 } = options

  const response = await fetch(`http://127.0.0.1:${relayPort}/stream/stop`, {
    method: 'POST',
    headers: recordingHeaders(),
    body: JSON.stringify({ sessionId }),
  })

  const result = (await response.json()) as StopStreamResult

  if (!result.success) {
    throw new Error(`Failed to stop stream: ${result.error}`)
  }

  return { duration: result.duration, bytesReceived: result.bytesReceived }
}

/** Get status and encoder stats for the active stream (if any). */
export async function streamStatus(options: {
  sessionId?: string
  relayPort?: number
}): Promise<StreamStatusResult> {
  const { sessionId, relayPort = 19988 } = options

  const url = new URL(`http://127.0.0.1:${relayPort}/stream/status`)
  if (sessionId) {
    url.searchParams.set('sessionId', sessionId)
  }
  const response = await fetch(url.toString(), { headers: recordingHeaders() })
  return (await response.json()) as StreamStatusResult
}

/**
 * Create the `stream` API exposed in the executor sandbox. Resolves the target
 * tab's pw-tab-* sessionId from the page like the recording API does. Unlike
 * recording there is no viewport resize or max-duration timer: streams pick an
 * explicit output resolution (ffmpeg scales) and run indefinitely.
 */
export function createStreamApi(options: { relayPort: number }): {
  start: (opts: StartStreamOptions) => Promise<StartStreamResult & { success: true }>
  stop: (opts?: RecordingTargetOptions) => Promise<{ duration: number; bytesReceived: number }>
  status: (opts?: RecordingTargetOptions) => Promise<StreamStatusResult>
} {
  const { relayPort } = options

  return {
    start: async (opts) => {
      const { sessionId } = resolveTarget({ helper: 'stream.start', target: opts })
      const { page: _page, ...params } = opts
      return startStream({ ...params, sessionId, relayPort })
    },
    // Streams outlive session state (reset clears state.page), so stop/status
    // work without a target when exactly one stream is active in the relay.
    stop: async (opts) => {
      const sessionId = opts ? resolveTarget({ helper: 'stream.stop', target: opts }).sessionId : undefined
      return stopStream({ sessionId, relayPort })
    },
    status: async (opts) => {
      const sessionId = opts ? resolveTarget({ helper: 'stream.status', target: opts }).sessionId : undefined
      return streamStatus({ sessionId, relayPort })
    },
  }
}

/**
 * Cancel recording without saving.
 */
export async function cancelRecording(options: {
  sessionId?: string
  relayPort?: number
}): Promise<void> {
  const { sessionId, relayPort = 19988 } = options

  const response = await fetch(`http://127.0.0.1:${relayPort}/recording/cancel`, {
    method: 'POST',
    headers: recordingHeaders(),
    body: JSON.stringify({ sessionId }),
  })

  const result = (await response.json()) as CancelRecordingResult

  if (!result.success) {
    throw new Error(`Failed to cancel recording: ${result.error}`)
  }
}
