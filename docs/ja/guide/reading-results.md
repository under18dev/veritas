# 結果の読み方

実行が終わると、verdict（判定）、終了コード、finding（指摘）の一覧、テストごとの評価が出ます。このページでは、それぞれの読み方を説明します。正確な定義は[セマンティクス](/ja/concepts/semantics)にあります。

## verdict と終了コード

| verdict              | 終了コード | 意味                                                                                              |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `pass`               | `0`        | すべてのステージが成功し、結論の出ていないものも確認すべきものもない                              |
| `pass_with_warnings` | `0`        | ポリシー違反はないが、確認すべき finding か、結論の出ていない結果がある（理由として列挙されます） |
| `policy_failure`     | `1`        | 確定した仕様違反があるか、設定したしきい値を満たしていない                                        |
| `inconclusive`       | `4`        | 決着しなかったものがあり、`policy.inconclusiveBehavior` が `fail`                                 |
| `tool_error`         | `3`        | ステージが失敗したか、エラーで終わった                                                            |

終了コード `2` は、設定や使い方の誤りです。たとえば `.veritas/config.json` がない（`CONFIG_MISSING`）、承認トークンが違う、といった場合です。エラーは `error[CODE]: message` の形で表示され、続く `hint:` の行に対処が書かれます。

ポリシー違反になるのは、確定した finding だけです。suspected の finding で失敗することはありません。結論の出ていない結果があると、verdict は `pass` になりません。既定の `warn` ポリシーでは `pass_with_warnings` になり、結論の出ていない項目が一つずつ列挙されます。

`--json` を付けると、標準出力には JSON の結果（`status`、`exitCode`、`runId`、`dir`、`reasons`、`stages`、`findings`）だけが出て、ログは標準エラー出力に出ます。

## ステージ

実行結果の各行はステージとその状態です。成功は `succeeded` だけです。`failed` と `error` はツールのエラー、`partial`、`skipped`、`unsupported`、`timeout`、`cancelled` は結論が出ていない状態です。

## finding

```text
F-19b3dd55c936  [confirmed high] src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)
```

finding には、変わらない ID、種類（kind）、確度（certainty）、重大度（severity）があります。

| 確度            | 意味                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`     | 実際の実行（mutation testing や、JavaScript で再実行した反例）に裏付けられている。仕様違反の場合は、accepted な Property に対するもの |
| `suspected`     | ありそうだが、人の確認が要る（たとえば Property がまだ proposed）                                                                     |
| `informational` | 制約や限界の説明                                                                                                                      |

重大度は `critical`、`high`、`medium`、`low`、`info` のどれかです。

| 種類                           | よくある原因                                                |
| ------------------------------ | ----------------------------------------------------------- |
| `spec_implementation_mismatch` | コードが、ドキュメントに書かれた規則と合わない              |
| `counterexample`               | property-based testing かソルバーが、違反する入力を見つけた |
| `spec_violation_candidate`     | 仕様から作ったテストが、今のコードでは失敗する              |
| `spec_conflict`                | 二つの出典が、違う規則を述べている                          |
| `survived_mutant`              | 仕様に関わるコードの変更に、どのテストも気づかない          |
| `test_gap`                     | 境界や振る舞いが確かめられていない                          |
| `tautological_test`            | テストがプロジェクトの振る舞いを確かめていない              |
| `unsupported_semantics`        | 形式検証の対応範囲の外にあるコード                          |
| `stage_failure`                | ステージが結果を出せなかった                                |

表の最初の三種類で確度が confirmed のものは仕様違反として扱われ、既定の `policy.confirmedViolation: fail` では終了コード `1` になります。

## finding の根拠をたどる

```bash
veritas explain <finding-id>
```

`explain` は、出典と引用した行、Property、そのコードを呼ぶテストと評価、mutant、ソルバーの結果と SMT や Lean のファイルのパスを順に表示します。最後の行には、次にすべきことが書かれます。全体の例は[チュートリアル](/ja/guide/tutorial)にあります。

## テストの判定

テストごとに、次の五つのどれかになります。

| 判定                           | 意味                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `meaningful_with_evidence`     | プロジェクトの関数を呼んで結果を assert し、仕様に関わる mutant を kill し、境界を決める入力をすべて assert している             |
| `weak_or_incomplete`           | 何かは確かめているが、関係する mutant が生き残っているか、境界を試していない                                                     |
| `tautological_or_disconnected` | プロジェクトの振る舞いを確かめていない（定数の比較だけ、対象の関数を呼ばない など）                                              |
| `spec_conflict`                | 出典どうしが食い違っている Property に関わっている                                                                               |
| `inconclusive`                 | 判断する根拠が足りない。たとえば、その実行に mutation testing の結果がない、動的 import や子プロセスを経由してコードを呼んでいる |

判定は evidence vector を短くまとめたもので、成績ではありません。

## evidence vector

`assessments.json` の各評価には次の項目があり、まとめた点数はありません。

| 項目                     | 中身                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `specificationRelevance` | テストが関わる Property と、そのレビューの状態                       |
| `assertionRelevance`     | `checks_result`、`weak`、`none`、`unknown` のどれか                  |
| `mutationDetection`      | このテストが kill した mutant、生き残った mutant、その他             |
| `boundaryCoverage`       | 関係する境界と、テストがそれを試しているか（`yes`、`no`、`unknown`） |
| `formalEvidence`         | 関係する Property についての形式検証の結果の ID                      |
| `sourceConfidence`       | 仕様の出典の質についての記録                                         |
| `unknowns`               | 分からなかったことを文章で                                           |

テキストのレポートでは、同じ内容が理由の行として出ます。

```text
T-97fef42e4cf7: weak_or_incomplete; rationale boundary not exercised: total >= 1000 (decisive inputs 999, 1000; asserted: none); formal evidence C-87dadbbd7b6a counterexample_found (conformance, assurance none); unknowns no mutation results for this run; detection power not measured
```

## 検証の状態

形式検証（Z3、Lean）の結果は、次のどれかの状態になります。

| 状態                   | 意味                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `proven_within_model`  | 示したモデル、値の範囲、前提の中では反例がない                               |
| `counterexample_found` | ソルバーが違反する入力を見つけ、JavaScript で再実行しても同じ結果になった    |
| `semantic_mismatch`    | ソルバーの反例が JavaScript では再現しない。モデルとコードの意味がずれている |
| `unknown`              | ソルバーが答えを出さなかった                                                 |
| `timeout`              | ソルバーが制限時間（`formal.maxSolverMs`）内に終わらなかった                 |
| `unsupported`          | コードか Property が対応範囲の外にある                                       |
| `error`                | ツールが失敗した                                                             |

`unknown`、`timeout`、`unsupported`、`semantic_mismatch`、`error` を成功として数えることはありません。どれも問いに答えが出なかったという意味で、答えの出ていない問いを「検査に通った」とは報告しないからです。これらがあると実行は inconclusive になり、CI で失敗にするかどうかは `policy.inconclusiveBehavior` で決まります。

結果には保証の強さ（assurance）も付きます。Z3 は `smt_bounded`、`sorry`、`admit`、追加の公理を使わない Lean の証明は `kernel_checked`、それ以外は `none` です。詳しくは[検証](/ja/guide/verification)を参照してください。

## mutant の状態

| 状態                                                       | 意味                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `killed`                                                   | mutant のもとで、少なくとも一つのテストが失敗した                                                  |
| `survived`                                                 | テストは mutant を実行したが、どれも失敗しなかった。テストの穴の候補で、バグや等価性の証明ではない |
| `timeout`                                                  | mutant のもとでテストが終わらなかった。検出したものとして数えるが、特定のテストの kill にはしない  |
| `suspected_equivalent`                                     | 違いは観測されなかったが、等価だとは示せていない                                                   |
| `equivalent_proven`                                        | 示した有界の範囲では、元のコードと区別できる入力がない                                             |
| `compile_error`、`runtime_error`、`ignored`、`no_coverage` | mutation testing のバックエンドが報告した状態                                                      |
| `pending`、`unknown`                                       | 実行していないか、Veritas が知らない状態。mutation のステージが `partial` になる                   |

生き残った mutant を、それだけで等価とみなすことはありません。`equivalent_proven` になるのは、範囲を限った等価性の証明があるときだけです。

## レポート

```bash
veritas report                        # 最新の実行のテキスト要約
veritas report --format markdown
veritas report --format html > report.html
veritas report --format sarif > veritas.sarif
veritas report --format json
veritas report --run <run-id>         # 最新ではなく指定した実行
```

実行ごとに、`report.json`、`report.md`、`report.html`、`report.sarif` も実行ディレクトリに書き出されます。レポートは十の節からなります。実行の情報、集めた根拠、Property の一覧、仕様と実装の食い違い、テストと Property の対応表、mutation testing の結果、形式検証の結果、テストの評価、改善の提案、制約です。形式と成果物のファイルは[レポートと成果物](/ja/reference/reports)で説明しています。
