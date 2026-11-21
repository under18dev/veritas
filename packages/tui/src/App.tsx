import path from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useState } from 'react';
import type { TuiApi } from './api.js';
import { Badge, type Hints, ScrollView, SelectList, useLoad, verdictColor } from './components.js';
import type { ScreenKey, ScreenProps } from './screen.js';
import { Home } from './screens/Home.js';
import { Improve } from './screens/Improve.js';
import { Results } from './screens/Results.js';
import { RunScreen } from './screens/Run.js';
import { Settings } from './screens/Settings.js';
import { Spec } from './screens/Spec.js';

const SCREENS: { key: ScreenKey; label: string; about: string }[] = [
  { key: 'home', label: 'Home', about: 'project, configuration and tools' },
  { key: 'results', label: 'Results', about: 'past runs, findings and their evidence' },
  { key: 'spec', label: 'Specifications', about: 'review and accept or reject properties' },
  { key: 'run', label: 'Run', about: 'run Veritas and watch it work' },
  { key: 'improve', label: 'Improve tests', about: 'plan and apply test-only changes' },
  { key: 'settings', label: 'Settings', about: 'edit .veritas/config.json' },
];
// One array for every render, so the menu reports a highlight only when it moves.
const MENU = SCREENS.map((s, i) => ({ label: `${i + 1} ${s.label}`, value: s.key }));

const HELP = [
  'Menu: ↑/↓ or j/k to move, Enter or → to open, 1-6 to open a screen directly, q to quit, ? to close this help.',
  'In a screen: ↑/↓ or j/k to move, Enter to choose, Esc to go back. The bar at the bottom lists the keys.',
  'Home: the project, the latest run, the tools and what to do next; 2-6 open the screen a next step names.',
  'Results: Enter on a run shows its stages and findings, most severe first; Enter on a finding shows its',
  '  evidence and, separately, the suggested next actions.',
  'Specifications: f filters by status, d shows what changed since the previous run;',
  '  on a property, a accepts and r rejects (a reason is required).',
  'Run: choose the profile and options, then Start. The stages and a live activity log show it working;',
  '  Esc cancels a running run, and Enter on the result opens Results.',
  'Improve tests: create a plan (nothing is written), review it, then apply it.',
  'Settings: Enter opens a section and changes a value (Enter or Space toggles a switch, a list of choices',
  '  opens for others); r resets it to the default. s shows the changes and saves them after you confirm.',
];

function Header({ api, version }: { api: TuiApi; version: number }) {
  const latest = useLoad(() => {
    const id = api.runs()[0];

    return id ? api.readRun(id) : null;
  }, [version]);
  const run = latest.data;

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box flexShrink={0} marginRight={2}>
        <Text bold color="cyan">
          veritas
        </Text>
        <Text bold> {path.basename(api.root) || api.root}</Text>
      </Box>
      {run ? (
        <Box>
          <Box flexShrink={0} marginRight={1}>
            <Badge color={verdictColor(run.verdict)}>{run.verdict ?? run.status}</Badge>
          </Box>
          <Text dimColor wrap="truncate-end">
            {`latest ${run.id} · exit ${run.exitCode ?? '-'} · ${run.startedAt}`}
          </Text>
        </Box>
      ) : (
        <Text dimColor>{latest.loading ? 'loading…' : 'no run yet'}</Text>
      )}
    </Box>
  );
}

/** The keys that work here, each as a highlighted key and what it does. */
function KeyHints({ keys }: { keys: Hints }) {
  return (
    <Box height={1} overflow="hidden">
      {keys.map(([key, action]) => (
        <Box key={key} marginRight={2} flexShrink={0}>
          <Text inverse> {key} </Text>
          <Text dimColor> {action}</Text>
        </Box>
      ))}
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
  const [hints, setHintState] = useState<{ screen: ScreenKey; keys: Hints } | null>(null);
  const rows = (stdout as NodeJS.WriteStream).rows || 24;
  const columns = (stdout as NodeJS.WriteStream).columns || 80;
  // The header (3 rows), the panel border (2), the key bar (1) and one spare row: ink redraws the whole terminal when
  // its output is as tall as the terminal.
  const height = Math.max(5, rows - 7);
  // The menu (24 columns) and the screen panel's border and padding.
  const width = Math.max(30, columns - 28);
  const setHints = useCallback(
    (keys: Hints | null) => setHintState(keys ? { screen, keys } : null),
    [screen],
  );

  const onBack = useCallback(() => setFocus('menu'), []);
  const onChange = useCallback(() => setVersion((v) => v + 1), []);
  const onHighlight = useCallback((item: { value: ScreenKey }) => setScreen(item.value), []);
  const navigate = useCallback((key: ScreenKey) => {
    setHelp(false);
    setScreen(key);
    setFocus('screen');
  }, []);

  useInput(
    (input, key) => {
      const shortcut = SCREENS[Number(input) - 1];

      if (input === 'q') exit();
      else if (input === '?') setHelp((h) => !h);
      else if (shortcut && /^[1-9]$/.test(input)) navigate(shortcut.key);
      else if (key.rightArrow || key.return) {
        setHelp(false);
        setFocus('screen');
      }
    },
    { isActive: focus === 'menu' },
  );

  const props: ScreenProps = {
    api,
    active: focus === 'screen',
    onBack,
    height,
    width,
    onChange,
    version,
    navigate,
    setHints,
  };
  const current = SCREENS.find((s) => s.key === screen);
  const border = (focused: boolean) => (focused ? 'cyan' : 'gray');

  return (
    <Box flexDirection="column">
      <Header api={api} version={version} />
      <Box>
        <Box
          flexDirection="column"
          width={24}
          flexShrink={0}
          borderStyle="round"
          borderColor={border(focus === 'menu')}
          paddingX={1}
        >
          <SelectList
            items={MENU}
            active={focus === 'menu' && !help}
            onHighlight={onHighlight}
            selected={SCREENS.findIndex((s) => s.key === screen)}
          />
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {current?.about}
            </Text>
          </Box>
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor={border(focus === 'screen')}
          paddingX={1}
          minHeight={height + 2}
        >
          {help ? (
            <ScrollView active={focus === 'menu'} height={height}>
              {HELP.map((line) => (
                <Text key={line}>{line}</Text>
              ))}
            </ScrollView>
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
      <KeyHints
        keys={
          focus === 'menu'
            ? [
                ['↑↓', 'move'],
                ['Enter', 'open'],
                ['1-6', 'jump'],
                ['?', 'help'],
                ['q', 'quit'],
              ]
            : hints?.screen === screen
              ? hints.keys
              : [
                  ['↑↓', 'move'],
                  ['Enter', 'choose'],
                  ['Esc', 'back'],
                ]
        }
      />
    </Box>
  );
}
