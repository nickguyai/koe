import { IpcDependencies } from './types';
import { registerSettingsHandlers } from './settings-handlers';
import { registerJobHandlers } from './job-handlers';
import { registerRealtimeHandlers } from './realtime-handlers';
import { registerAudioHandlers } from './audio-handlers';

export function registerAllHandlers(deps: IpcDependencies): void {
  registerSettingsHandlers(deps);
  registerJobHandlers(deps);
  registerRealtimeHandlers(deps);
  registerAudioHandlers(deps);
}

export type { IpcDependencies } from './types';
