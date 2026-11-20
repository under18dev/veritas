# 仕様の確定

Veritas はテストを仕様と照らし合わせますが、その仕様は、プロジェクトがすでにドキュメントに書いているものから取ります。何が仕様かを Veritas が自分で決めることはありません。Property はすべて `proposed` から始まり、accepted にできるのは人だけです。

## 記述を集める出典

`veritas discover`（と `veritas run` の `discover` ステージ）は、次の出典から根拠を集めます。

| 出典                   | 読むもの                                                                                            | 既定 |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ---- |
| README                 | `README*` のファイル                                                                                | オン |
| ドキュメント           | `docs/**/*.md`、`CHANGELOG*`、`RELEASE*`                                                            | オン |
| コードのコメント       | `analysis.include` に当てはまるファイルの、export された宣言の JSDoc                                | オン |
| スキーマ               | OpenAPI と JSON Schema の範囲指定（`openapi.{json,yaml}`、`*.openapi.*`、`*.schema.*`）             | オン |
| git の履歴             | `git log`                                                                                           | オン |
| エクスポートした Issue | `.veritas-sources/issues/` と `.veritas-sources/pulls/` の JSON ファイル                            | オン |
| GitHub API             | `sources.github.repo` の Issue とプルリクエスト                                                     | オフ |
| Web                    | `sources.web.allowDomains` のドメインのページ。ページ数、リンクの深さ、文字数、時間に上限があります | オフ |

ネットワーク上の出典を使うには、設定で有効にしたうえで、`--offline` を付けずに実行する必要があります。Web の場合は、`sources.web.enabled` を `true` にし、ドメインを許可します。

```bash
veritas discover --sources local,web --allow-domain docs.example.com --max-pages 10
```

`--allow-domain` と `--max-pages` は、その実行に限って設定を追加したり絞ったりするだけで、これだけでは Web の収集は有効になりません。GitHub の出典は、`GITHUB_TOKEN` が設定されていればそれを送ります。

集めたテキストは、信頼しないデータとして保存します。README や Issue や Web ページの中に指示が書かれていても、それに従うことはなく、引用するだけです。

## 記述から Property へ

記述の抽出には、英語と日本語のしきい値の言い回し（「1000 or more」「1000 以上」「at most」「未満」など）を読む規則を使います。規則で読めない記述は、任意で LLM に読ませることもできます（[LLM プロバイダー](/ja/guide/llm-providers)を参照）。記述は、export された関数一つとその引数一つに結び付けられたとき、Property になります。

```text
quote   line 7: "Orders with a total of 1000 or more receive a flat discount of 100."
property P-7f8d3341340c [proposed, normative] discountAmount: total >= 1000 -> Orders with a total of 1000 or more receive a flat discount of 100.
```

どの Property も出どころを保持しています。出典、ファイルと行番号（`README.md:7`）、引用したテキスト、形式化するときに置いた前提です。`veritas spec show <id>` で、形式モデルと一緒に確認できます。どの関数に当たるかはっきりしない記述は、結び付けないまま「対応なし」として報告し、推測で埋めることはしません。

Property には由来（origin）があります。

| 由来        | 元になるもの                               |
| ----------- | ------------------------------------------ |
| `normative` | ドキュメント、スキーマ、Issue              |
| `inferred`  | コードやテスト（たとえば `if` の中の比較） |
| `observed`  | 実行時の観測                               |
| `human`     | 人                                         |

`inferred` と `observed` は、何を確かめるべきかの仮説です。それ自体の根拠にはなりません。`total > 1000` から推測した Property で、`total > 1000` が正しいと確かめることはできないからです。この推測を止めるには、`analysis.inferSpecsFromCode` を `false` にします。

## Property の状態の移り変わり

```text
proposed -> reviewed -> accepted
                     -> rejected
                     -> conflicted
                     -> superseded
```

| 状態         | 意味                                                           |
| ------------ | -------------------------------------------------------------- |
| `proposed`   | Veritas が見つけたが、まだ決まっていない。すべてここから始まる |
| `reviewed`   | 確認はしたが、まだ決めていない                                 |
| `accepted`   | 人が仕様として認めた                                           |
| `rejected`   | 人が退けた                                                     |
| `conflicted` | 出典どうしが食い違っていて、人が選ぶ必要がある                 |
| `superseded` | 新しい Property に置き換えられた                               |

仕様として扱われるのは accepted な Property だけです。

- `veritas prove` は accepted な Property を検査します。`--include-proposed` を付けるとそれ以外も検査しますが、結果は `suspected` のままで、実験的な扱いになります。
- 仕様違反が `confirmed` になるのは、accepted な Property に対してだけです。
- `veritas improve` は、`--include-proposed` を付けない限り、accepted な Property からしか期待値を取りません。

## 食い違いはまとめない

同じことについて二つの出典が違う規則を述べている場合、たとえば README は「1000 以上」、あとの Issue は「1000 より大きい」と書いている場合、どちらの Property も `conflicted` になります。Veritas は両方の出典を示し、どちらが望ましいかを提案することもありますが、一方を選んだり、二つをまとめたりはしません。conflicted な Property に関わるテストは `spec_conflict` と判定されます。片方を accepted に、もう片方を rejected にすると、食い違いが解消されます。

また、Veritas は README や docs や Issue を書き換えることはなく、実装に合わせて仕様や期待値を変えることもありません。

## CLI でレビューする

```bash
veritas spec list                      # 最新の実行の Property を、状態と由来つきで一覧表示
veritas spec show <property-id>        # 一つの Property の出典、前提、形式モデル、承認
veritas spec accept <property-id> --reason "README is the source of truth" [--actor <name>]
veritas spec reject <property-id> --reason "outdated" [--actor <name>]
veritas spec diff                      # 直近二回の実行のあいだで増減した Property
veritas spec export                    # 一覧を JSON で出力
```

`--reason` は必須です。決めた人の名前は、`--actor` がなければ `VERITAS_ACTOR`、次に git のユーザー名を使います。名前は与えられたとおりに記録され、本人確認はしません。

## 承認のファイル

決定は `.veritas/approvals.json` に追記されます。

```json
{
  "schemaVersion": "1.0.0",
  "approvals": [
    {
      "id": "A-1ec8b553846d",
      "propertyId": "P-7f8d3341340c",
      "propertyVersion": 1,
      "decision": "accept",
      "actor": "you",
      "reason": "README is the pricing specification",
      "decidedAt": "2026-11-20T10:09:52.777Z",
      "sourceIds": ["src-bd85b3f2deb4"]
    }
  ]
}
```

このファイルは追記だけで、あとから決め直しても以前の記録は消えません。決定は、決めたときのバージョンの Property にだけ適用されます。Property の内容が変わったら、もう一度レビューが必要です。

チーム全員が同じ決定をもとに作業できるよう、承認のファイルはプロジェクトと一緒に管理してください。このファイルを残す `.gitignore` の例は[はじめに](/ja/guide/getting-started#結果の保存先)にあります。

MCP サーバーからは承認を変更できません。Agent Skill に従うエージェントは、どの Property をなぜ決めるのかをあなたが伝えたときだけ、`spec accept` や `spec reject` を実行します。
