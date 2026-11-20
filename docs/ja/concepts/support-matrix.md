# 対応環境

現在のリリースが対応している機能、形式的な部分集合、環境、外部ツールをまとめます。各結果の意味は[セマンティクス](/ja/concepts/semantics)を参照してください。

## 使える機能

| 領域                   | 補足                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`、`doctor`、設定 | `.veritas/config.json`。`veritas.config.{ts,mjs,js}` は `--allow-code-config` を付けたときだけ                                                                                                             |
| 根拠の収集             | README、`docs/**/*.md`、JSDoc、OpenAPI / JSON Schema の境界、git log、書き出した Issue・プルリクエスト（`.veritas-sources/`）、CHANGELOG。GitHub API と Web は、設定で有効にし、`--offline` でないときだけ |
| 文の抽出               | 英語と日本語の閾値の表現をルールで抽出。任意で、自分のログインで使う Claude Code・Codex の CLI、または Anthropic・OpenAI の API による LLM の抽出                                                          |
| コードの解析           | TypeScript Compiler API。静的な解析のみ                                                                                                                                                                    |
| Property の登録        | proposed / reviewed / accepted / rejected / conflicted / superseded。承認は追記のみ                                                                                                                        |
| テストの一覧           | Vitest の `it`/`test`/`describe`（修飾子を含む）、assertion、モック、スナップショット                                                                                                                      |
| mutation testing       | `@mizchi/mutator` 0.4.x                                                                                                                                                                                    |
| property-based テスト  | fast-check を制限したプロセスで実行（パーミッションモデル。プロジェクトのコードは信頼するコード、[ADR 0011](/adr/0011-trusted-project-code)）。seed は固定                                                 |
| Z3 による検査          | 有界な整数・真偽値の部分集合（後述）。`z3-solver`（WASM）を専用のプロセスで実行                                                                                                                            |
| Lean による検査        | Lean 4 と Lake がインストールされていれば使う。`sorry`、`admit`、`native_decide`、追加の公理を使った証明は拒否する                                                                                         |
| 評価と finding         | 証拠のベクトル。1 つのスコアにはまとめない                                                                                                                                                                 |
| テストの改善           | `improve` が計画するのは新しいテストファイルだけ。適用には計画 ID と承認トークンが必要で、隔離したコピーで実行し、mutation の結果が改善しなければ元に戻す。CI では拒否する                                 |
| レポート               | テキスト、JSON、Markdown、1 ファイルで完結する HTML、SARIF 2.1.0                                                                                                                                           |
| CLI                    | [CLI リファレンス](/ja/reference/cli)にあるコマンド                                                                                                                                                        |
| MCP サーバー           | 読み取り用のツール。承認済みの改善計画の適用は `--allow-write` を付けたときだけ                                                                                                                            |
| GitHub Action          | `pull_request` 向けのオフラインのエンジン。`since` による差分の実行。[GitHub Action](/ja/reference/github-action)を参照                                                                                    |
| Agent Skill            | `skills/veritas/SKILL.md`。[エージェントと MCP](/ja/guide/agents)を参照                                                                                                                                    |

## 形式的な部分集合

| 構文                                                                                                                                                   | 対応                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `number`（有界な安全な整数として扱う）または `boolean` の引数と戻り値                                                                                  | 対応                                                     |
| レコードの引数。プロパティがすべて `number` か `boolean` のオブジェクト型（リテラル、または同じファイルの `interface` / `type`）。`p.field` として読む | 対応（戻り値には使えない）                               |
| 配列の引数（`number[]`、`boolean[]`、`readonly`、`Array<T>`）で、要素が `formal.maxArrayLength` 個以下。`xs.length` と、リテラルの `k` による `xs[k]`  | 対応（戻り値には使えない）                               |
| 入れ子のレコード、省略可能なプロパティ、レコードや配列を渡す・返すこと、計算した添字、配列のメソッド、スプレッド                                       | 非対応                                                   |
| `if`/`else`、三項演算子、`return`、`const`                                                                                                             | 対応                                                     |
| `+ - *`、比較、`=== !==`、`&&`、`\|\|`、`!`、単項の `-`                                                                                                | 対応                                                     |
| 同じファイルにある、対応するほかの関数の呼び出し                                                                                                       | 対応（再帰は不可。レコードや配列の引数がある場合も不可） |
| `/`、`%`、`**`、浮動小数点数、`NaN`、`Infinity`、`==`、`??`、型の変換                                                                                  | 非対応                                                   |
| ループ、`let`/`var`、副作用、async、ジェネレーター、`this`、外部の状態                                                                                 | 非対応                                                   |

Lean の証明が扱うのは整数と真偽値の引数だけで、レコードや配列についての Property は、Lean のバックエンドでは `unsupported` になります。property-based テストの入力も同じ部分集合から作ります（有界な整数、真偽値、それらのレコードと配列）。文字列、浮動小数点数、`NaN`、`Infinity`、Unicode のテキストは生成しません。

## 環境

| 項目           | 対応                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js        | 24 以上。プロジェクトのコードを実行するのは Node.js 25 以上（ネットワークを遮断）があるときだけ（実行中のもの、`VERITAS_SANDBOX_NODE`、PATH 上の `node`）。`sandbox.allowNetworkWithoutIsolation` を設定した場合を除く |
| OS             | Linux、macOS、Windows                                                                                                                                                                                                  |
| テストランナー | Vitest                                                                                                                                                                                                                 |
| 言語           | TypeScript、JavaScript（ESM）                                                                                                                                                                                          |

## 外部ツールとライセンス

Veritas のライセンスは Apache-2.0 です。使っている外部ツールは次のとおりです。

| ツール                      | ライセンス | 使い方                                           |
| --------------------------- | ---------- | ------------------------------------------------ |
| `@mizchi/mutator`           | MIT        | npm の依存パッケージ。別のプロセスとして実行     |
| `z3-solver`（Z3）           | MIT        | npm の依存パッケージ。WASM のビルド              |
| fast-check                  | MIT        | npm の依存パッケージ。制限したプロセスで実行     |
| Lean 4 と Lake              | Apache-2.0 | 利用者が別途インストール（elan）。同梱しない     |
| `openai`                    | Apache-2.0 | 任意の OpenAI アダプターの npm の依存パッケージ  |
| `@anthropic-ai/sdk`         | Apache-2.0 | 任意の Claude アダプターの npm の依存パッケージ  |
| lightningcss（Vitest 経由） | MPL-2.0    | 変更していない推移的な依存パッケージ。同梱しない |
