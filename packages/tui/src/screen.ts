import type { TuiApi } from './api.js';

export interface ScreenProps {
  api: TuiApi;
  /** Whether this screen receives the keyboard (the menu has it otherwise). */
  active: boolean;
  /** Return the keyboard to the menu. */
  onBack: () => void;
  height: number;
  /** Something changed on disk (a new run, a decision, a saved config): reload what depends on it. */
  onChange: () => void;
  version: number;
}
