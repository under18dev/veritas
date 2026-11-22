# エージェントと MCP

コーディングエージェントに Veritas を使わせる方法は二つあります。`veritas` CLI の使い方をエージェントに指示する Agent Skill と、Veritas をツールとして公開する MCP サーバー `veritas-mcp` です。どちらも CLI と同じエンジンで動きます。

## Agent Skill

スキルは、Veritas のリポジトリにある `skills/veritas/SKILL.md` の一ファイルです。どんなときに Veritas を使うか、どのコマンドを実行するか、結果をどう読むか、どこで止まってあなたに確認するかを、エージェントに伝えます。Agent Skills を読み込めるエージェントで使えます。

### 入れ方

スキルは npm パッケージには含まれていません。リポジトリから、エージェントがスキルを読み込む場所にコピーしてください。Claude Code の場合、プロジェクトの `.claude/skills/`、すべてのプロジェクトで使うなら `~/.claude/skills/` です。

```bash
mkdir -p .claude/skills/veritas
curl -fsSL https://raw.githubusercontent.com/under18dev/veritas/main/skills/veritas/SKILL.md \
  -o .claude/skills/veritas/SKILL.md
```

スキルは、プロジェクトに `@under18dev/veritas` が入っていること（`npm install -D @under18dev/veritas`）を前提にしています。入っていない場合は、自分でインストールせず、どう入れるかをあなたに尋ねるよう、スキルがエージェントに指示します。

### スキルがエージェントに指示すること

- プロジェクトのコードを動かす操作（`run --profile standard|deep`、`mutate`、`prove`、`improve`）の前に確認を取り、信頼できないリポジトリならコンテナで動かすことを提案する。
- `init`、`doctor`、`run --profile deep --offline --include-proposed --json` を実行し、続けて `report`、`explain`、`spec list` を使う。
- `proven_within_model` は値の範囲と一緒に伝え、`unknown`、`timeout`、`unsupported`、`semantic_mismatch` を成功として伝えない。
- どの Property をなぜ決めるのかをあなたが伝えない限り、`spec accept` も `spec reject` も実行せず、`conflicted` な Property があれば止まる。
- 改善は `improve --dry-run` で計画し、あなたが承認した計画とトークンだけを適用する。
- 頼まれない限り、ネットワーク上の出典を有効にしない、README や docs を編集しない、期待値を変えない、`--allow-code-config` を使わない。

スキルを入れると、エージェントに「このテストに意味はある？」「コードは README の割引の規則に従っている？」「試されていない境界はどこ？」のように頼めます。

## MCP サーバー

パッケージには二つ目のコマンド `veritas-mcp` が入っていて、標準入出力で Veritas を MCP のサーバーとして公開します。

```text
Usage: veritas-mcp [--root <dir>] [--max-concurrent <n>] [--allow-write]

Serves Veritas over MCP (stdio).
  --root <dir>          project root (default: current directory)
  --max-concurrent <n>  analysis jobs allowed at once (default: 1)
  --allow-write         register the tool that applies approved improvement plans
```

### Claude Code に登録する

プロジェクトにパッケージを入れてある場合は、次のとおりです。

```bash
claude mcp add veritas -- npx veritas-mcp --root /path/to/project
```

先にインストールしない場合は、次のとおりです。

```bash
claude mcp add veritas -- npx -y -p @under18dev/veritas veritas-mcp --root /path/to/project
```

`-p` は省略できません。パッケージには二つのコマンドがあり、`-p` なしの `npx @under18dev/veritas` は `veritas-mcp` ではなく `veritas` を実行します。

### ほかの MCP クライアントに登録する

多くのクライアントは、コマンドと引数を JSON で指定します。

```json
{
  "mcpServers": {
    "veritas": {
      "command": "npx",
      "args": ["-y", "-p", "@under18dev/veritas", "veritas-mcp", "--root", "/path/to/project"]
    }
  }
}
```

クライアントのセッションごとに、サーバーのプロセスが一つ起動します。`discover_specs`、`analyze_tests`、`run_mutation`、`verify_property` はパイプラインのステージを実行し、`.veritas/runs/` に新しい実行ディレクトリを作ります。`list_properties`、`get_evidence`、`get_run_status` は読むだけです。`plan_improvement` は計画を `.veritas/improvements/` に書き出します。時間のかかる処理は同時に `--max-concurrent` 件までで、それを超えたものは待つか取り消されます。

### ツール

| ツール                       | 内容                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `discover_specs`             | 仕様の根拠をオフラインで集める                                                                                           |
| `list_properties`            | 最新の実行の Property と宣言した Property を、状態、由来、出典と一緒に一覧にする                                         |
| `analyze_tests`              | コードとテストを解析し、テストを評価する（mutation testing は実行しない）                                                |
| `run_mutation`               | mutation testing を実行し、mutant を Property とテストに結び付ける                                                       |
| `verify_property`            | 形式化した Property を `formal.backend` のバックエンド（既定は Z3。Lean か、その両方も選べる）で検査し、反例を実行し直す |
| `get_evidence`               | finding の根拠をたどって返す                                                                                             |
| `get_run_status`             | 実行の状態、ステージ、verdict、使用量を返す                                                                              |
| `plan_improvement`           | テストだけの改善を計画し、計画と承認トークンを返す                                                                       |
| `apply_approved_improvement` | 確認済みの計画を適用する。`--allow-write` のときだけ登録される                                                           |

各ツールの入力と出力は [MCP サーバーのリファレンス](/ja/reference/mcp)にあります。

### 書き込みと承認

`--allow-write` を付けなければ、サーバーはプロジェクトのファイルを変更できません。ツールが書き込むのは `.veritas/` の中だけです。仕様の承認は MCP からは一切変更できないので、`veritas spec accept|reject` を自分で実行してください。

`--allow-write` を付けると `apply_approved_improvement` が登録されます。`plan_improvement` が返した計画の ID と 64 文字の承認トークンがそのまま必要で、承認した人も記録されます。トークンは、計画を確認してからエージェントに渡してください。適用は新しい一時コピーの中で行い、終わったらコピーは消します。追加するのは新しいテストファイルだけで、結果がよくならなければ取り消し、CI の中では拒否されます。[テストの改善](/ja/guide/improving-tests)を参照してください。

::: warning
MCP サーバーは、プロジェクトのテストや関数を `npm test` と同じ信頼のもとで実行します。信頼できないリポジトリには使わないでください。[信頼できないリポジトリ](/ja/guide/untrusted-repositories)を参照してください。
:::
