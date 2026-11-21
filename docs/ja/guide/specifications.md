# 仕様の確定

何が仕様かを Veritas が自分で決めることはありません。Veritas は Property を `proposed`（出典が食い違う場合は `conflicted`）として作り、accepted にできるのはあなただけです。このガイドでは、照らし合わせる規則を Veritas がどこから見つけるか、規則がどのように Property になるか、Property をどう accept、reject、追跡するかを順に見ていきます。

## 規則を読む出典

`veritas discover` と、`veritas run` の `discover` ステージは、次の出典を読みます。

| 出典                   | 読むもの                                                                                    | 既定 |
| ---------------------- | ------------------------------------------------------------------------------------------- | ---- |
| README                 | `README*` のファイル                                                                        | オン |
| ドキュメント           | `docs/**/*.md`、`CHANGELOG*`、`RELEASE*`                                                    | オン |
| コードのコメント       | `analysis.include` に当てはまるファイルで、export された宣言の JSDoc                        | オン |
| スキーマ               | OpenAPI と JSON Schema の範囲指定（`openapi.{json,yaml}`、`*.openapi.*`、`*.schema.*`）     | オン |
| git の履歴             | コミットメッセージ                                                                          | オン |
| エクスポートした Issue | `.veritas-sources/issues/` と `.veritas-sources/pulls/` の JSON ファイル                    | オン |
| GitHub API             | `sources.github.repo` の Issue とプルリクエスト                                             | オフ |
| Web                    | `sources.web.allowDomains` のドメインのページ。ページ数、深さ、文字数、時間に上限があります | オフ |

ネットワーク上の出典は、`.veritas/config.json` で有効にし、`--offline` を付けずに実行したときだけ使います。Web の場合はドメインも許可します。

```bash
veritas discover --sources local,web --allow-domain docs.example.com --max-pages 10
```

`--allow-domain` と `--max-pages` はその実行にだけ効き、これだけでは Web の収集は有効になりません。GitHub の出典は、`GITHUB_TOKEN` が設定されていればそれを送ります。

読んだテキストは、信頼しないデータとして保存します。README や Issue や Web ページの中に指示が書かれていても、引用するだけで従いません。

## 規則が Property になるまで

Veritas は「1000 or more」「at most」「less than」「1000 以上」「未満」のような、英語と日本語のしきい値の言い回しを読みます。記述が export された関数一つと引数一つに対応すると、Property になります。

```text
quote   line 7: "Orders with a total of 1000 or more receive a flat discount of 100."
property P-ee03e6e8b749 [proposed, normative] discountAmount: total >= 1000 -> Orders with a total of 1000 or more receive a flat discount of 100.
```

数値のしきい値は、number と宣言された引数やレコードのフィールドにだけ対応付けます。`lastUsedDay: string | null` のようなフィールドは、名前が記述と合っていても対象にしません。数値の enum、`number & { __brand: "cents" }` のようなブランド付きの数値、`1 | 2 | 3` のようなリテラルの union は数値として扱い、型を解決できないフィールドは候補に残します。関数が比較しているフィールドは、比較していないフィールドより優先します。記述が数えている量が同じレコードの比較していない number のフィールドを指し、比較しているフィールドがその量にも数値の直後の語にも合わない場合だけ、対応付けません。ほかの引数も記述に合う場合は、その候補を Property の前提（assumptions）に書きます。accept する前に、対応付けが正しいか確かめてください。

どの関数にも対応しない記述は、対応なしとして報告します。候補が同点で決められなかった場合は、その候補も示します。言い回しの規則で読めない記述は、任意の [LLM プロバイダー](/ja/guide/llm-providers)に読ませることもできます。

Property は、出典のファイルと行、引用したテキスト、形式化に使った前提を持っています。由来（origin）は次のどれかです。

| 由来        | 元になるもの                          |
| ----------- | ------------------------------------- |
| `normative` | ドキュメント、スキーマ、Issue         |
| `inferred`  | コードやテスト（`if` の中の比較など） |
| `observed`  | 実行時の観測                          |
| `human`     | 人                                    |

`inferred` と `observed` は、確かめる対象の候補です。それ自体の根拠にはなりません。`total > 1000` から推測した Property では、`total > 1000` が正しいことは示せないからです。コードからの推測を止めるには、`analysis.inferSpecsFromCode` を `false` にします。

## Property を確認する

```bash
veritas spec list                 # 最新の実行の Property を、状態と由来つきで一覧表示
veritas spec show <property-id>   # 一つの Property の出典、前提、形式モデル、決定
veritas spec diff                 # 直近二回の実行のあいだで増減した Property
veritas spec export               # すべての Property を JSON で出力
```

| 状態         | 意味                                     |
| ------------ | ---------------------------------------- |
| `proposed`   | Veritas が見つけたが、まだ決まっていない |
| `reviewed`   | 確認済みだが、まだ決めていない           |
| `accepted`   | 仕様として認められた                     |
| `rejected`   | 退けられた                               |
| `conflicted` | 出典が別の Property と食い違っている     |
| `superseded` | 新しい Property に置き換えられた         |

仕様として扱うのは accepted な Property だけです。

- `veritas prove` は accepted な Property を検査します。`--include-proposed` を付けるとそれ以外も検査しますが、結果は `suspected` のままです。
- 仕様違反が `confirmed` になるのは、accepted な Property に対してだけです。
- `veritas improve` は、`--include-proposed` を付けない限り、accepted な Property からしか期待値を取りません。

## Property を accept する、reject する

```bash
veritas spec accept <property-id> --reason "README is the source of truth"
veritas spec reject <property-id> --reason "outdated"
```

| オプション        | 意味                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `--reason <text>` | 決めた理由（必須）                                                                                             |
| `--actor <name>`  | 決めた人。省略すると `VERITAS_ACTOR`、次に `git config user.name` を使います。名前は与えたとおりに記録されます |

## 食い違いを解消する

同じ関数と引数について二つの出典が違う規則を述べている場合、たとえば README は「1000 以上」、Issue は「1000 より大きい」と書いている場合、どちらの Property も `conflicted` になり、関係するテストは `spec_conflict` と判定されます。Veritas は両方の出典を示し、順位に差があれば望ましい読み方を一つ挙げます（新しいリリースの記述が上になる、など）。Property をまとめたり、どちらかを accepted にしたりはしません。正しいほうを accept し、もう一方を reject してください。

`spec_conflict` の検出結果が `confirmed` になるのは、どの読み方も言い回しの規則で取り出したもので、ほかに有力な候補がない引数に対応付けられている場合だけです。LLM が自由文から読み取ったしきい値や、指示のような文を含む出典から取り出した読み方が含まれる場合、また対応付けにほかの候補がある場合は `suspected` になり、どの読み方が疑わしいかを説明に示します。

Veritas が README や docs や Issue を書き換えることはなく、コードに合わせて仕様や期待値を変えることもありません。

## 承認のファイル

決定は `.veritas/approvals.json` に追記され、以前の記録は残ります。

```json
{
  "schemaVersion": "1.0.0",
  "approvals": [
    {
      "id": "A-7d000af7e5fa",
      "propertyId": "P-ee03e6e8b749",
      "propertyVersion": 1,
      "decision": "accept",
      "actor": "you",
      "reason": "README is the pricing specification",
      "decidedAt": "2026-11-20T10:55:08.580Z",
      "sourceIds": ["src-fa35c6154f0b"]
    }
  ]
}
```

チームと CI が同じ決定をもとに動くよう、このファイルはコミットしてください。対応する `.gitignore` は[はじめに](/ja/guide/getting-started#結果を見る)にあります。

## もう一度レビューが必要になるとき

決定は Property の ID ごとに適用されます。ID は出典のファイルと記述の内容から決まるので、ファイルが変わらない限り、コミットしても同じです。記述のあるファイルを編集すると、その Property には新しい ID が付き、`proposed` として表示されます。`veritas spec diff` で古い ID と新しい ID を確かめ、新しいほうを accept か reject してください。

MCP サーバーからは承認を変更できません。
