/**
 * Offscreen document for screen recording and extension-owned clipboard writes.
 *
 * WHY OFFSCREEN DOCUMENT?
 * Manifest V3 service workers cannot use MediaRecorder or getUserMedia directly.
 * This hidden document provides media and clipboard Web APIs while the service worker orchestrates.
 *
 * RECORDING FLOW:
 *
 * ┌─────────────────┐     HTTP      ┌─────────────────┐    WebSocket    ┌─────────────────┐
 * │  User Code      │ ────────────► │  Relay Server   │ ───────────────►│  Extension      │
 * │  startRecording │               │  /recording/*   │                 │  background.ts  │
 * └─────────────────┘               └─────────────────┘                 └────────┬────────┘
 *                                                                                │
 *                                          ┌─────────────────────────────────────┘
 *                                          ▼
 *                                   ┌─────────────────┐
 *                                   │  Offscreen Doc  │  ◄── MediaRecorder
 *                                   │  (this file)    │
 *                                   └─────────────────┘
 *
 * STEP BY STEP:
 * 1. User calls startRecording() → HTTP POST to relay server
 * 2. Relay server forwards to extension via WebSocket
 * 3. Extension calls chrome.tabCapture.getMediaStreamId() to get capture permission
 *    - Requires --allowlisted-extension-id flag OR user clicking extension icon
 * 4. Extension creates this offscreen document via chrome.offscreen.createDocument()
 * 5. Extension sends streamId to offscreen document
 * 6. Offscreen calls navigator.mediaDevices.getUserMedia() with streamId
 * 7. Offscreen creates MediaRecorder and starts encoding to mp4
 * 8. Chunks are sent back to extension → relay server → written to output file
 *
 * KEY APIS:
 * - chrome.tabCapture.getMediaStreamId() - Extension API, gets capture permission
 * - chrome.offscreen.createDocument()    - Extension API, creates this document
 * - navigator.mediaDevices.getUserMedia() - Web API, gets MediaStream from streamId
 * - MediaRecorder                         - Web API, encodes video to mp4
 */

import type {
  OffscreenMessage,
  OffscreenStartRecordingMessage,
  OffscreenStopRecordingMessage,
  OffscreenIsRecordingMessage,
  OffscreenCancelRecordingMessage,
  OffscreenCopyTextMessage,
  OffscreenStartRecordingResult,
  OffscreenStopRecordingResult,
  OffscreenIsRecordingResult,
  OffscreenCancelRecordingResult,
  OffscreenCopyTextResult,
  OffscreenGetMicrophoneStateMessage,
  OffscreenStartNarrationMessage,
  OffscreenStopNarrationMessage,
  OffscreenCancelNarrationMessage,
  OffscreenMicrophoneStateResult,
  OffscreenStartNarrationResult,
  OffscreenStopNarrationResult,
  OffscreenNarrationEndedMessage,
  ChromeTabCaptureAudioConstraints,
  ChromeTabCaptureVideoConstraints,
} from './offscreen-types'

interface OffscreenRecordingState {
  recorder: MediaRecorder
  stream: MediaStream
  startedAt: number
  tabId: number
  chunkChain: Promise<void>
  cancelled: boolean
  /** Extra tracks/contexts to release on stop (microphone, mixer) */
  release: () => void
}

/**
 * Narration = the user's microphone, recorded while the skill recorder runs.
 * Keyed by the relay's recording id. The offscreen document cannot show the
 * permission prompt: a visible extension page (microphone.html) must have
 * obtained it first. Here getUserMedia either succeeds silently or throws.
 */
interface OffscreenNarrationState {
  recordingId: string
  recorder: MediaRecorder
  stream: MediaStream
  startedAt: number
  chunkChain: Promise<void>
  ended: boolean
  endReason: OffscreenNarrationEndedMessage['reason'] | null
}

const narrations = new Map<string, OffscreenNarrationState>()
const NARRATION_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

// Map of tabId -> recording state for concurrent recording support
const recordings = new Map<number, OffscreenRecordingState>()
const OFFSCREEN_ACTIONS = new Set<OffscreenMessage['action']>([
  'startRecording',
  'stopRecording',
  'isRecording',
  'cancelRecording',
  'copyText',
  'getMicrophoneState',
  'startNarration',
  'stopNarration',
  'cancelNarration',
])

type OffscreenResult =
  | OffscreenStartRecordingResult
  | OffscreenStopRecordingResult
  | OffscreenIsRecordingResult
  | OffscreenCancelRecordingResult
  | OffscreenCopyTextResult
  | OffscreenMicrophoneStateResult
  | OffscreenStartNarrationResult
  | OffscreenStopNarrationResult

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (!OFFSCREEN_ACTIONS.has(message.action)) {
    return false
  }
  void handleMessage(message).then(sendResponse)
  return true // Keep channel open for async response
})

async function handleMessage(message: OffscreenMessage): Promise<OffscreenResult> {
  switch (message.action) {
    case 'startRecording':
      return handleStartRecording(message)
    case 'stopRecording':
      return handleStopRecording(message)
    case 'isRecording':
      return handleIsRecording(message)
    case 'cancelRecording':
      return handleCancelRecording(message)
    case 'copyText':
      return handleCopyText(message)
    case 'getMicrophoneState':
      return handleGetMicrophoneState(message)
    case 'startNarration':
      return handleStartNarration(message)
    case 'stopNarration':
      return handleStopNarration(message)
    case 'cancelNarration':
      return handleCancelNarration(message)
  }
}

// ── Microphone helpers ──────────────────────────────────────────────────────

async function handleGetMicrophoneState(
  _message: OffscreenGetMicrophoneStateMessage,
): Promise<OffscreenMicrophoneStateResult> {
  return getMicrophoneState()
}

async function getMicrophoneState(): Promise<OffscreenMicrophoneStateResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { state: 'unavailable', error: 'getUserMedia is not available in this browser' }
  }
  const hasMicrophone = await (async (): Promise<boolean | undefined> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.some((device) => {
        return device.kind === 'audioinput'
      })
    } catch {
      return undefined
    }
  })()
  try {
    // 'microphone' is a valid PermissionName in Chrome; TS lib types lag behind
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return { state: status.state, hasMicrophone }
  } catch (error) {
    return { state: 'unavailable', hasMicrophone, error: error instanceof Error ? error.message : String(error) }
  }
}

type NarrationFailure = Extract<OffscreenStartNarrationResult, { success: false }>

function classifyGetUserMediaError(error: unknown): { reason: NarrationFailure['reason']; message: string } {
  const name = error instanceof DOMException ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { reason: 'permission-denied', message: `Microphone permission denied: ${message}` }
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { reason: 'no-microphone', message: 'No microphone found' }
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return { reason: 'capture-failed', message: `Microphone is busy or unreadable: ${message}` }
  }
  return { reason: 'capture-failed', message }
}

async function openMicrophone(): Promise<
  { stream: MediaStream } | { error: ReturnType<typeof classifyGetUserMediaError> }
> {
  const state = await getMicrophoneState()
  if (state.state === 'denied') {
    return {
      error: { reason: 'permission-denied', message: 'Microphone permission is blocked for the Playwriter extension' },
    }
  }
  if (state.state === 'prompt') {
    // The offscreen document cannot prompt. The background opens microphone.html
    // first; if we still get here the user has not answered yet.
    return {
      error: {
        reason: 'permission-pending',
        message: 'Microphone permission has not been granted yet. Allow it in the Playwriter microphone tab.',
      },
    }
  }
  if (state.hasMicrophone === false) {
    return { error: { reason: 'no-microphone', message: 'No microphone found' } }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    return { stream }
  } catch (error) {
    return { error: classifyGetUserMediaError(error) }
  }
}

function pickNarrationMimeType(): string | null {
  for (const candidate of NARRATION_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate
    }
  }
  return null
}

// ── Narration lifecycle ─────────────────────────────────────────────────────

async function handleStartNarration(params: OffscreenStartNarrationMessage): Promise<OffscreenStartNarrationResult> {
  const { recordingId } = params
  if (narrations.has(recordingId)) {
    return { success: false, reason: 'already-active', error: `Narration already active for recording ${recordingId}` }
  }
  if (typeof MediaRecorder === 'undefined') {
    return { success: false, reason: 'unsupported', error: 'MediaRecorder is not available' }
  }
  const mimeType = pickNarrationMimeType()
  if (!mimeType) {
    return { success: false, reason: 'unsupported', error: 'No supported audio MIME type for MediaRecorder' }
  }
  const opened = await openMicrophone()
  if ('error' in opened) {
    return { success: false, reason: opened.error.reason, error: opened.error.message }
  }
  const { stream } = opened
  const track = stream.getAudioTracks()[0]
  if (!track) {
    stream.getTracks().forEach((t) => {
      t.stop()
    })
    return { success: false, reason: 'no-microphone', error: 'Microphone stream has no audio track' }
  }
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: params.audioBitsPerSecond || 48000 })
  } catch (error) {
    stream.getTracks().forEach((t) => {
      t.stop()
    })
    return { success: false, reason: 'capture-failed', error: error instanceof Error ? error.message : String(error) }
  }
  const narration: OffscreenNarrationState = {
    recordingId,
    recorder,
    stream,
    startedAt: 0,
    chunkChain: Promise.resolve(),
    ended: false,
    endReason: null,
  }
  narrations.set(recordingId, narration)

  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) {
      return
    }
    narration.chunkChain = narration.chunkChain
      .then(async () => {
        const result = await chrome.runtime.sendMessage({
          action: 'narrationChunk',
          recordingId,
          dataBase64: await blobToBase64(event.data),
        })
        if (result?.success === false) {
          throw new Error(result.error || 'Could not send narration chunk')
        }
      })
      .catch((error) => {
        console.error(`Failed to send narration chunk for recording ${recordingId}:`, error)
        void endNarration(recordingId, {
          reason: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }
  recorder.onerror = (event: Event) => {
    const error = (event as ErrorEvent).error
    console.error(`Narration MediaRecorder error for recording ${recordingId}:`, error)
    void endNarration(recordingId, { reason: 'error', error: error instanceof Error ? error.message : String(error) })
  }
  // Microphone unplugged / revoked mid-recording: keep what we have.
  track.onended = () => {
    void endNarration(recordingId, { reason: 'device-lost', error: 'Microphone track ended' })
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Narration MediaRecorder failed to start within 5 seconds'))
      }, 5000)
      recorder.onstart = () => {
        clearTimeout(timeout)
        narration.startedAt = Date.now()
        resolve()
      }
      // 1 second chunks: small enough to stream, large enough to stay cheap
      recorder.start(1000)
    })
  } catch (error) {
    releaseNarration(narration)
    narrations.delete(recordingId)
    return { success: false, reason: 'capture-failed', error: error instanceof Error ? error.message : String(error) }
  }
  console.log(`Narration started for recording ${recordingId} (${mimeType})`)
  return {
    success: true,
    recordingId,
    startedAt: narration.startedAt,
    mimeType: recorder.mimeType || mimeType,
    deviceLabel: track.label || undefined,
  }
}

function releaseNarration(narration: OffscreenNarrationState): void {
  // Releasing the tracks is what turns Chrome's microphone indicator off.
  narration.stream.getTracks().forEach((track) => {
    track.onended = null
    track.stop()
  })
}

/** Stop the recorder, flush the last chunk, tell the background it ended. */
async function endNarration(
  recordingId: string,
  params: { reason: OffscreenNarrationEndedMessage['reason']; error?: string },
): Promise<{ durationMs: number } | null> {
  const narration = narrations.get(recordingId)
  if (!narration || narration.ended) {
    return null
  }
  narration.ended = true
  narration.endReason = params.reason
  narrations.delete(recordingId)
  const { recorder } = narration
  if (params.reason === 'stopped' || params.reason === 'device-lost') {
    // Graceful: wait for the final dataavailable + onstop so no audio is lost
    await new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') {
        resolve()
        return
      }
      const timeout = setTimeout(resolve, 5000)
      recorder.onstop = () => {
        clearTimeout(timeout)
        resolve()
      }
      try {
        recorder.stop()
      } catch {
        clearTimeout(timeout)
        resolve()
      }
    })
    await narration.chunkChain.catch(() => {})
  } else {
    // Cancelled or errored: drop pending chunks, stop immediately
    try {
      if (recorder.state !== 'inactive') {
        recorder.ondataavailable = null
        recorder.stop()
      }
    } catch {}
  }
  releaseNarration(narration)
  const durationMs = narration.startedAt ? Math.max(0, Date.now() - narration.startedAt) : 0
  const ended: OffscreenNarrationEndedMessage = {
    action: 'narrationEnded',
    recordingId,
    reason: params.reason,
    error: params.error,
    durationMs,
  }
  try {
    await chrome.runtime.sendMessage(ended)
  } catch (error) {
    console.error('Could not report narration end:', error)
  }
  console.log(`Narration ended for recording ${recordingId}: ${params.reason}`)
  return { durationMs }
}

async function handleStopNarration(params: OffscreenStopNarrationMessage): Promise<OffscreenStopNarrationResult> {
  const narration = narrations.get(params.recordingId)
  if (!narration) {
    return { success: false, error: `No active narration for recording ${params.recordingId}` }
  }
  const result = await endNarration(params.recordingId, { reason: 'stopped' })
  return { success: true, recordingId: params.recordingId, durationMs: result?.durationMs ?? 0 }
}

async function handleCancelNarration(params: OffscreenCancelNarrationMessage): Promise<{ success: true }> {
  await endNarration(params.recordingId, { reason: 'cancelled' })
  return { success: true }
}

// Mix the microphone into a tab-capture stream. Returns a new stream with the
// tab's video track plus one mixed audio track, and a release() that stops the
// mic and closes the mixer. Tab audio keeps its existing behavior (it is not
// routed back to the speakers, same as before).
async function mixMicrophoneInto(
  stream: MediaStream,
): Promise<{ stream: MediaStream; release: () => void } | { error: string }> {
  const opened = await openMicrophone()
  if ('error' in opened) {
    return { error: opened.error.message }
  }
  const mic = opened.stream
  const tabAudio = stream.getAudioTracks()
  if (tabAudio.length === 0) {
    const mixed = new MediaStream([...stream.getVideoTracks(), ...mic.getAudioTracks()])
    return {
      stream: mixed,
      release: () => {
        mic.getTracks().forEach((track) => {
          track.stop()
        })
      },
    }
  }
  const audioContext = new AudioContext()
  const destination = audioContext.createMediaStreamDestination()
  audioContext.createMediaStreamSource(new MediaStream(tabAudio)).connect(destination)
  audioContext.createMediaStreamSource(mic).connect(destination)
  const mixed = new MediaStream([...stream.getVideoTracks(), ...destination.stream.getAudioTracks()])
  return {
    stream: mixed,
    release: () => {
      mic.getTracks().forEach((track) => {
        track.stop()
      })
      void audioContext.close().catch(() => {})
    },
  }
}

async function handleCopyText(message: OffscreenCopyTextMessage): Promise<OffscreenCopyTextResult> {
  try {
    const textarea = document.querySelector<HTMLTextAreaElement>('#clipboard-text')
    if (!textarea) {
      return { success: false, error: 'Clipboard textarea is missing' }
    }
    textarea.value = message.text
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.value = ''
    if (!copied) {
      return { success: false, error: 'Clipboard copy command failed' }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function handleStartRecording(params: OffscreenStartRecordingMessage): Promise<OffscreenStartRecordingResult> {
  const { tabId } = params
  let stream: MediaStream | null = null

  if (recordings.has(tabId)) {
    return { success: false, error: `Recording already in progress for tab ${tabId}` }
  }

  try {
    // Build Chrome-specific tabCapture constraints
    // These use Chrome's proprietary API that TypeScript doesn't have built-in types for
    const audioConstraints: ChromeTabCaptureAudioConstraints | false = params.audio
      ? {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: params.streamId,
          },
        }
      : false

    const videoConstraints: ChromeTabCaptureVideoConstraints = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: params.streamId,
        minFrameRate: params.frameRate || 30,
        maxFrameRate: params.frameRate || 30,
      },
    }

    // Get media stream from the streamId provided by tabCapture.getMediaStreamId
    // Cast to MediaStreamConstraints since Chrome accepts the extended constraints
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints,
    } as MediaStreamConstraints)

    let release = () => {}
    let recordedStream: MediaStream = stream
    if (params.microphone) {
      const mixed = await mixMicrophoneInto(stream)
      if ('error' in mixed) {
        throw new Error(`Could not add microphone to the recording: ${mixed.error}`)
      }
      recordedStream = mixed.stream
      release = mixed.release
    }

    const recorder = new MediaRecorder(recordedStream, {
      mimeType: 'video/mp4',
      videoBitsPerSecond: params.videoBitsPerSecond || 2500000,
      audioBitsPerSecond: params.audioBitsPerSecond || 128000,
    })

    const startedAt = Date.now()
    const recording: OffscreenRecordingState = {
      recorder,
      stream,
      startedAt,
      tabId,
      chunkChain: Promise.resolve(),
      cancelled: false,
      release,
    }
    recordings.set(tabId, recording)

    // Send chunks to service worker - each chunk includes tabId for routing
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) {
        return
      }
      recording.chunkChain = recording.chunkChain
        .then(async () => {
          if (recording.cancelled) {
            return
          }
          const result = await chrome.runtime.sendMessage({
            action: 'recordingChunk',
            tabId,
            dataBase64: await blobToBase64(event.data),
          })
          if (result?.success === false) {
            throw new Error(result.error || 'Could not send recording chunk')
          }
        })
        .catch((error) => {
          console.error(`Failed to send recording chunk for tab ${tabId}:`, error)
          handleCancelRecordingForTab(tabId)
        })
    }

    recorder.onerror = (event: Event) => {
      console.error(`MediaRecorder error for tab ${tabId}:`, (event as ErrorEvent).error)
      handleCancelRecordingForTab(tabId)
    }

    recorder.onstop = () => {
      console.log(`MediaRecorder stopped for tab ${tabId}`)
    }

    // Wait for MediaRecorder to actually start before returning.
    // This ensures the encoder is initialized and ready to capture frames.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MediaRecorder failed to start within 5 seconds'))
      }, 5000)

      recorder.onstart = () => {
        clearTimeout(timeout)
        console.log(`MediaRecorder started for tab ${tabId}`)
        resolve()
      }

      // Start with 1 second chunks
      recorder.start(1000)
    })

    return { success: true, tabId, startedAt, mimeType: recorder.mimeType || 'video/mp4' }
  } catch (error: any) {
    stream?.getTracks().map((track) => {
      track.stop()
    })
    recordings.delete(tabId)
    console.error(`Failed to start recording for tab ${tabId}:`, error)
    return { success: false, error: error.message }
  }
}

async function handleStopRecording(params: OffscreenStopRecordingMessage): Promise<OffscreenStopRecordingResult> {
  const { tabId } = params
  const recording = recordings.get(tabId)

  if (!recording) {
    return { success: false, error: `No active recording for tab ${tabId}` }
  }

  try {
    const { recorder, stream, startedAt } = recording

    // Stop recorder and wait for final data
    await new Promise<void>((resolve) => {
      const originalOnStop = recorder.onstop
      recorder.onstop = (event: Event) => {
        if (originalOnStop) {
          originalOnStop.call(recorder, event)
        }
        resolve()
      }
      if (recorder.state !== 'inactive') {
        recorder.stop()
      } else {
        resolve()
      }
    })
    await recording.chunkChain

    const duration = Date.now() - startedAt

    // Send final marker
    await chrome.runtime.sendMessage({
      action: 'recordingChunk',
      tabId,
      final: true,
    })

    return { success: true, tabId, duration }
  } catch (error: any) {
    console.error(`Failed to stop recording for tab ${tabId}:`, error)
    return { success: false, error: error.message }
  } finally {
    recording.stream.getTracks().forEach((track) => {
      track.stop()
    })
    recording.release()
    recordings.delete(tabId)
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Could not encode recording chunk'))
        return
      }
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => {
      reject(reader.error || new Error('Could not read recording chunk'))
    }
    reader.readAsDataURL(blob)
  })
}

function handleIsRecording(params: OffscreenIsRecordingMessage): OffscreenIsRecordingResult {
  const { tabId } = params
  const recording = recordings.get(tabId)

  if (!recording) {
    return { isRecording: false, tabId }
  }

  return {
    isRecording: recording.recorder?.state === 'recording',
    tabId,
    startedAt: recording.startedAt,
  }
}

function handleCancelRecording(params: OffscreenCancelRecordingMessage): OffscreenCancelRecordingResult {
  const { tabId } = params
  return handleCancelRecordingForTab(tabId)
}

// Helper function to cancel recording for a specific tab - used by error handlers too
function handleCancelRecordingForTab(tabId: number): OffscreenCancelRecordingResult {
  const recording = recordings.get(tabId)

  if (!recording) {
    return { success: true, tabId }
  }

  try {
    const { recorder, stream } = recording
    recording.cancelled = true

    if (recorder.state !== 'inactive') {
      recorder.stop()
    }
    stream.getTracks().forEach((track) => {
      track.stop()
    })
    recording.release()

    void chrome.runtime.sendMessage({
      action: 'recordingCancelled',
      tabId,
    })

    recordings.delete(tabId)

    return { success: true, tabId }
  } catch (error: any) {
    console.error(`Failed to cancel recording for tab ${tabId}:`, error)
    return { success: false, error: error.message }
  }
}

console.log('Playwriter offscreen document loaded')
