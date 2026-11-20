# 結果の読み方

Veritas の出力に出てくる verdict（判定）、終了コード、finding（指摘）、テストの判定、各種の状態の意味を説明します。正確な定義は[セマンティクス](/ja/concepts/semantics)にあります。

## verdict と終了コード

どの実行も、最初の行に両方が出ます。

```text
run run-20261120T105508829Z-000-017911  verdict: policy_failure (exit 1)
```

| verdict              | 終了コード | 意味                                                                    |
| -------------------- | ---------- | ----------------------------------------------------------------------- |
| `pass`               | `0`        | すべてのステージが成功し、結論の出ていないものも確認すべきものもない    |
| `pass_with_warnings` | `0`        | ポリシー違反はないが、確認すべき finding か、結論の出ていない結果がある |
| `policy_failure`     | `1`        | 確定した仕様違反がある、または設定したしきい値を満たしていない          |
| `tool_error`         | `3`        | ステージが失敗した                                                      |
| `inconclusive`       | `4`        | 決着しなかったものがあり、`policy.inconclusiveBehavior` が `fail`       |

終了コード `2` は設定や使い方の誤りです。`error[CODE]: message` と、対処を書いた `hint:` の行が出ます。

```text
error[APPROVAL_MISMATCH]: the approval token does not match plan IP-a14164357e16 (the plan changed or the token is wrong)
hint: review the plan again with `veritas improve --dry-run` and use the token it prints
```

ポリシー違反になるのは、確定した finding だけです。結論の出ていない結果があると verdict は `pass` にならず、既定の `warn` ポリシーでは `pass_with_warnings` になって、該当する項目が列挙されます。ポリシーの設定は [CI と GitHub Action](/ja/guide/ci)を参照してください。

`--json` を付けると、標準出力には JSON の結果（`status`、`exitCode`、`runId`、`dir`、`reasons`、`stages`、`findings`）だけが出て、ログは標準エラー出力に出ます。

## ステージ

verdict の下のまとまりが、ステージとその状態です。成功は `succeeded` だけです。`failed` と `error` はツールのエラー、`partial`、`skipped`、`unsupported`、`timeout`、`cancelled` は結論が出ていない状態です。

## finding

```text
F-89435b62ae1e  [confirmed high] src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)
```

finding には ID、確度（certainty）、重大度（severity）、種類（kind）があります。

| 確度            | 意味                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `confirmed`     | 実際の実行（mutation testing、JavaScript で再実行した反例）で示された。仕様違反の場合は Property が accepted |
| `suspected`     | 確認が必要。たとえば Property がまだ proposed                                                                |
| `informational` | 解析の限界の説明                                                                                             |

重大度は `critical`、`high`、`medium`、`low`、`info` のどれかです。

| 種類                           | よくある原因                                              |
| ------------------------------ | --------------------------------------------------------- |
| `spec_implementation_mismatch` | コードが、ドキュメントに書かれた規則と合わない            |
| `counterexample`               | property-based testing かソルバーが違反する入力を見つけた |
| `spec_violation_candidate`     | 仕様から作ったテストが、今のコードでは失敗する            |
| `spec_conflict`                | 二つの出典が違う規則を述べている                          |
| `survived_mutant`              | 規則に関わるコードを変えても、どのテストも気づかない      |
| `test_gap`                     | 境界や振る舞いが確かめられていない                        |
| `tautological_test`            | テストがプロジェクトの振る舞いを確かめていない            |
| `unsupported_semantics`        | 形式検証の対応範囲の外にあるコード                        |
| `stage_failure`                | ステージが結果を出せなかった                              |

最初の三種類で `confirmed` のものは仕様違反です。既定の `policy.confirmedViolation: fail` では終了コード `1` になります。

## finding の根拠を見る

```bash
veritas explain <finding-id>
```

`explain` は最新の実行を読み、出典と引用した行、Property、そのコードを呼ぶテストと評価、mutant、ソルバーの結果とファイル、次にすべきことを表示します。例は[チュートリアル](/ja/guide/tutorial#_3-finding-の根拠を見る)にあります。

## テストの判定

| 判定                           | 意味                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `meaningful_with_evidence`     | プロジェクトの関数の結果を assert し、仕様に関わる mutant を kill し、境界を決める入力をすべて assert している    |
| `weak_or_incomplete`           | 何かは確かめているが、関係する mutant が生き残るか、境界を試していない                                            |
| `tautological_or_disconnected` | プロジェクトの振る舞いを確かめていない（定数の比較だけ、対象の関数を呼ばない など）                               |
| `spec_conflict`                | 出典が食い違っている Property に関わっている                                                                      |
| `inconclusive`                 | 根拠が足りない。その実行に mutation testing の結果がない、動的 import や子プロセスを通してコードを呼んでいる など |

判定は、次の evidence vector を短くまとめたもので、成績ではありません。

## evidence vector

`assessments.json` の各評価には次の項目があり、まとめた点数はありません。

| 項目                     | 中身                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `specificationRelevance` | テストが関わる Property と、そのレビューの状態               |
| `assertionRelevance`     | `checks_result`、`weak`、`none`、`unknown` のどれか          |
| `mutationDetection`      | kill した mutant、生き残った mutant、その他                  |
| `boundaryCoverage`       | 関係する境界と、それを試しているか（`yes`、`no`、`unknown`） |
| `formalEvidence`         | 関係する Property についての形式検証の結果の ID              |
| `sourceConfidence`       | 仕様の出典の質についての記録                                 |
| `unknowns`               | 分からなかったこと                                           |

`veritas report` では、同じ内容が理由の行として出ます。

```text
T-97fef42e4cf7: weak_or_incomplete; rationale boundary not exercised: total >= 1000 (decisive inputs 999, 1000; asserted: none); formal evidence C-8aad536f8e71 counterexample_found (conformance, assurance none); unknowns no mutation results for this run; detection power not measured
```

## 検証の状態

| 状態                   | 意味                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `proven_within_model`  | 示したモデル、値の範囲、前提の中では反例がない                            |
| `counterexample_found` | ソルバーが違反する入力を見つけ、JavaScript で再実行しても同じ結果になった |
| `semantic_mismatch`    | ソルバーの反例が JavaScript では再現しない                                |
| `unknown`              | ソルバーが答えを出さなかった                                              |
| `timeout`              | `formal.maxSolverMs` の制限時間に達した                                   |
| `unsupported`          | コードか Property が対応範囲の外にある                                    |
| `error`                | ツールが失敗した                                                          |

`unknown`、`timeout`、`unsupported`、`semantic_mismatch`、`error` は、問いに答えが出なかったことを表すので、成功としては数えません。実行は inconclusive になり、CI で失敗させるかは `policy.inconclusiveBehavior` で決まります。各エンジンと、保証の強さ `smt_bounded` と `kernel_checked` については[検証](/ja/guide/verification)を参照してください。

## mutant の状態

| 状態                                                       | 意味                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `killed`                                                   | mutant のもとで、少なくとも一つのテストが失敗した                                                      |
| `survived`                                                 | テストは mutant を実行したが、どれも失敗しなかった。テストの穴の候補で、バグや等価性を示すものではない |
| `timeout`                                                  | mutant のもとでテストが終わらなかった。検出として数えるが、どのテストの kill にもしない                |
| `suspected_equivalent`                                     | 違いは観測されなかったが、等価だとは示せていない                                                       |
| `equivalent_proven`                                        | 示した有界の範囲に、元のコードと区別できる入力がない                                                   |
| `compile_error`、`runtime_error`、`ignored`、`no_coverage` | mutation testing のバックエンドが報告した状態                                                          |
| `pending`、`unknown`                                       | 実行していないか、認識できない状態。mutation のステージが `partial` になる                             |

生き残った mutant が `equivalent_proven` になるのは、有界の等価性の証明があるときだけです。

## レポートを出力する

```bash
veritas report                          # 最新の実行のテキスト要約
veritas report --format markdown
veritas report --format html > report.html
veritas report --format sarif > veritas.sarif
veritas report --format json
veritas report --run <run-id>           # 指定した実行
```

実行ごとに `report.json`、`report.md`、`report.html`、`report.sarif` も実行ディレクトリに書き出されます。節の構成とファイルは[レポートと成果物](/ja/reference/reports)にあります。
