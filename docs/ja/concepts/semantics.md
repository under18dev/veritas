# セマンティクス

Veritas が報告する結果には、どれも厳密で限られた意味があります。状態ごとに、その意味と、成り立つモデルと範囲、そう読んではいけない解釈を示します。状態の語彙は固定されていて、ほかの状態を報告することはありません。また、どの状態も、品質や信頼度を表す 1 つのスコアにはまとめません。

## 状態の語彙

| 対象                 | 状態                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 検証（主張）         | `proven_within_model`、`counterexample_found`、`unknown`、`unsupported`、`timeout`、`semantic_mismatch`、`error`                                               |
| 仕様（レビュー）     | `proposed`、`reviewed`、`accepted`、`rejected`、`conflicted`、`superseded`                                                                                     |
| テストの判定         | `meaningful_with_evidence`、`weak_or_incomplete`、`tautological_or_disconnected`、`spec_conflict`、`inconclusive`                                              |
| mutant               | `killed`、`survived`、`timeout`、`compile_error`、`runtime_error`、`ignored`、`no_coverage`、`pending`、`unknown`、`suspected_equivalent`、`equivalent_proven` |
| finding の certainty | `confirmed`、`suspected`、`informational`                                                                                                                      |

## 各状態の意味

| 状態                   | 意味                                                                                       | こう読んではいけない               |
| ---------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `proven_within_model`  | 示したモデル、定義域の範囲、前提のもとで、示した Property の反例をソルバーが見つけなかった | 実装が正しい。仕様が正しい         |
| `counterexample_found` | ソルバーが Property に違反する値の組を出し、JavaScript で再実行しても同じ判定になった      | 仕様の意図に照らしたバグが確定した |
| `semantic_mismatch`    | ソルバーの反例が JavaScript では再現しない。モデルとコードの意味が食い違っている           | バグがある、または証明できた       |
| `unknown`、`timeout`   | ソルバーが答えを出さなかった、またはモデルを JavaScript のコードと比べられなかった         | 成功                               |
| `unsupported`          | コードまたは Property が、対応する部分集合の外にある                                       | 成功                               |
| `error`                | ツールが失敗した                                                                           | 成功                               |

Lean の結果に `kernel_checked` の保証が付くのは、証明が `sorry`、`admit`、`native_decide`、Lean の標準以外の公理を使っていないときだけです（[ADR 0005](/adr/0005-lean-backend)、英語）。これらを使った証明は、検証済みとして扱いません。SMT の結果には `smt_bounded` の保証が付きます。レポートでは、この違いを区別して表示します。

ポリシー違反（終了コード 1）になるのは、仕様違反が確定したときか、ポリシーの基準を満たさなかったときだけで、`suspected` の finding で失敗することはありません（[CLI の終了コード](/ja/reference/cli#終了コード)を参照）。`unknown`、`timeout`、`unsupported` を成功として数えることもありません。`policy.inconclusiveBehavior: warn` のもとでは終了コードは 0 のままですが、verdict は `pass_with_warnings` にとどまり、`pass` にはなりません。

## 何を検査するか

形式的な主張は、どれも「定義域の範囲内のすべての入力について、前提が本体を含意する」という同じ有界なクエリです。主張の種類は、本体がどの関係を表すかを示します。`veritas prove` が検査するのは適合性（conformance）で、ほかの種類には mutation の結果が必要です（`veritas run --profile deep`）。

| 種類                  | 問い                                                                         | `counterexample_found`                                                                          | `proven_within_model`                                               |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `conformance`         | 実装は Property を満たすか                                                   | 満たさない入力。JavaScript で再生したもの                                                       | 範囲内にそのような入力はない                                        |
| `bounded_equivalence` | 生き残った mutant と元のコードを区別できる入力はあるか                       | 区別できる入力（その入力と仕様どおりの結果を使うテストなら、mutant を kill できる）             | 範囲内にはない。その mutant は `equivalent_proven`                  |
| `distinguishability`  | テストがすでに使っている入力で、生き残った mutant と元のコードを区別できるか | テストの入力の 1 つで区別できる。テストは違いに到達しているが、assertion がそれを確かめていない | どの入力でも区別できない。テストには新しい入力が必要                |
| `property_detection`  | Property は mutant と元のコードを区別できるか                                | 元のコードは Property を満たし、mutant は満たさない入力。Property が変更を検出できる            | 範囲内にそのような入力はない。Property はこの mutant を区別できない |

distinguishability が使うのは、引数がすべて定義域内の整数または真偽値のリテラルである呼び出しだけです。それ以外の引数を使うテストには、主張を作りません。mutant に関する 3 種類の関係では、mutant は変更後のソースのモデルとしてだけ存在します。元のコードの側は JavaScript で再生しますが、mutant の側は再生しません。distinguishability と property_detection の検査は 1 回の実行につき最大 40 件で、省略した件数はステージのメッセージに書きます。結論の出ない結果（`unknown`、`timeout`）があると、適合性の場合と同じく、そのステージは partial になります。

## 対応する形式的な部分集合

- 副作用、I/O、async、`this`、変更される状態を捕捉するクロージャ、`eval`、`Proxy` のない純粋な関数
- 引数と戻り値が真偽値か整数であること。整数の引数には、安全な整数の範囲内で、明示的な有界の定義域が必要です（既定は `[-10000, 10000]`）
- 整数と真偽値のプロパティからなるレコードの引数、または整数か真偽値の配列で、要素が `formal.maxArrayLength`（既定は 3、最大 8）個以下の引数。戻り値は整数か真偽値に限ります
- 比較、整数の `+ - *`、論理演算子、`if`/`else`、三項演算子、条件付きの `return`

## レコードと配列

レコードと配列は、スカラーのモデルの引数に展開します。フィールド `order.total` は `order__total` になり、配列 `xs` は長さ `xs__length`（`[0, maxArrayLength]` の範囲）と、要素の枠ごとの引数（`xs__0`、`xs__1`、...）になります。長さ以上の位置にある枠は、JavaScript の値には含まれません。反例は、元の引数の形で表示し、その形で JavaScript で再生します（`{"order":{"total":"1000","vip":false}}`、`{"xs":["7"]}`）。

同じファイルのほかの関数を呼ぶときは、レコードや配列をそのまま渡せます。レコードの引数として渡せるのは、呼び出し先とフィールドの名前と型がまったく同じレコードの引数（宣言した型の名前は違ってもかまいません）か、呼び出し先のフィールドを一度ずつ書いたオブジェクトリテラル（`g({ total: order.total, vip: true })`、または省略記法の `g({ total, vip })`）です。配列の引数として渡せるのは、要素の型が同じ配列の引数です。渡した値は、呼び出し先が宣言したフィールドの順に、呼び出し先の展開した引数になります。この部分集合には代入がないので、レコードを参照で渡しても、呼び出し先が読む値は変わりません。省略可能なフィールドや入れ子のフィールド、フィールドの過不足、スプレッド、計算したキー、メソッド、配列リテラル、そのほかの式をレコードや配列の引数に渡すと、理由を添えて `unsupported` になります。呼び出し先での範囲外の読み取りは、その呼び出しが行われる条件のもとで、呼び出し元の読み取りとして扱います。

`k >= xs.length` のときの `xs[k]` は、JavaScript では `undefined` になりますが、モデルはこれを表しません。そこで、要素を読むたびに、その読み取りが範囲外になる条件を記録します（`if`、三項演算子、`&&`、`||` による条件も考慮します）。Property が `proven_within_model` になるのは、前提を満たす定義域内のどの入力も、そのような読み取りに到達しないことをソルバーが示したときだけです。そうでなければ、長さを超えて読む入力を添えて `unsupported` とし、確認の結論が出なければ `unknown` とします。`maxArrayLength` より長い配列は検証の対象外です。

## JavaScript の数値と整数モデル

モデルは数学的な整数を使い、JavaScript は IEEE-754 の倍精度浮動小数点数を使います。両者が一致するのは、安全な整数だけを扱い、途中の結果が安全な範囲を出ず、除算や小数が現れないときだけです。そのため Veritas は次のようにしています。

- 定義域を安全な整数に限り、途中の結果の範囲も確かめる
- `/`、負になりうる被演算子に対する `%`、`Math.*`、`NaN`、`Infinity`、`-0`、浮動小数点数、`BigInt` との混在、暗黙の型変換は `unsupported` とする
- 反例はすべて JavaScript で再実行し、判定が異なれば `semantic_mismatch` と報告する

## mutant

- `killed`: mutant のもとで、少なくとも 1 つのテストが失敗した。
- `survived`: テストは mutant を実行したが、どれも失敗しなかった。テストの穴の候補であって、バグではありません。
- `suspected_equivalent`: 違いは観測されなかったが、等価であることは示されていない。
- `equivalent_proven`: 示した有界な定義域のどの入力でも区別できない（`bounded_equivalence` の主張）。範囲も結果の一部です。
- `timeout`: mutant のもとでテストの実行が終わらなかった（多くは変更されたループ）。ほかの mutation ツールと同じく検出したものとして数えますが、特定のテストによる kill とはみなしません。仕様に関係する timeout の mutant を通るテストには、それぞれ不明な点としてその mutant を載せます。
- `pending`、`unknown`: mutant を実行しなかった、またはバックエンドが Veritas の知らない状態を報告した。`unknown` の mutant があると mutation のステージは `partial` になり、実行は `pass` になりません。`pending` も同じですが、差分の実行（`--since`）では、変更の外にある mutant を意図して除くので例外です。ただし、mutator の時間予算が尽きて実行しなかった mutant も `pending` になり、この場合は `--since` を付けていてもステージは `partial` になります。

mutator が実行するのは、範囲内の mutant を kill しうるテストファイルだけです。テストファイルを除くのは、そのファイルがプロジェクトのソースを import していて、そのどれも範囲内にないときだけです。次のファイルは常に残します。子プロセスでコードを実行するファイル、実行時にモジュールを読み込むファイル（動的な `import()`、`require`、`createRequire`）、解決できない相対モジュールを import するファイルと、これらに当たるローカルのファイルを import するファイルです。テストを認識できなかったファイルも残します。Vitest の設定（`globalSetup`、プラグイン）を通じてだけプロジェクトに届くコードは見えません。テストがそうしたコードに依存しているなら、それらのテストファイルが範囲内のソースを import するように範囲を設定してください。

## 仕様

- Property は `proposed` から始まります。`accepted` になるのは、明示的な承認の記録があるときだけです。
- コード、テスト、実行時の観測から推測した Property（由来が `inferred` または `observed`）は、それ自体の独立した根拠にはなりません。`analysis.inferSpecsFromCode: false` にすると、コードから推測した候補はそもそも提案しません。
- 出典どうしが食い違うと `conflicted` になります。Veritas は両方の出典を添えて望ましい読み方を提案しますが、どちらかを選ぶことも、1 つの Property にまとめることもしません。
- 仕様や期待値を実装に合わせて変えることはありません。レビューの流れは[仕様の確定](/ja/guide/specifications)を参照してください。

## テストの判定

評価はベクトル（仕様との関係、assertion の関係、mutation の検出、境界の網羅、形式的な根拠、出典の信頼度、不明な点）で表し、`meaningful_with_evidence`、`weak_or_incomplete`、`tautological_or_disconnected`、`spec_conflict`、`inconclusive` のいずれかに要約します。1 つの品質スコアはありません。

テストが `meaningful_with_evidence` になるのは、プロジェクトの関数を呼んで結果を assert する呼び出しが、仕様に関係する mutant を kill し、かつ決め手になる境界の入力をすべて assert しているときだけです。mutation の結果はテストごとに記録します。テストの中のどれかの呼び出しが、TypeScript で解決できなかった相対 import を経由している場合や、テストが子プロセスや動的 import でコードを実行している場合は、そのコードが mutant を検出した可能性があります。そのため判定は `inconclusive` とし、理由を不明な点に載せます。
