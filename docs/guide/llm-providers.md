# LLM providers

This page explains how to let an LLM read documentation statements that the built-in rules cannot interpret, and what Veritas sends to it. An LLM is optional: every feature works without one. What an LLM finds becomes experimental `proposed` properties, which are never accepted automatically and never count as evidence or proof.

The default is `llm.provider: "none"`.

## Providers

| `llm.provider` | Uses                                                    | Needs                                                                |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `claude-code`  | The Claude Code CLI with your own login (Pro/Max plans) | `claude` on `PATH` and `claude auth login`                           |
| `codex`        | The Codex CLI with your own login (ChatGPT plans)       | `codex` on `PATH`, `codex login` and `llm.allowCodexFileReads: true` |
| `claude`       | The Anthropic API                                       | `ANTHROPIC_API_KEY`                                                  |
| `openai`       | The OpenAI API (Responses API, `store: false`)          | `OPENAI_API_KEY`                                                     |

Example configuration:

```json
{
  "llm": {
    "provider": "claude-code",
    "model": "sonnet",
    "maxTokensPerRun": 200000
  }
}
```

| Setting                     | Default  | Meaning                                                                 |
| --------------------------- | -------- | ----------------------------------------------------------------------- |
| `llm.provider`              | `none`   | One of the providers above                                              |
| `llm.model`                 | (unset)  | The model; for the CLIs, any value their `--model` option accepts       |
| `llm.maxTokensPerRun`       | `200000` | Token budget per run                                                    |
| `llm.allowCodexFileReads`   | `false`  | Required for `codex` (see below)                                        |
| `sources.sendFullTextToLlm` | `false`  | When `false`, each document is cut to 2000 characters before it is sent |

`veritas doctor` shows whether the provider is ready. For the CLIs it reads only the login state, not account details.

## How the CLIs are run

Veritas never handles CLI credentials and does not pass API keys to the CLIs, so they always use their own login. Usage counts toward your plan's limits.

The CLIs run with as little as possible, in an empty temporary directory, so they see only the quoted text Veritas sends:

- Claude Code: no tools, MCP servers, settings or sessions.
- Codex: read-only sandbox, ephemeral session, no user configuration, browser, apps or web search.

Codex keeps a read-only shell that Veritas cannot switch off, so the model could read local files. Veritas therefore uses `codex` only when `llm.allowCodexFileReads` is `true`. Whatever a model returns is kept only when it is grounded in the quoted statement (its numbers and text must come from the statement), so file contents cannot reach artifacts or reports.

On Windows, `.exe` installs and npm or pnpm `.cmd` shims are supported; the shim's Node.js script is run directly, without a shell.

## Offline runs never call an LLM

With `--offline`, Veritas makes no LLM request, whatever the configuration says. The GitHub Action always runs offline. Use `--offline` whenever you want a run that cannot send text anywhere.

## What LLM output is used for

- Only statements the rule-based extractor could not interpret are sent.
- Sent text is redacted (token patterns and secret environment values) and, by default, shortened.
- Results are marked `llm_extracted` and experimental, stay `proposed`, and need the same review as any other property. See [Specifications](/guide/specifications).
- LLM output is stored with the hash of its input and marked as not reproducible. Successful responses are cached by provider, model and the exact request.
- Full prompts are not stored.
- Text in documents is treated as data: instructions inside a README or an issue are not followed by Veritas, and are quoted to the model as data.
