import { describe, expect, it } from 'vitest';
import { RecordingStateMachine } from '../state-machine';

describe('RecordingStateMachine', () => {
  it('uses dictation states from recording to insertion completion', () => {
    const machine = new RecordingStateMachine(0);

    expect(machine.transition('hotkey_press')).toBe(true);
    expect(machine.currentState).toBe('recording');

    expect(machine.transition('hotkey_press')).toBe(true);
    expect(machine.currentState).toBe('processing');

    expect(machine.transition('transcription_complete')).toBe(true);
    expect(machine.currentState).toBe('inserting');

    expect(machine.transition('insertion_complete')).toBe(true);
    expect(machine.currentState).toBe('idle');
  });

  it('supports hotkey release to stop push-to-talk recording', () => {
    const machine = new RecordingStateMachine(0);

    expect(machine.transition('hotkey_press')).toBe(true);
    expect(machine.currentState).toBe('recording');

    expect(machine.transition('hotkey_release')).toBe(true);
    expect(machine.currentState).toBe('processing');
  });
});
