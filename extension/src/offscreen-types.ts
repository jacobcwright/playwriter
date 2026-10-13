/**
 * Types for communication between background.ts and offscreen.ts.
 * These are Chrome extension internal messages, separate from the WS protocol types.
 */

// Chrome-specific MediaStreamConstraints that TypeScript doesn't know about.
// These use Chrome's proprietary tabCapture API constraints.
// See: https://developer.chrome.com/docs/extensions/reference/tabCapture/
export interface ChromeTabCaptureAudioConstraints {
  mandatory: {
    chromeMediaSource: 'tab'
    chromeMediaSourceId: string
  }
}

export interface ChromeTabCaptureVideoConstraints {
  mandatory: {
    chromeMediaSource: 'tab'
    chromeMediaSourceId: string
    minFrameRate?: number
    maxFrameRate?: number
  }
}

// Offscreen document message types
export interface OffscreenStartRecordingMessage {
  action: 'startRecording'
  tabId: number
  streamId: string
  frameRate?: number
  videoBitsPerSecond?: number
  audioBitsPerSecond?: number
  audio?: boolean
  /** Mix the microphone into the audio track (with tab audio when `audio` is set) */
  microphone?: boolean
}

// ── Narration (microphone) for the skill recorder ───────────────────────────

export interface OffscreenGetMicrophoneStateMessage {
  action: 'getMicrophoneState'
}

export interface OffscreenStartNarrationMessage {
  action: 'startNarration'
  recordingId: string
  audioBitsPerSecond?: number
}

export interface OffscreenStopNarrationMessage {
  action: 'stopNarration'
  recordingId: string
}

export interface OffscreenCancelNarrationMessage {
  action: 'cancelNarration'
  recordingId: string
}

export type OffscreenMicrophoneStateResult = {
  state: 'granted' | 'denied' | 'prompt' | 'unavailable'
  hasMicrophone?: boolean
  error?: string
}

export type OffscreenStartNarrationResult =
  | { success: true; recordingId: string; startedAt: number; mimeType: string; deviceLabel?: string }
  | {
      success: false
      reason:
        | 'permission-denied'
        | 'permission-pending'
        | 'no-microphone'
        | 'capture-failed'
        | 'unsupported'
        | 'already-active'
      error: string
    }

export type OffscreenStopNarrationResult =
  | { success: true; recordingId: string; durationMs: number }
  | { success: false; error: string }

/** Messages FROM offscreen TO background for narration */
export interface OffscreenNarrationChunkMessage {
  action: 'narrationChunk'
  recordingId: string
  dataBase64: string
}

export interface OffscreenNarrationEndedMessage {
  action: 'narrationEnded'
  recordingId: string
  reason: 'stopped' | 'cancelled' | 'device-lost' | 'error'
  error?: string
  durationMs?: number
}

export interface OffscreenStopRecordingMessage {
  action: 'stopRecording'
  tabId: number
}

export interface OffscreenIsRecordingMessage {
  action: 'isRecording'
  tabId: number
}

export interface OffscreenCancelRecordingMessage {
  action: 'cancelRecording'
  tabId: number
}

export interface OffscreenCopyTextMessage {
  action: 'copyText'
  text: string
}

export type OffscreenMessage =
  | OffscreenStartRecordingMessage
  | OffscreenStopRecordingMessage
  | OffscreenIsRecordingMessage
  | OffscreenCancelRecordingMessage
  | OffscreenCopyTextMessage
  | OffscreenGetMicrophoneStateMessage
  | OffscreenStartNarrationMessage
  | OffscreenStopNarrationMessage
  | OffscreenCancelNarrationMessage

// Offscreen document response types
export type OffscreenStartRecordingResult =
  | {
      success: true
      tabId: number
      startedAt: number
      mimeType: string
    }
  | {
      success: false
      error: string
    }

export type OffscreenStopRecordingResult =
  | {
      success: true
      tabId: number
      duration: number
    }
  | {
      success: false
      error: string
    }

export interface OffscreenIsRecordingResult {
  isRecording: boolean
  tabId: number
  startedAt?: number
}

export type OffscreenCancelRecordingResult =
  | {
      success: true
      tabId: number
    }
  | {
      success: false
      error: string
    }

export type OffscreenCopyTextResult = { success: true } | { success: false; error: string }

// Messages sent FROM offscreen TO background
export interface OffscreenRecordingChunkMessage {
  action: 'recordingChunk'
  tabId: number
  dataBase64?: string
  final?: boolean
}

export interface OffscreenRecordingCancelledMessage {
  action: 'recordingCancelled'
  tabId: number
}

export type OffscreenOutgoingMessage =
  | OffscreenRecordingChunkMessage
  | OffscreenRecordingCancelledMessage
  | OffscreenNarrationChunkMessage
  | OffscreenNarrationEndedMessage
