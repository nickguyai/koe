import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('widgetAPI', {
  toggleRecording: () => ipcRenderer.send('widget-toggle-recording'),
  onStateUpdate: (cb: (state: { status: string }) => void) => {
    ipcRenderer.removeAllListeners('widget-state-update');
    ipcRenderer.on('widget-state-update', (_event, state) => cb(state));
  },
});

declare global {
  interface Window {
    widgetAPI?: {
      toggleRecording: () => void;
      onStateUpdate: (cb: (state: { status: string }) => void) => void;
    };
  }
}
