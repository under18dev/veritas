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

| 確度            | 意味                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`     | 実際の実行（mutation testing、JavaScript で再実行した反例）で示された。仕様違反の場合は Property が accepted               |
| `suspected`     | 確認が必要。たとえば Property がまだ proposed、または矛盾に LLM が読んだしきい値、指示のような文、曖昧な対応付けが含まれる |
| `informational` | 解析の限界の説明                                                                                                           |

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

コンポーネントと hook のテストも同じ考え方で読みます。プロジェクトのコンポーネントは、その JSX 要素がマウントされたときに呼んだとみなします。マウントとは、要素が `render`（`rerender`、`hydrate` も含む）に渡されること、それを `render` に渡すテストコードやプロジェクトのヘルパーに渡されること、戻り値がそうなるコンポーネントやファクトリーから返されること、そうなるローカル変数に入れられることです。要素を調べるだけのヘルパーに渡しても数えません。prop として渡した要素や、Veritas がコードを読めるコンポーネントの子要素として渡した要素は、そのコンポーネント自身のコードがそれを描画する場合に限って数えます。したがって、`Providers` が `<section>{children}</section>` を返すとき、`render(<Providers><Dialog /></Providers>)` のようにコンポーネントを包むプロジェクトのプロバイダーは引き続き数えます。子要素は、`Providers` の要素がマウントされたときにちょうどマウントされるからです。要素そのものの記述（`ui.props.title`）を読むのは、コンポーネントが描画したものを読むことにはなりません。Testing Library を名前空間として import した場合（`import * as rtl from '@testing-library/react'`）も、名前付きの import と同じように読みます。テストが `render(<Dialog />)` と直接書いても、外側の `describe` の `beforeEach` で描画しても（`beforeAll` やモジュール、`describe` の直下での描画は数えません。Testing Library はテストのたびにページを片付けるので、確実なのは `beforeEach` です）、それを行う `renderDialog()` のようなローカルのヘルパーを呼んでも、ローカルのラッパーコンポーネントを描画しても同じです。ローカルのラッパーコンポーネントでは、返す JSX に届くものだけを描画したとみなします。ページに描画しないレンダラー（`renderToString` によるサーバーレンダリング、react-test-renderer の `create`、Enzyme の `shallow` と `mount`、ページにない `container` を渡した `render`）はコンポーネントを実行しますが、数えるのはレンダラー自身の出力だけで、そのあとのページの読み取りは数えません。Enzyme の `shallow` が実行するのはルートのコンポーネントだけで、その中に入れ子にしたコンポーネントは実行しません。`expect(<Dialog />).toBeTruthy()` のように要素を作るだけなら、呼んだとはみなしません。`renderHook` の中で呼んだプロジェクトの hook も呼んだとみなします。そのうえで、次の assert はコンポーネントや hook を確かめているとみなします。

- プロジェクトのコンポーネントを描画したあとに行った、Testing Library によるページの問い合わせ（`screen.getByText`、`within(...)`、`render` が返すクエリ）や、グローバルな `document` の読み取り
- `renderHook` が返す `result.current` と、`render` が返すもののうちの出力（`container`、`baseElement`、呼び出した `getByText(...)` などのクエリ）。その API（`unmount`、`rerender`、`debug`、呼び出していないクエリ）は数えません。Enzyme の `debug()`、`html()`、`text()` など、ほかのレンダラーの出力メソッドは数えます
- ポータルがマウントされたときに `createPortal` で `document.body` などページの中へ描画したコンポーネント
- コンポーネントや hook に渡したモックへの `toHaveBeenCalled*` や `.mock.calls`。prop や引数として直接渡した場合のほか、props オブジェクトに入れて渡した場合（`render(<Dialog {...props} />)` で `props.onSave` を確かめる）や、ローカルのヘルパーやファクトリーが渡したり返したりした場合も含みます

次のものは、確かめているとはみなしません。

- プロジェクトのコードに渡していないモック。モックをまとめたオブジェクトのうち、渡したものとは別のメンバー（`onSave={mocks.onSave}` は `mocks.track` を含みません）
- テスト自身が props オブジェクトに入れた値
- あとに書いた属性やスプレッドが置き換える prop（`<Dialog {...props} onSave={undefined} />` は `props.onSave` を渡しません）
- 渡す前に読んだモック（描画の前に保存したり確かめたりした呼び出し回数など）
- テスト自身も呼んでいるモックの呼び出し。`toHaveBeenCalled` などのマッチャーでも `.mock.calls` でも同じです
- コンポーネントを描画する前に行ったページの読み取り（`render` の前の `const before = screen.queryByText('x')`）や、テスト自身がページに書いたものの読み取り（`document.body.className = 'dark'`）。書き込みは、テストの前に動く `beforeEach` などの共通の準備によるものも含め、そのコードが実行される場合に限って数えます。どこからも呼ばれないヘルパーの中や、テストがイベントを起こさないときのイベントリスナーの中の書き込みは数えません。テストがページに中身を入れたあと（`innerHTML` や `appendChild` など。`const body = document.body` のようなローカル変数を通した場合も含みます）は、その中身を見つけるかもしれないので、それ以降のページの読み取りはすべて数えません。ただし、`document.createElement` で作って中身を入れずに追加した要素は、テキストによる問い合わせでは見つからないので、役割やページの構造による問い合わせだけを数えません
- 描画されたページから得たものではない要素（`document.createElement('div')` など）に対する `within(...)` の問い合わせ
- どこからも呼ばれない関数が返す要素や、そうした関数の中の呼び出しで描画される要素（テストが呼ぶ描画ヘルパーは、共通の `test-utils` ファイルから export されたものも含め、実行されるものとして扱います）
- テストがイベントを起こさないときに、DOM 要素やサードパーティの要素へイベントハンドラーとして渡したプロジェクトの関数（`<button onClick={handleClick}>`）や、そこに直接書いたハンドラーの中のコード
- プロジェクトのものを何も描画していないときのページの問い合わせ。サードパーティのコンポーネントだけを描画するテストは引き続き報告されます

また、テストの中で子要素にプロジェクトのコンポーネントを含まないプロジェクトのコンポーネントは、ページの問い合わせだけでは確かめたとみなしません。`<Providers><Button>Go</Button></Providers>` や、渡されたものを包むだけのプロバイダー用ヘルパーがこれにあたり、問い合わせはテストが渡した子要素しか見つけていないかもしれないからです。そのため、`<Card>Body</Card>` のようなコンポーネントで、カード自身が描画するものを問い合わせる場合も対象外になります。ほかの assert で結びつかない限り、そのテストは報告されます。

### プロジェクトのコードが読み取る対象に届きうるテスト

テストから渡されていないのにプロジェクトのコードが届くモックやページを確かめるテストがあります。Veritas にわかるのは結びつきがありうることだけなので、これをプロジェクトのコードを確かめているとは数えません。代わりに経路を記録し（呼び出しの `reachedVia`、suspicion の `reachable_by_name`）、テストは `inconclusive` になります。rationale には「project code it calls can reach what it reads (mocked module src/api.ts); not shown to be what the assertion checks」のように書きます。`tautological_test` の finding にはなりません。経路を記録するのは、assert がプロジェクトの呼び出しのあとにあり、その呼び出しから届くコード（呼ばれた関数と、それが名前で使う関数、コンポーネント、値。ほかのプロジェクトのファイルにもたどります）が次のどれかにあたる場合です。

- テストファイルが `vi.mock` で置き換えたモジュールからの import を使っていて、確かめるモックがそのモジュールから import したもの、そのモジュールのモック用ファクトリーが持つもの（`vi.mock('./tabs', () => ({ useTabs: () => ({ remove: h.remove }) }))`）、そのモジュールのモックに設定した値が持つもの（`vi.mocked(load).mockResolvedValue(store)` で `store.set` を確かめる場合）のどれかである（経路 `mocked module …`）
- グローバルな `document` を読んでいて、テストが `document` を通してページを読む（経路 `the page, through the global document`）
- グローバルなオブジェクトやプロトタイプへの spy（`vi.spyOn(Element.prototype, 'scrollIntoView')`）が見張るメンバーにアクセスしている。メンバーは宣言で照らし合わせるので、`Math.log` は `console.log` ではなく、プロジェクトのオブジェクトのメソッドは DOM のメソッドではありません（経路 `spied …`）
- テストがモックを入れたグローバルを読んでいる（`window.monaco = { editor }`、`vi.stubGlobal('fetch', mock)`、引数をグローバルに代入するヘルパー）。プロジェクトのオブジェクトにある同じ名前のメソッドは数えません（経路 `global …`）

テスト自身、またはテストが呼ぶテストコードのヘルパーが、同じモジュール、グローバル、メンバーを使っている場合や、`document` を使っている場合（読み取る内容を書いたかもしれません）、モックをプロジェクトの呼び出しより前に読む場合は、経路を記録しません。経路は実行される内容ではなくコードの名前から判断します。テストが通らない分岐の中の読み取りも数えてしまうことも、結果を `inconclusive` にとどめる理由のひとつです。モックしたモジュールが、テストの import するオブジェクトに書き込む状態（モックしたコンポーネントが埋める `captured.path` など）は静的解析ではたどれません。そうしたテストは引き続き報告されるので、finding に対応する前に中身を読んでください。

### mutation testing による確認

静的解析が結びつきを見つけられなかったというのは推測にすぎないので、mutation の結果で覆ることがあります。静的解析がプロジェクトのコードと結びつけられなかったテストでも、mutant を 1 つ以上 kill していれば、プロジェクトのコードが変わったときに失敗したことになり、プロジェクトの振る舞いを確かめています。この場合は `tautological_test` として報告せず、結果は `inconclusive` にし、rationale には kill した mutant の数を書きます。kill からわかるのはテストがプロジェクトの振る舞いを確かめていることだけで、どの property を確かめているかはわかりません。そのため、assert がプロジェクトのコードと結びつくまでは、`meaningful_with_evidence` や `weak_or_incomplete` にはしません。ただし、何も assert しないテストや、定数だけを比べるテスト（`expect(true).toBe(true)`）は対象外です。こうしたテストが失敗するのは、実行したコードが例外を投げたときだけなので、kill しても結果を確かめていることにはなりません。

mutator は、ある mutant についてテストを実行するとき、最初に失敗したテストでその mutant を打ち切ります。そのため 1 回の実行では、ほかのテストが先に kill した mutant を、あるテストが一度も実行しないことがあります。そこで mutation のステージは、メインの実行のあとに、こうしたテストだけを確かめる小さな実行をもう一度行います。対象はそれらのテストファイルだけで、mutant を作るのは各テストが呼ぶプロジェクトのファイルだけです（何も呼んでいないように見えるテストでは、そのファイルが import するプロジェクトのソースすべて）。すべての mutant ですべてのテストを実行し（`--kill-matrix`）、ソースの 1 行につき実行する mutant は 1 つまでです。時間は、メインの実行のあとに `mutation.timeoutMs` から残った分を使い、`mutation.typecheck` の設定に従います。確認のための時間を残すため、確かめるテストがあり、残りの時間で確認に 1 分以上を回せるときは、メインの実行は `mutation.timeoutMs` の 75% ではなく 55% の時点で新しい mutant を始めなくなります。そうしたときはステージのメッセージに表示します。メインの実行がすでに `--kill-matrix` を使っていたときは、確認を行いません。確かめたテストによる kill はメインの実行の mutant に反映し、メインの実行が手をつけなかった mutant（`pending`）は、この確認で kill されれば `killed` になります。確認の実行で生き残った mutant は、一部のテストしか実行していないので、状態を変えません。ステージのメッセージには、確かめたテストの数、mutant を kill した数、どれも kill しなかった数、mutant を 1 つも実行しなかった数が出ます。詳細は `mutation.json` の `confirmation` にあります。この確認は `mutation.confirmDisconnected: false` で止められます。

確認のあとも報告されるテストには、次のどれかが付きます。

- 「killed none of the N mutant(s) it runs」: テストは mutant を N 個実行しましたが、どれでも失敗しませんでした。わかるのは、その N 個の変更がテストの確かめる内容に影響しなかったことだけです。N が小さいときや、テストが対象とするコードに届く前に確認の時間が尽きたときは、弱い証拠にすぎません。実行したどの mutant も触れていないコード（プロジェクトのコードが呼ぶグローバルなオブジェクトや spy など）を確かめている可能性は十分にあります。N が大きく、mutant がテストの呼ぶコードの中にあるときほど強い証拠になります。対応する前にテストを読んでください。
- 「N other mutant(s) it covers were killed by another test first」: テストはこれらの mutant のコードを通りますが、その mutant では実行されていないので、検出できるかどうかはわかりません。
- どちらもない場合: この実行のどの mutant もそのテストに対して実行されていません。確認を省いた、時間が足りなかった、テストが通るコードから mutant が作られなかった、などの理由です。この場合の finding は静的解析だけに基づきます。

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
