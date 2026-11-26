# Veritas とは

Veritas は、TypeScript や JavaScript のプロジェクトのテストが、実際に何を保証しているかを確かめるツールです。プロジェクトにすでにある仕様（README、docs、JSDoc、OpenAPI や JSON Schema、git の履歴、エクスポートした Issue）を読み、コードと Vitest、Jest、Node.js のテストランナー（`node --test`）のテストに結び付けます。そのうえで mutation testing、property-based testing、範囲を限った形式検証を実行し、見つけたことを根拠と一緒に報告します。

## 解決する問題

テストがすべて通っていても、分かるのは「テストが通った」ことだけで、何を確かめたかは分かりません。よくあるのは次のような例です。

- `expect(true).toBe(true)` のように定数を比べているだけで、コードを一度も呼んでいないテスト
- コードは呼んでいるが、ドキュメントに書かれた境界の値を試していないテスト。使っている入力では `>` と `>=` の違いが出ません
- ドキュメントには「1000 以上」、コードには `total > 1000` と書かれているのに、1000 を使うテストがないので全部通ってしまうケース

二つ目と三つ目の例では行がすべて実行されるので、行カバレッジではカバー済みになります。Veritas は三つとも finding として報告します。

## 答えること

Veritas は、テストと仕様の記述ごとに、次の五つに答えます。

| 問い                               | 使う根拠                                                              |
| ---------------------------------- | --------------------------------------------------------------------- |
| このテストはどの仕様から来ているか | 引用した出典の行（ファイルと行番号）と、そこから作った Property       |
| テストは何を観測しているか         | 静的解析で調べた、プロジェクトの関数の呼び出しと assertion            |
| どんな誤りなら検出できるか         | 実際の mutation testing で、kill した mutant と生き残った mutant      |
| 何を、どの範囲で形式的に確かめたか | Z3 や Lean の結果。値の範囲、前提、ソルバーへの入力ファイルが付きます |
| まだ分からないことは何か           | 決着しなかったもの、対象外のもの、実行していないものを明示します      |

## Veritas がしないこと

- 点数は付けません。「87% 良い」のような数字の代わりに、テストごとの証拠の一覧（evidence vector）と、5 種類の判定のどれかを示します（[結果の読み方](/ja/guide/reading-results)）。
- コードが正しいことの証明はしません。`proven_within_model` は「示したモデル、範囲、前提の中では反例がない」という意味です。範囲の外の入力、浮動小数点数、`NaN`、対応範囲の外の構文は対象外です（[検証](/ja/guide/verification)）。
- 何が仕様かを決めるのは人です。Veritas は実装に合わせて仕様や期待値を書き換えず、仕様を勝手に accepted にすることもありません（[仕様の確定](/ja/guide/specifications)）。
- プロジェクトのコードは隔離しません。テストや関数は、`npm test` を実行するのと同じ信頼のもとで動かします。信頼できないコードの扱いは[信頼できないリポジトリ](/ja/guide/untrusted-repositories)を参照してください。

## 実行の流れ

```text
CLI / Node API / Agent Skill / MCP server / GitHub Action
                       |
                  Orchestrator
                       |
    +------------------+-------------------+
Evidence collectors  Code intelligence  Test inventory
 (README, docs, ...)  (TypeScript API)    (Vitest tests)
    +---------- Specification engine ------+
                       |
                Property registry
         (proposed -> accepted | rejected ...)
       +---------------+-------------------+
 Mutation testing  Property-based tests  Formal checks
   (mutator)          (fast-check)       (Z3 / Lean 4)
       +---------------+-------------------+
                Assessment engine
       (evidence vectors, findings, verdict)
                       |
               Improvement planner
                       |
       Artifacts / reports / CI exit codes
```

1. Evidence collector がローカルの出典を読みます。GitHub と Web は、有効にしたときだけ読みます。どの出典も、ファイルと行番号を付けて保存します。
2. Specification engine が、「Orders with a total of 1000 or more receive a flat discount of 100」のような記述を、関数と引数に結び付いた Property にします。Code intelligence はコードから推測した Property も加えますが、これは仮説のままです。
3. Test inventory が Vitest、Jest、`node:test` のテストを見つけ、それぞれが何を呼び、何を assert しているかを調べます。
4. mutation testing、property-based testing、Z3 や Lean による検査が、Property についての根拠を作ります。
5. Assessment engine がすべてをまとめ、テストごとの evidence vector、finding（指摘）、終了コード付きの verdict（判定）を出します。
6. 依頼すると、Improvement planner が accepted な仕様から期待値を取った新しいテストファイルを提案します。

各部分を担うパッケージは[アーキテクチャ](/ja/concepts/architecture)で説明しています。

## 実行する方法

どの入口も同じエンジンを動かします。各コマンドは、実行したステージの成果物を `.veritas/runs/<run-id>/` に書き出します。レポートのステージを含むコマンド（`veritas run` と `veritas prove`）は、`reports.formats` に指定したレポート（既定は JSON、Markdown、HTML、SARIF）も書き出します。

| 入口          | 向いている用途                              | 参照先                                                                       |
| ------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| CLI `veritas` | 手元での利用、各種 CI                       | [はじめに](/ja/guide/getting-started)、[CLI リファレンス](/ja/reference/cli) |
| Node API      | 自作のツールから呼び出す                    | [Node API](/ja/reference/api)                                                |
| MCP サーバー  | MCP に対応したエージェント（`veritas-mcp`） | [エージェントと MCP](/ja/guide/agents)                                       |
| Agent Skill   | `SKILL.md` を読み込むエージェント           | [エージェントと MCP](/ja/guide/agents)                                       |
| GitHub Action | プルリクエストの検査                        | [CI と GitHub Action](/ja/guide/ci)                                          |

ネットワーク上の出典か LLM プロバイダーを有効にしない限り、Veritas はネットワークにアクセスしません。
