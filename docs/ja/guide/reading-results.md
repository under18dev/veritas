# 結果の読み方

Veritas の出力には、verdict（判定）、終了コード、finding（指摘）、テストの判定、各種の状態が出てきます。以下はその読み方で、正確な定義は[セマンティクス](/ja/concepts/semantics)にあります。

## verdict と終了コード

`veritas run` と `veritas prove` は、最初の行に両方を表示します。

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

finding のうちポリシー違反になるのは確定したものだけで、`maxNewSurvivors` や `minPropertyCoverage` のしきい値を満たさない場合もポリシー違反になります。結論の出ていない結果があると verdict は `pass` にならず、既定の `warn` ポリシーでは `pass_with_warnings` になって、該当する項目が列挙されます。ポリシーの設定は [CI と GitHub Action](/ja/guide/ci)を参照してください。

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

| 判定                           | 意味                                                                                                                                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meaningful_with_evidence`     | プロジェクトの関数の結果を assert し、仕様に関わる mutant を kill し、境界を決める入力をすべて assert している                                                                                                                                                                |
| `weak_or_incomplete`           | 何かは確かめているが、関係する mutant が生き残るか、境界を試していない                                                                                                                                                                                                        |
| `tautological_or_disconnected` | プロジェクトの振る舞いを確かめていない（定数の比較だけ、対象の関数を呼ばない など）                                                                                                                                                                                           |
| `spec_conflict`                | 出典が食い違っている Property に関わっている                                                                                                                                                                                                                                  |
| `inconclusive`                 | 根拠が足りない。その実行に mutation testing の結果がない、動的 import や子プロセスを通してコードを呼んでいる、型だけを検査している（`expectTypeOf`、`assertType`、`Expect<Equal<A, B>>` のような型エイリアス）、呼び出す関数を呼び出し側が渡す共通の suite に属している、など |

判定は、次の evidence vector を短くまとめたもので、成績ではありません。

### プロジェクトのコードを確かめているとみなす条件

assert がプロジェクトのコードが生んだものを見ていれば、そのテストはプロジェクトのコードを確かめているとみなします。ふつうの関数なら、戻り値、関数が書き換えたオブジェクト、テストから渡したコールバックや `vi.fn()` のモックがどう呼ばれたか、が対象です。

コンポーネントと hook のテストも同じ考え方で読みます。プロジェクトのコンポーネントは、その JSX 要素がマウントされたときに呼んだとみなします。マウントとは、要素が `render`（`rerender`、`hydrate` も含む）に渡されること、それを `render` に渡すテストコードやプロジェクトのヘルパーに渡されること、戻り値がそうなるコンポーネントやファクトリーから返されること、そうなるローカル変数に入れられることです。要素を調べるだけのヘルパーに渡しても数えません。prop として渡した要素や、Veritas がコードを読めるコンポーネントの子要素として渡した要素は、そのコンポーネント自身のコードがそれを描画する場合に限って数えます。したがって、`Providers` が `<section>{children}</section>` を返すとき、`render(<Providers><Dialog /></Providers>)` のようにコンポーネントを包むプロジェクトのプロバイダーは引き続き数えます。子要素は、`Providers` の要素がマウントされたときにちょうどマウントされるからです。要素そのものの記述（`ui.props.title`）を読むのは、コンポーネントが描画したものを読むことにはなりません。Testing Library を名前空間として import した場合（`import * as rtl from '@testing-library/react'`）も、名前付きの import と同じように読みます。テストが `render(<Dialog />)` と直接書いても、外側の `describe` の `beforeEach` で描画しても（`beforeAll` やモジュール、`describe` の直下での描画は数えません。Testing Library はテストのたびにページを片付けるので、確実なのは `beforeEach` です）、それを行う `renderDialog()` のようなローカルのヘルパーを呼んでも、ローカルのラッパーコンポーネントを描画しても同じです。ローカルのラッパーコンポーネントでは、返す JSX に届くものだけを描画したとみなします。ページに描画しないレンダラー（`renderToString` によるサーバーレンダリング、react-test-renderer の `create`、Enzyme の `shallow` と `mount`）はコンポーネントを実行しますが、数えるのはレンダラー自身の出力だけで、そのあとのページの読み取りは数えません。`expect(<Dialog />).toBeTruthy()` のように要素を作るだけなら、呼んだとはみなしません。`renderHook` の中で呼んだプロジェクトの hook も呼んだとみなします。そのうえで、次の assert はコンポーネントや hook を確かめているとみなします。

- プロジェクトのコンポーネントを描画したあとに行った、Testing Library によるページの問い合わせ（`screen.getByText`、`within(...)`、`render` が返すクエリ）や、グローバルな `document` の読み取り
- `renderHook` が返す `result.current`
- コンポーネントや hook に渡したモックへの `toHaveBeenCalled*` や `.mock.calls`。prop や引数として直接渡した場合のほか、props オブジェクトに入れて渡した場合（`render(<Dialog {...props} />)` で `props.onSave` を確かめる）や、ローカルのヘルパーやファクトリーが渡したり返したりした場合も含みます

次のものは、確かめているとはみなしません。

- プロジェクトのコードに渡していないモック。モックをまとめたオブジェクトのうち、渡したものとは別のメンバー（`onSave={mocks.onSave}` は `mocks.track` を含みません）
- テスト自身が props オブジェクトに入れた値
- あとに書いた属性やスプレッドが置き換える prop（`<Dialog {...props} onSave={undefined} />` は `props.onSave` を渡しません）
- テスト自身も呼んでいるモックの呼び出し。`toHaveBeenCalled` などのマッチャーでも `.mock.calls` でも同じです
- コンポーネントを描画する前に行ったページの読み取り（`render` の前の `const before = screen.queryByText('x')`）や、テスト自身がページに書いたものの読み取り（`document.body.className = 'dark'`）。書き込みは、テストの前に動く `beforeEach` などの共通の準備によるものも含め、そのコードが実行される場合に限って数えます。どこからも呼ばれないヘルパーの中や、テストがイベントを起こさないときのイベントリスナーの中の書き込みは数えません。テストがページに中身を入れたあと（`innerHTML` や `appendChild` など。`const body = document.body` のようなローカル変数を通した場合も含みます）は、その中身を見つけるかもしれないので、それ以降のページの読み取りはすべて数えません。ただし、`document.createElement` で作って中身を入れずに追加した要素は、テキストによる問い合わせでは見つからないので、役割やページの構造による問い合わせだけを数えません
- 描画されたページから得たものではない要素（`document.createElement('div')` など）に対する `within(...)` の問い合わせ
- どこからも呼ばれない関数が返す要素
- プロジェクトのものを何も描画していないときのページの問い合わせ。サードパーティのコンポーネントだけを描画するテストは引き続き報告されます

また、テストの中で子要素にプロジェクトのコンポーネントを含まないプロジェクトのコンポーネントは、ページの問い合わせだけでは確かめたとみなしません。`<Providers><Button>Go</Button></Providers>` や、渡されたものを包むだけのプロバイダー用ヘルパーがこれにあたり、問い合わせはテストが渡した子要素しか見つけていないかもしれないからです。そのため、`<Card>Body</Card>` のようなコンポーネントで、カード自身が描画するものを問い合わせる場合も対象外になります。ほかの assert で結びつかない限り、そのテストは報告されます。

プロジェクトのコードが内部で呼ぶ `vi.mock` したモジュールや、グローバルなオブジェクトへの spy は、まだテスト対象のコードと結びつけられません。それらだけを確かめるテストは `tautological_or_disconnected` と報告されるので、finding に対応する前にテストの中身を読んでください。

解析の対象に含まれるファイルでも、Vitest の実行時の機能（`expect`、`assert`、`vi`、または `import * as vitest from 'vitest'`）を import していれば、置き場所にかかわらずテストコードとして扱います。テストの実行中にしか動かないからです。そのため、`src/test-utils.ts` のようなモック用のユーティリティはプロジェクトのコードとして数えません。その反面、そうしたファイルに本物の関数を置くと、その関数もプロジェクトのコードとして数えないので、その関数だけを呼ぶテストはプロジェクトの振る舞いを確かめていないと報告されます。プロジェクトのコードであれば、そのファイルから移してください。

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

`veritas run` と `veritas prove` は、`reports.formats` に指定したレポートファイル（既定では `report.json`、`report.md`、`report.html`、`report.sarif`）も実行ディレクトリに書き出します。ほかのコマンドの実行については、`veritas report` で必要なときに出力できます。節の構成とファイルは[レポートと成果物](/ja/reference/reports)にあります。
