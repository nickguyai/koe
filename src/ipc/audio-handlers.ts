import { ipcMain, shell } from 'electron';
import { getSystemAudioService } from '../system-audio-service';
import { getPermissionService } from '../permission-service';
import { IpcDependencies } from './types';

export function registerAudioHandlers(deps: IpcDependencies): void {
  ipcMain.handle('system-audio-start', async () => {
    return deps.startSystemAudioCapture();
  });

  ipcMain.handle('system-audio-stop', async () => {
    await deps.stopSystemAudioCapture();
    return true;
  });

  ipcMain.handle('system-audio-status', () => {
    const service = getSystemAudioService();
    return service.currentStatus;
  });

  ipcMain.handle('system-audio-permission-check', async () => {
    return getPermissionService().checkSystemAudioPermission();
  });

  ipcMain.handle('system-audio-permission-request', async () => {
    return getPermissionService().requestSystemAudioPermission();
  });

  ipcMain.handle('open-external', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      const allowedProtocols = new Set(['https:', 'http:', 'mailto:']);
      if (allowedProtocols.has(parsed.protocol)) {
        await shell.openExternal(url);
        return true;
      }
      console.warn('Blocked URL protocol for openExternal:', parsed.protocol);
    } catch {
      console.warn('Invalid URL for openExternal:', url);
    }
    return false;
  });
}
