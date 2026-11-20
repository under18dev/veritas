import path from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useState } from 'react';
import type { TuiApi } from './api.js';
import { SelectList, useLoad } from './components.js';
import type { ScreenProps } from './screen.js';
import { Home } from './screens/Home.js';
import { Improve } from './screens/Improve.js';
import { Results } from './screens/Results.js';
import { RunScreen } from './screens/Run.js';
import { Settings } from './screens/Settings.js';
import { Spec } from './screens/Spec.js';

const SCREENS = [
  { key: 'home', label: 'Home' },
  { key: 'results', label: 'Results' },
  { key: 'spec', label: 'Specifications' },
  { key: 'run', label: 'Run' },
  { key: 'improve', label: 'Improve tests' },
  { key: 'settings', label: 'Settings' },
] as const;

type ScreenKey = (typeof SCREENS)[number]['key'];

const HELP = [
  'Menu: ↑/↓ or j/k to move, Enter or → to open, q to quit, ? to close this help.',
  'In a screen: ↑/↓ or j/k to move, Enter to choose, Esc to go back.',
  'Results: Enter on a run lists its findings; Enter on a finding shows its evidence.',
  'Specifications: f filters by status, d shows what changed since the previous run;',
  '  on a property, a accepts and r rejects (a reason is required).',
  'Run: choose the profile and options, then Start. Esc cancels a running run.',
  'Improve tests: create a plan (nothing is written), review it, then apply it.',
  'Settings: Enter edits a value; it is checked and you confirm the change before it is saved.',
];

function Header({ api, version }: { api: TuiApi; version: number }) {
  const latest = useLoad(() => {
    const id = api.runs()[0];

    return id ? api.readRun(id) : null;
  }, [version]);
  const run = latest.data;

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Text bold>veritas · {path.basename(api.root) || api.root}</Text>
      <Text dimColor>
        {run
          ? `latest ${run.id} · ${run.verdict ?? run.status} · exit ${run.exitCode ?? '-'} · ${run.startedAt}`
          : latest.loading
            ? 'loading…'
            : 'no run yet'}
      </Text>
    </Box>
  );
}

export function App({ api }: { api: TuiApi }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [screen, setScreen] = useState<ScreenKey>('home');
  const [focus, setFocus] = useState<'menu' | 'screen'>('menu');
  const [help, setHelp] = useState(false);
  const [version, setVersion] = useState(0);
  const rows = (stdout as NodeJS.WriteStream).rows || 24;
  const height = Math.max(5, rows - 9);

  const onBack = useCallback(() => setFocus('menu'), []);
  const onChange = useCallback(() => setVersion((v) => v + 1), []);
  const onHighlight = useCallback((item: { value: ScreenKey }) => setScreen(item.value), []);

  useInput(
    (input, key) => {
      if (input === 'q') exit();
      else if (input === '?') setHelp((h) => !h);
      else if (key.rightArrow || key.return) {
        setHelp(false);
        setFocus('screen');
      }
    },
    { isActive: focus === 'menu' },
  );

  const props: ScreenProps = { api, active: focus === 'screen', onBack, height, onChange, version };

  return (
    <Box flexDirection="column">
      <Header api={api} version={version} />
      <Box>
        <Box flexDirection="column" width={20} borderStyle="single" paddingX={1}>
          <SelectList
            items={SCREENS.map((s) => ({ label: s.label, value: s.key }))}
            active={focus === 'menu'}
            onHighlight={onHighlight}
          />
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1} minHeight={height + 2}>
          {help ? (
            HELP.map((line) => <Text key={line}>{line}</Text>)
          ) : (
            <>
              {screen === 'home' && <Home {...props} />}
              {screen === 'results' && <Results {...props} />}
              {screen === 'spec' && <Spec {...props} />}
              {screen === 'run' && <RunScreen {...props} />}
              {screen === 'improve' && <Improve {...props} />}
              {screen === 'settings' && <Settings {...props} />}
            </>
          )}
        </Box>
      </Box>
      <Text dimColor>
        {focus === 'menu'
          ? '↑↓ move · Enter open · ? help · q quit'
          : '↑↓ move · Enter choose · Esc back · (see ? on the menu for more keys)'}
      </Text>
    </Box>
  );
}
