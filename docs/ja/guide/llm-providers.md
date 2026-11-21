# LLM プロバイダー

LLM は任意で、どの機能も LLM なしで動きます。設定すると、組み込みの規則では読めないドキュメントの記述を LLM が読みます。LLM が見つけたものは `proposed` で実験的な Property になり、自動で accepted になることはなく、根拠や証明としても数えません。以下に、使えるプロバイダーと、Veritas がプロバイダーに送るものを示します。

既定は `llm.provider: "none"` です。

## プロバイダー

| `llm.provider` | 使うもの                                               | 必要なもの                                                          |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `claude-code`  | 自分のログインで使う Claude Code CLI（Pro/Max プラン） | `PATH` 上の `claude` と `claude auth login`                         |
| `codex`        | 自分のログインで使う Codex CLI（ChatGPT のプラン）     | `PATH` 上の `codex`、`codex login`、`llm.allowCodexFileReads: true` |
| `claude`       | Anthropic API                                          | `ANTHROPIC_API_KEY`                                                 |
| `openai`       | OpenAI API（Responses API、`store: false`）            | `OPENAI_API_KEY`                                                    |

設定の例です。

```json
{
  "llm": {
    "provider": "claude-code",
    "model": "sonnet",
    "maxTokensPerRun": 200000
  }
}
```

| 設定                        | 既定       | 意味                                                       |
| --------------------------- | ---------- | ---------------------------------------------------------- |
| `llm.provider`              | `none`     | 上のプロバイダーのどれか                                   |
| `llm.model`                 | （未設定） | モデル。CLI の場合は、その CLI の `--model` が受け付ける値 |
| `llm.maxTokensPerRun`       | `200000`   | 一回の実行で使うトークンの上限                             |
| `llm.allowCodexFileReads`   | `false`    | `codex` を使うときに必要（後述）                           |
| `sources.sendFullTextToLlm` | `false`    | `false` のとき、各文書は送る前に 2000 文字で切り詰める     |

プロバイダーが使える状態かは `veritas doctor` で確認できます。CLI については、ログインの状態だけを読み、アカウントの情報は読みません。

## CLI の動かし方

Veritas は CLI の認証情報を扱わず、API キーも CLI に渡しません。CLI はいつも自分のログインを使います。使った分は、あなたのプランの利用枠に数えられます。

CLI は、できることを最小限にし、空の一時ディレクトリで動かします。CLI に見えるのは、Veritas が送る引用テキストだけです。

- Claude Code：ツール、MCP サーバー、設定、セッションを使いません。
- Codex：読み取り専用のサンドボックス、使い捨てのセッションで動かし、ユーザーの設定、ブラウザー、アプリ、Web 検索を使いません。

Codex には Veritas から止められない読み取り専用のシェルがあり、モデルがローカルのファイルを読める可能性があります。そのため、`codex` は `llm.allowCodexFileReads` が `true` のときだけ使います。モデルが返したものは、引用した記述に根拠があるもの（数値と文言が記述から来ているもの）だけを残すので、ファイルの中身が成果物やレポートに入ることはありません。

Windows では、`.exe` で入れた CLI と、npm や pnpm の `.cmd` シムに対応しています。シムの場合は、シェルを通さずにその Node.js スクリプトを直接実行します。

## オフラインの実行では LLM を呼ばない

`--offline` を付けると、設定にかかわらず LLM へのリクエストは送りません。GitHub Action は常にオフラインで動きます。どこにもテキストを送らない実行にしたいときは、`--offline` を付けてください。

## LLM の出力の扱い

- 送るのは、規則で読めなかった記述だけです。
- 送るテキストは、トークンの形をした値と秘密の環境変数の値を伏せ、既定では短く切り詰めます。
- 結果には `llm_extracted` の印と実験的の印が付き、`proposed` のままで、ほかの Property と同じレビューが必要です。[仕様の確定](/ja/guide/specifications)を参照してください。
- LLM の出力は、入力のハッシュと一緒に保存し、再現できないものとして印を付けます。成功した応答は、プロバイダー、モデル、リクエストの中身が同じときだけキャッシュから再利用します。
- プロンプトの全文は保存しません。
- 文書のテキストはデータとして扱います。README や Issue の中に指示が書かれていても Veritas は従わず、モデルにもデータとして引用して渡します。
