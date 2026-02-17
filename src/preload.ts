import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type MeetingEventChannel = 'meeting-mode-suggestion' | 'meeting-mode-updated';
type MeetingEventHandler = (_event: IpcRendererEvent, payload: any) => void;

const meetingEventHandlers: Partial<Record<MeetingEventChannel, MeetingEventHandler>> = {};

function registerSingleMeetingEventHandler(
  channel: MeetingEventChannel,
  callback: (payload: any) => void,
): () => void {
  const existingHandler = meetingEventHandlers[channel];
  if (existingHandler) {
    ipcRenderer.removeListener(channel, existingHandler);
  }

  const handler: MeetingEventHandler = (_event, payload) => callback(payload);
  meetingEventHandlers[channel] = handler;
  ipcRenderer.on(channel, handler);

  return () => {
    const currentHandler = meetingEventHandlers[channel];
    if (currentHandler === handler) {
      delete meetingEventHandlers[channel];
    }
    ipcRenderer.removeListener(channel, handler);
  };
}

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Recording control
  onStartRecording: (callback: () => void) => {
    ipcRenderer.on('start-recording', callback);
  },
  onStopRecording: (callback: () => void) => {
    ipcRenderer.on('stop-recording', callback);
  },
  onResetRecordingState: (callback: () => void) => {
    ipcRenderer.on('reset-recording-state', callback);
  },
  
  // Send transcription result to main process
  sendTranscriptionComplete: (text: string) => {
    ipcRenderer.send('transcription-complete', text);
  },
  sendTranscriptionError: (error: string) => {
    ipcRenderer.send('transcription-error', error);
  },
  
  // Hotkey release (for push-to-talk mode)
  sendHotkeyRelease: () => {
    ipcRenderer.send('hotkey-release');
  },
  
  // Get recording state
  getRecordingState: () => {
    return ipcRenderer.invoke('get-recording-state');
  },
  
  // Hotkey configuration
  getHotkey: () => {
    return ipcRenderer.invoke('get-hotkey');
  },
  updateHotkey: (accelerator: string) => {
    return ipcRenderer.invoke('update-hotkey', accelerator);
  },
  setMeetingMode: (enabled: boolean) => {
    return ipcRenderer.invoke('set-meeting-mode', enabled);
  },
  getMeetingMode: () => {
    return ipcRenderer.invoke('get-meeting-mode');
  },
  dismissMeetingModeSuggestion: (payload: { appName?: string; dontAskAgain?: boolean }) => {
    return ipcRenderer.invoke('meeting-mode-suggestion-dismiss', payload || {});
  },
  switchMeetingModeSuggestion: (payload: { appName?: string; dontAskAgain?: boolean }) => {
    return ipcRenderer.invoke('meeting-mode-suggestion-switch', payload || {});
  },
  onMeetingModeSuggestion: (callback: (payload: any) => void) => {
    return registerSingleMeetingEventHandler('meeting-mode-suggestion', callback);
  },
  onMeetingModeUpdated: (callback: (payload: any) => void) => {
    return registerSingleMeetingEventHandler('meeting-mode-updated', callback);
  },

  // Open URL in default browser
  openExternal: (url: string) => {
    return ipcRenderer.invoke('open-external', url);
  },

  // Settings and jobs
  getSettings: () => {
    return ipcRenderer.invoke('get-settings');
  },
  setSettings: (settings: Record<string, unknown>) => {
    return ipcRenderer.invoke('set-settings', settings);
  },
  rememberSpeakerLabel: (payload: { speakerKey: string; label: string }) => {
    return ipcRenderer.invoke('speaker-label-remember', payload);
  },
  listTranscriptionJobs: () => {
    return ipcRenderer.invoke('transcription-job-list');
  },
  getTranscriptionJob: (jobId: string) => {
    return ipcRenderer.invoke('transcription-job-get', jobId);
  },
  retranscribeJob: (jobId: string) => {
    return ipcRenderer.invoke('transcription-job-retranscribe', jobId);
  },
  getJobAudio: (jobId: string) => {
    return ipcRenderer.invoke('transcription-job-audio', jobId);
  },
  enqueueTranscriptionJob: (payload: { path?: string; name?: string; bytes?: ArrayBuffer }) => {
    return ipcRenderer.invoke('transcription-job-enqueue', payload);
  },
  saveLiveTranscription: (payload: { text: string; title?: string; summary?: string; provider?: string; audioBytes?: ArrayBuffer; duration?: string; meetingMode?: boolean; meetingNotes?: Record<string, unknown> }) => {
    return ipcRenderer.invoke('transcription-job-save', payload);
  },
  saveLiveAudio: (payload: { audioBytes: ArrayBuffer; duration?: string; provider?: string }) => {
    return ipcRenderer.invoke('live-audio-save', payload);
  },
  completeLiveAudioJob: (payload: { jobId: string; text: string; title?: string; summary?: string; meetingMode?: boolean; meetingNotes?: Record<string, unknown> }) => {
    return ipcRenderer.invoke('live-audio-complete', payload);
  },
  polishTranscriptionJob: (payload: { jobId: string; style?: string; customPrompt?: string }) => {
    return ipcRenderer.invoke('transcription-job-polish', payload);
  },
  deleteTranscriptionJob: (jobId: string) => {
    return ipcRenderer.invoke('transcription-job-delete', jobId);
  },
  exportTranscriptionJob: (jobId: string) => {
    return ipcRenderer.invoke('transcription-job-export', jobId);
  },
  shareMeetingToNotion: (payload: { jobId: string }) => {
    return ipcRenderer.invoke('transcription-job-share-notion', payload);
  },
  updateActionItems: (payload: { jobId: string; completedItems: number[] }) => {
    return ipcRenderer.invoke('transcription-job-update-action-items', payload);
  },
  generateMeetingNotes: (jobId: string) => {
    return ipcRenderer.invoke('generate-meeting-notes', jobId);
  },

  // OpenAI realtime
  openAIRealtimeStart: (options?: { meetingMode?: boolean }) => {
    return ipcRenderer.invoke('openai-realtime-start', options || {});
  },
  openAIRealtimeStop: (options?: { meetingMode?: boolean }) => {
    return ipcRenderer.invoke('openai-realtime-stop', options || {});
  },
  openAIRealtimeDisconnect: () => {
    return ipcRenderer.invoke('openai-realtime-disconnect');
  },
  openAIRealtimeSendAudio: (audio: ArrayBuffer) => {
    ipcRenderer.send('openai-realtime-audio', audio);
  },
  startSystemAudioCapture: () => {
    return ipcRenderer.invoke('system-audio-start');
  },
  stopSystemAudioCapture: () => {
    return ipcRenderer.invoke('system-audio-stop');
  },
  getSystemAudioStatus: () => {
    return ipcRenderer.invoke('system-audio-status');
  },
  checkSystemAudioPermission: () => {
    return ipcRenderer.invoke('system-audio-permission-check');
  },
  requestSystemAudioPermission: () => {
    return ipcRenderer.invoke('system-audio-permission-request');
  },
  onOpenAIRealtimeEvent: (callback: (payload: any) => void) => {
    ipcRenderer.on('openai-realtime-event', (_event, payload) => callback(payload));
  },
});

// Type definitions for the exposed API
declare global {
  interface Window {
    electronAPI?: {
      onStartRecording: (callback: () => void) => void;
      onStopRecording: (callback: () => void) => void;
      onResetRecordingState: (callback: () => void) => void;
      sendTranscriptionComplete: (text: string) => void;
      sendTranscriptionError: (error: string) => void;
      sendHotkeyRelease: () => void;
      getRecordingState: () => Promise<{ state: string; isRecording: boolean; duration: number }>;
      getHotkey: () => Promise<{ accelerator: string; enabled: boolean }>;
      updateHotkey: (accelerator: string) => Promise<boolean>;
      setMeetingMode: (enabled: boolean) => Promise<boolean>;
      getMeetingMode: () => Promise<boolean>;
      dismissMeetingModeSuggestion: (payload: { appName?: string; dontAskAgain?: boolean }) => Promise<boolean>;
      switchMeetingModeSuggestion: (payload: { appName?: string; dontAskAgain?: boolean }) => Promise<boolean>;
      onMeetingModeSuggestion: (callback: (payload: any) => void) => () => void;
      onMeetingModeUpdated: (callback: (payload: any) => void) => () => void;
      openExternal: (url: string) => Promise<boolean>;
      getSettings: () => Promise<Record<string, unknown>>;
      setSettings: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
      rememberSpeakerLabel: (payload: { speakerKey: string; label: string }) => Promise<{ speakerKey: string; label: string; speakerLabels: Record<string, string> }>;
      listTranscriptionJobs: () => Promise<any[]>;
      getTranscriptionJob: (jobId: string) => Promise<any>;
      retranscribeJob: (jobId: string) => Promise<any>;
      getJobAudio: (jobId: string) => Promise<{ data: ArrayBuffer; mimeType: string } | null>;
      enqueueTranscriptionJob: (payload: { path?: string; name?: string; bytes?: ArrayBuffer }) => Promise<any>;
      saveLiveTranscription: (payload: { text: string; title?: string; summary?: string; provider?: string; audioBytes?: ArrayBuffer; duration?: string; meetingMode?: boolean; meetingNotes?: Record<string, unknown> }) => Promise<any>;
      saveLiveAudio: (payload: { audioBytes: ArrayBuffer; duration?: string; provider?: string }) => Promise<any>;
      completeLiveAudioJob: (payload: { jobId: string; text: string; title?: string; summary?: string; meetingMode?: boolean; meetingNotes?: Record<string, unknown> }) => Promise<any>;
      polishTranscriptionJob: (payload: { jobId: string; style?: string; customPrompt?: string }) => Promise<any>;
      deleteTranscriptionJob: (jobId: string) => Promise<{ deleted: boolean }>;
      exportTranscriptionJob: (jobId: string) => Promise<{ title: string; markdown: string; filename: string }>;
      shareMeetingToNotion: (payload: { jobId: string }) => Promise<{ ok: boolean; toolName?: string; pageId?: string; pageUrl?: string; message?: string }>;
      updateActionItems: (payload: { jobId: string; completedItems: number[] }) => Promise<{ completedItems: number[]; updated_at: string }>;
      generateMeetingNotes: (jobId: string) => Promise<{ meeting_notes: Record<string, unknown>; updated_at: string } | null>;
      openAIRealtimeStart: (options?: { meetingMode?: boolean }) => Promise<boolean>;
      openAIRealtimeStop: (options?: { meetingMode?: boolean }) => Promise<boolean | { transcript?: string }>;
      openAIRealtimeDisconnect: () => Promise<boolean>;
      openAIRealtimeSendAudio: (audio: ArrayBuffer) => void;
      startSystemAudioCapture: () => Promise<boolean>;
      stopSystemAudioCapture: () => Promise<boolean>;
      getSystemAudioStatus: () => Promise<string>;
      checkSystemAudioPermission: () => Promise<string>;
      requestSystemAudioPermission: () => Promise<boolean>;
      onOpenAIRealtimeEvent: (callback: (payload: any) => void) => void;
    };
  }
}
