import path from 'node:path';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Confirm, ErrorView, Title, useLoad } from '../components.js';
import type { ScreenProps } from '../screen.js';

export function Home({ api, active, onBack, onChange, version }: ScreenProps) {
  const config = useLoad(() => api.readConfig(), [version]);
  const doctor = useLoad(() => api.doctor(), [version]);
  const [initError, setInitError] = useState<unknown>(null);
  const [initialized, setInitialized] = useState<string[] | null>(null);
  const uninitialized = config.data?.kind === 'none';

  useInput(
    (_input, key) => {
      if (key.escape) onBack();
    },
    { isActive: active && !uninitialized },
  );

  return (
    <Box flexDirection="column">
      <Title>Home</Title>
      <Text>Project: {api.root}</Text>
      {config.error ? <ErrorView error={config.error} /> : null}
      {config.data?.kind === 'json' || config.data?.kind === 'code' ? (
        <Text>Configuration: {path.relative(api.root, config.data.file) || config.data.file}</Text>
      ) : null}
      {uninitialized ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>This project has no Veritas configuration yet.</Text>
          {initError ? <ErrorView error={initError} /> : null}
          <Confirm
            question="Create .veritas/config.json with the detected settings?"
            active={active}
            onYes={() => {
              try {
                setInitialized(api.init().nextSteps);
                onChange();
              } catch (error) {
                setInitError(error);
              }
            }}
            onNo={onBack}
          />
        </Box>
      ) : null}
      {initialized ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">Created the configuration. Next steps:</Text>
          {initialized.map((s) => (
            <Text key={s}> {s}</Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Tools (doctor)</Text>
        {doctor.loading ? <Text dimColor>checking…</Text> : null}
        {doctor.error ? <ErrorView error={doctor.error} /> : null}
        {doctor.data?.features.map((f) => (
          <Text key={f.feature}>
            <Text color={f.state === 'enabled' ? 'green' : f.state === 'degraded' ? 'yellow' : 'red'}>
              {f.state.padEnd(9)}
            </Text>{' '}
            {f.feature}
            {f.missing.length ? <Text dimColor> (missing {f.missing.join(', ')})</Text> : null}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
