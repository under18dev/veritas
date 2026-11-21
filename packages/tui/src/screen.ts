import type { TuiApi } from './api.js';
import type { Hints } from './components.js';

export interface ScreenProps {
  api: TuiApi;
  /** Whether this screen receives the keyboard (the menu has it otherwise). */
  active: boolean;
  /** Return the keyboard to the menu. */
  onBack: () => void;
  /** Rows and columns of the screen panel's content. */
  height: number;
  width: number;
  /** Something changed on disk (a new run, a decision, a saved config): reload what depends on it. */
  onChange: () => void;
  version: number;
  /** Open another screen, as choosing it on the menu does. */
  navigate: (screen: ScreenKey) => void;
  /** Show these keys in the bar at the bottom while the screen has the keyboard; null shows the general ones. */
  setHints: (keys: Hints | null) => void;
}

export type ScreenKey = 'home' | 'results' | 'spec' | 'run' | 'improve' | 'settings';
