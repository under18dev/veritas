import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCommand } from '../src/index.js';

const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

function bin(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-bin-')));
}

describe('resolveCommand', () => {
  it('uses the name as is outside Windows', () => {
    expect(resolveCommand('claude', { platform: 'linux', env: { PATH: '' } })).toEqual({
      command: 'claude',
      prefix: [],
    });
  });

  it('prefers an executable on PATH on Windows', () => {
    const dir = bin();
    writeFileSync(path.join(dir, 'claude.exe'), '');
    writeFileSync(path.join(dir, 'claude.cmd'), NPM_SHIM);
    expect(resolveCommand('claude', { platform: 'win32', env: { PATH: `C:\\missing;${dir}` } })).toEqual({
      command: path.join(dir, 'claude.exe'),
      prefix: [],
    });
  });

  it('runs the script behind an npm .cmd shim with Node.js instead of a shell', () => {
    const dir = bin();
    writeFileSync(path.join(dir, 'codex.cmd'), NPM_SHIM);
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, '');
    expect(resolveCommand('codex', { platform: 'win32', env: { PATH: dir } })).toEqual({
      command: process.execPath,
      prefix: [script],
    });
  });

  it('refuses batch files that are not Node.js shims and commands that are not installed', () => {
    const dir = bin();
    writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\ncodex-real.exe %*\r\n');
    expect(resolveCommand('codex', { platform: 'win32', env: { PATH: dir } })).toBeNull();
    expect(resolveCommand('claude', { platform: 'win32', env: { PATH: dir } })).toBeNull();
  });

  it('resolves an explicit shim path and refuses other batch files given by path', () => {
    const dir = bin();
    const shim = path.join(dir, 'codex.cmd');
    writeFileSync(shim, NPM_SHIM);
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, '');
    expect(resolveCommand(shim, { platform: 'win32', env: { PATH: '' } })).toEqual({
      command: process.execPath,
      prefix: [script],
    });
    const other = path.join(dir, 'tool.bat');
    writeFileSync(other, '@echo off\r\ntool.exe %*\r\n');
    expect(resolveCommand(other, { platform: 'win32', env: { PATH: '' } })).toBeNull();
    expect(
      resolveCommand(path.join(dir, 'missing.cmd'), { platform: 'win32', env: { PATH: '' } }),
    ).toBeNull();
  });
});
