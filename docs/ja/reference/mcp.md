# MCP サーバー

`veritas-mcp` は、コーディングエージェントなどの MCP クライアントに Veritas を提供するサーバーで、`@under18dev/veritas` と一緒にインストールされます。起動方法、各ツールの入力と戻り値、承認・同時実行・キャンセルの仕組みを以下に載せます。ステージを実行するツールは、対応する `veritas` コマンドと同じく `.veritas/runs/<run-id>/` に新しい実行を作ります。`list_properties`、`get_evidence`、`get_run_status` は既存の実行を読むだけです。`plan_improvement` と `apply_approved_improvement` は `.veritas/improvements/` に書きます。クライアントへの接続方法は[エージェントと MCP](/ja/guide/agents)を参照してください。

## サーバーの起動

```bash
veritas-mcp [--root <dir>] [--max-concurrent <n>] [--allow-write]
```

| オプション             | 既定値               | 意味                                                                                       |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `--root <dir>`         | カレントディレクトリ | プロジェクトのルート。すべてのツールはこの中で動き、外のパスを受け付けるツールはありません |
| `--max-concurrent <n>` | `1`                  | 同時に実行できる長時間の処理の数（1〜16）                                                  |
| `--allow-write`        | オフ                 | プロジェクトのファイルを変更できる唯一のツール `apply_approved_improvement` を登録します   |
| `-h`、`--help`         |                      | 使い方を表示して終了します                                                                 |

オプションが不正なとき、`--max-concurrent` が 1〜16 の範囲外のとき、`--root` が存在するディレクトリでないときは、終了コード 2 で終わります。接続すると、stderr に `veritas-mcp serving <root>` と出力します。

1 つのプロジェクトに対してサーバーを起動する、クライアントの設定の例です。

```json
{
  "mcpServers": {
    "veritas": {
      "command": "npx",
      "args": ["veritas-mcp", "--root", "/path/to/project"]
    }
  }
}
```

## ツール

ステージを実行するツールは、設定にかかわらず、すべて**オフライン**で動きます。GitHub や Web のソースも、LLM へのリクエストも使いません。`run.json` には、コマンドとして `mcp:<ツール名>` を記録します。

| ツール                       | 登録される条件         | プロジェクトのファイルの変更 | プロジェクトのコードの実行                 |
| ---------------------------- | ---------------------- | ---------------------------- | ------------------------------------------ |
| `discover_specs`             | 常に                   | なし                         | なし                                       |
| `list_properties`            | 常に                   | なし                         | なし                                       |
| `analyze_tests`              | 常に                   | なし                         | なし                                       |
| `run_mutation`               | 常に                   | なし                         | あり（プロジェクトのテスト）               |
| `verify_property`            | 常に                   | なし                         | あり（制限付きでの反例の再生）             |
| `get_evidence`               | 常に                   | なし                         | なし                                       |
| `get_run_status`             | 常に                   | なし                         | なし                                       |
| `plan_improvement`           | 常に                   | なし                         | あり（テスト対象の関数の制限付き呼び出し） |
| `apply_approved_improvement` | `--allow-write` のとき | あり（テストファイルの追加） | あり                                       |

`apply_approved_improvement` 以外のツールには、読み取り専用を表す `readOnlyHint` が付いています。プロジェクトのファイルは変更しませんが、ステージを実行するツールは `.veritas/` の下に実行ディレクトリを書きます。

### `discover_specs`

仕様の根拠を集めます。対象は README、docs、JSDoc、スキーマ、git の履歴、書き出された Issue です。`veritas discover` と同じステージを実行します。

- 入力: なし
- 戻り値: 実行の要約（後述）に加えて、`sources`（それぞれ `id`、`kind`、`locator`、`range`、`summary`、`trust` を持つ）、`statements`、`skipped`

### `list_properties`

承認の記録を反映した、最新の実行の Property を、レビューの状態、由来、出典とともに一覧にします。MCP から承認を変えることはできません。`veritas spec accept` か `veritas spec reject` を使ってください。

| 入力     | 型                                                                                    | 必須   |
| -------- | ------------------------------------------------------------------------------------- | ------ |
| `status` | `proposed`、`reviewed`、`accepted`、`rejected`、`conflicted`、`superseded` のいずれか | いいえ |

- 戻り値: `runId` と `properties`（`status` を指定したときは、その状態のものだけ）

### `analyze_tests`

コードとテストを索引にし、テストを Property に対応付け、各テストを証拠のベクトルで評価します。mutation は実行しません。`veritas analyze` と同じステージを実行します。

- 入力: なし
- 戻り値: 実行の要約に加えて `assessments`

### `run_mutation`

本物の mutator で mutation testing を実行し、mutant を Property やテストに結び付けます。`veritas mutate` と同じステージを実行します。

| 入力         | 型                                                               | 必須   | 意味                                                                    |
| ------------ | ---------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `since`      | git の ref（英数字と `._/@~^-`、200 文字以内、`-` で始まらない） | いいえ | この ref からの変更に mutant を絞る                                     |
| `scope`      | プロジェクトからの相対パスまたは glob                            | いいえ | mutation の対象にするソースの glob                                      |
| `killMatrix` | 真偽値、既定は `false`                                           | いいえ | すべての mutant に対して、それを通るテストをすべて実行する（遅い）      |
| `reportFile` | プロジェクトからの相対パス                                       | いいえ | mutator を実行する代わりに取り込む mutation-testing-elements のレポート |

`reportFile` と `killMatrix` は同時に指定できません（`OPTION_CONFLICT`）。パスはプロジェクトの中にとどめる必要があり、絶対パス、ドライブ文字、`..` を含むパス、`-` で始まるパスは拒否します。

- 戻り値: 実行の要約に加えて、`counts`（状態ごとの mutant の数）と `mutants`

### `verify_property`

形式化された Property を有界な整数モデルの中で検査し、反例を JavaScript で再生します。`veritas prove` と同じステージを実行します。バックエンドは設定の `formal.backend`（既定は Z3）です。結果はよくても「モデルの範囲内で証明された」であり、一般的な証明にはなりません。[セマンティクス](/ja/concepts/semantics)を参照してください。

| 入力              | 型                     | 必須   | 意味                                                |
| ----------------- | ---------------------- | ------ | --------------------------------------------------- |
| `propertyId`      | `P-<hex>`              | いいえ | この Property だけを検査する                        |
| `includeProposed` | 真偽値、既定は `false` | いいえ | accepted でない Property も検査する（実験的な扱い） |

- 戻り値: 実行の要約に加えて `claims`（主張がなければ空）

### `get_evidence`

`veritas explain` と同じく、finding の根拠の連鎖を返します。

| 入力        | 型        | 必須 |
| ----------- | --------- | ---- |
| `findingId` | `F-<hex>` | はい |

- 戻り値: `runId`、`finding`、`properties`、`sources`、`statements`、`tests`、`assessments`、`mutants`、`claims`

### `get_run_status`

実行の状態、ステージ、verdict、使用量を返します。

| 入力    | 型         | 必須   | 意味             |
| ------- | ---------- | ------ | ---------------- |
| `runId` | `run-<id>` | いいえ | 既定は最新の実行 |

- 戻り値: `run`（`run.json` の内容）

### `plan_improvement`

finding のある最新の実行から、テストだけを対象にした改善を計画します。`veritas improve --dry-run` に当たり、プロジェクトのファイルは変更しません。

- 入力: なし
- 戻り値: 計画の結果。`planId`、`runId`、`outcome`、`plan`、`approvalToken`、`specViolationCandidates`、`implementationFixProposals`、`skipped`、`reasons`、`planFile` を含みます。`outcome` は、計画ができたときは `planned`、それ以外は計画が止まった理由（`no_safe_improvement`、`needs_spec_decision`、`blocked`、`error`）です。

期待値に使うのは accepted の Property だけです。MCP からは proposed の Property を使えません。

### `apply_approved_improvement`

`--allow-write` を付けたときだけ登録されます。レビュー済みの改善計画を適用します。隔離したコピーで改善を測ったうえで新しいテストファイルを追加するだけで、改善しなければ元に戻します。CI の中では拒否します。

| 入力            | 型                  | 必須   | 意味                               |
| --------------- | ------------------- | ------ | ---------------------------------- |
| `planId`        | `IP-<hex>`          | はい   | `plan_improvement` が返した計画 ID |
| `approvalToken` | 16 進数 64 文字     | はい   | 同じ計画のトークン                 |
| `actor`         | 1〜200 文字の文字列 | いいえ | 計画を承認した人（記録されます）   |

- 戻り値: `attempt`（記録した適用の結果）

## 実行の要約

`discover_specs`、`analyze_tests`、`run_mutation`、`verify_property` は、共通の要約を返します。

| フィールド | 意味                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| `runId`    | 新しい実行の ID                                                              |
| `verdict`  | `pass`、`pass_with_warnings`、`policy_failure`、`tool_error`、`inconclusive` |
| `exitCode` | CLI なら返す終了コード                                                       |
| `reasons`  | その verdict になった理由                                                    |
| `stages`   | 各ステージと、その `status`、`messages`                                      |
| `findings` | 各 finding の `id`、`kind`、`certainty`、`severity`、`title`                 |

結果は `structuredContent` と JSON のテキストの両方で返します。どちらも秘密情報（トークンの形をした文字列と、秘密情報らしい環境変数の値）を伏せています。

## エラー

ツールが失敗すると、`isError: true` と JSON の本文 `{ "code", "category", "message", "hint" }` を返します。`code` と `category` は CLI と同じです（たとえば `NO_RUN` と `user`）。想定外の例外は、`code` が `UNEXPECTED`、`category` が `tool` になります。ツールの入力スキーマに合わない入力は、ツールが動く前に拒否されます。

## 承認トークン

プロジェクトのファイルを変更するには、2 つの手順を踏みます。

1. `plan_improvement` が計画を `.veritas/improvements/<plan-id>/` に保存し、計画の正規化した内容の SHA-256 である `approvalToken` を返します。
2. 人が計画（`plan` フィールド、またはそのディレクトリの `plan.json`）をレビューしたあとで、クライアントが計画 ID とトークンを `apply_approved_improvement` に渡します。

トークンは計画の内容 1 つにだけ一致します。計画が変わった、計画 ID が一致しない、計画に使った Property が後から rejected になった、のいずれかに当たると適用を拒否します。`--allow-write` を付けずに起動したサーバーには、このツール自体がありません。適用のたびに、承認した人、日時、呼び出し元（`mcp`）、トークンのハッシュを `approval-<n>.json` に記録します。承認した人は `actor`、`VERITAS_ACTOR`、git の `user.name` の順に決まります。名前は渡されたとおりに記録し、認証はしません。

## 同時実行と進捗

時間のかかるツール（ステージを実行するもの、`plan_improvement`、`apply_approved_improvement`）は、`--max-concurrent` 件までという上限を共有します。上限に達しているときは、空きができるまで待ちます。`list_properties`、`get_evidence`、`get_run_status` はファイルを読むだけなので、上限の対象外です。

呼び出しに `progressToken` が付いていれば、サーバーは `notifications/progress` を送ります。進捗のメッセージ 1 つが 1 ステップで、全体の数はステージ数に 1 を足したものです。メッセージの秘密情報は伏せます。

## キャンセル

リクエストをキャンセルする（`notifications/cancelled`）と、その処理を中止します。空きを待っている呼び出しは `CANCELLED` で失敗し、実行中の呼び出しはステージと、それが起動した子プロセス（mutator、プロジェクトのテスト、ソルバーのプロセスなど）を止めます。
