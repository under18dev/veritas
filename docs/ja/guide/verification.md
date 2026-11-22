# 検証

Veritas は、Z3、fast-check、Lean 4 の三つの方法で Property をコードと照らし合わせます。方法ごとに、結果が何を保証するかと、検査を自分で再実行する方法を載せています。

| エンジン   | コマンド                                      | 結果                                        | 対象                                               |
| ---------- | --------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Z3         | `veritas prove`、`veritas run --profile deep` | `smt_bounded` の結果                        | 整数モデルで、範囲内のすべての入力                 |
| fast-check | `veritas run --profile deep`                  | シードを記録した property-based testing     | 抽出した入力を JavaScript で実行                   |
| Lean 4     | `veritas prove --engine lean`                 | `kernel_checked` の結果                     | 関数の Lean モデルについて、カーネルで検査した証明 |
| Z3 + Lean  | `veritas prove --engine both`                 | 両方の結果（Lean は Z3 が証明したものだけ） | 上の二つの両方                                     |

どれも accepted な Property を検査します。`--include-proposed` を付けると proposed な Property も検査しますが、結果は `suspected` のままです。

## Z3 で Property を検査する

```bash
veritas prove
```

```text
succeeded   prove
            P-ee03e6e8b749: counterexample_found {"total":"1000"}
            P-e3003339ad77: proven_within_model
```

`prove` は Property と、そこから呼ばれる関数を SMT-LIB のクエリにし、範囲内に Property を破る入力があるかを Z3 に問います。Z3 は同梱の WebAssembly 版を別プロセスで動かします。

| 設定                    | 既定              | 意味                                       |
| ----------------------- | ----------------- | ------------------------------------------ |
| `formal.integerDomain`  | `[-10000, 10000]` | 整数の入力の範囲                           |
| `formal.maxSolverMs`    | `30000`           | クエリ一つあたりの制限時間                 |
| `formal.maxArrayLength` | `3`               | 配列の引数ごとにモデル化する要素数（1〜8） |

### 対応しているコード

形式検証の対象は、次の条件を満たす純粋な関数です。

- 引数と戻り値が `number`（範囲を限った整数として扱います）か `boolean`
- プロパティがすべて `number` か `boolean` のレコードの引数と、`formal.maxArrayLength` 個までの `number[]` や `boolean[]` の引数
- `if`/`else`、三項演算子、`return`、`const`、`+ - *`、比較、`=== !==`、`&& || !`、同じファイルにある対応範囲内の関数の呼び出し（レコードの引数、呼び出し先とフィールドがまったく同じオブジェクトリテラル、配列の引数を渡せます）

割り算、`%`、`**`、浮動小数点数、`NaN`、`Infinity`、`==`、`??`、暗黙の型変換、ループ、`let`/`var`、非同期処理、副作用、入出力は `unsupported` になります。表の全体は[対応環境](/ja/concepts/support-matrix)にあります。

### 反例の再実行

整数モデルと JavaScript の結果が一致するのは、値が安全な整数に収まっているあいだだけです。そのため Veritas は、反例をすべて実際の関数で実行し直します。実行は制限をかけた Node.js のプロセス（Node.js 25 以上）で行います。

- JavaScript でも同じ違反になれば `counterexample_found` です。
- 結果が違えば `semantic_mismatch` です。`formal.integerDomain` を狭めるか、その関数はテストで確かめてください。

Node.js 25 以上がなければ再実行は行わず、結果は inconclusive です。

### クエリを再実行する

結果ごとに、`.veritas/runs/<run-id>/proofs/` に `<claim>.smt2`（クエリ）、`<claim>.out`（ソルバーの出力）、`<claim>.replay.json`（再実行の記録）が書き出されます。クエリはふつうの SMT-LIB です。

```bash
z3 -smt2 .veritas/runs/<run-id>/proofs/<claim>.smt2
```

### Property、テスト、mutant の関係

どの結果も「範囲内のすべての入力で、前提が成り立てば本体も成り立つか」という同じ形の有界のクエリです。種類（kind）は、本体が表すものを示します。

| 種類                  | 問い                                                             | `counterexample_found`                                           | `proven_within_model`                         |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `conformance`         | 実装は Property を満たすか                                       | 満たさない入力があり、JavaScript でも同じ                        | 範囲内にそのような入力はない                  |
| `bounded_equivalence` | 生き残った mutant を元のコードと区別できる入力はあるか           | ある。その入力を使うテストなら mutant を kill できる             | 範囲内にはない。mutant は `equivalent_proven` |
| `distinguishability`  | テストがすでに使っている入力で、生き残った mutant を区別できるか | できる。違いのある箇所は通っているが、assertion が確かめていない | できない。テストに新しい入力が要る            |
| `property_detection`  | Property は mutant を元のコードと区別できるか                    | Property が変更を検出する入力がある                              | 範囲内では、この mutant を区別できない        |

`veritas prove` が検査するのは conformance です。残りの三つは mutation testing の結果を使い、`veritas run --profile deep` で実行されます。

```text
P-ee03e6e8b749 vs mutant M-5b67ad8e53c8: detects it with {"total":"1000"}
```

distinguishability が使うのは、引数がすべて範囲内の整数か真偽値のリテラルであるテストの呼び出しだけです。distinguishability と property_detection の検査は一回の実行で合わせて 40 件までで、見送った件数が表示されます。

## property-based testing を実行する

`veritas run --profile deep` の `pbt` ステージは、形式化した Property を fast-check の property として、実際の関数に対して実行します。実行は制限をかけた Node.js のプロセス（Node.js 25 以上）で行います。入力は範囲を限った整数、真偽値、それらのレコードと配列で、Property の境界の値も加えます。文字列、浮動小数点数、`NaN` は生成しません。

```text
succeeded   pbt
            P-ee03e6e8b749: passed
```

`pbt.json` には、シード、実行回数、失敗したときの反例と縮小（shrink）の経路が記録されます。実行回数は `pbt.numRuns`（既定 1000）で決まり、シードは `pbt.seed` で固定しない限り Property ごとに決まります。通ったことは、試した入力についての根拠で、証明ではありません。

### property-based testing を再実行する

```bash
veritas test replay PBT-ed9a14f78b2b
```

```text
PBT-ed9a14f78b2b (P-ee03e6e8b749, run run-20261120T105531774Z-000-7ae803, seed -1082472862, 1000 runs)
recorded: passed
replayed: passed
reproduced
```

`test replay` は、記録したシードと縮小の経路でテストを実行し直します。記録どおりなら `0`、違えば `4` で終わります。`--run <run-id>` で実行を指定できます。失敗したテストの ID は、finding の `replay:` の行に出ます。

### テストファイルを生成する

```bash
veritas test generate                   # 形式化したすべての Property
veritas test generate --property <id>   # 一つの Property
veritas test generate --dry-run         # 書き出さずに表示
```

`test generate` は fast-check のテストを `.veritas/generated-tests/<property-id>.test.ts` に書き出します。各ファイルの先頭のコメントに、値の範囲、シード、実行回数が書かれ、accepted でない Property のテストには `[experimental]` が付きます。Veritas はこのファイルを実行しないので、自分のテストと同じように Vitest で実行してください。編集したファイルは、`--force` を付けたときだけ置き換えます。

## Lean 4 で証明する

```bash
veritas prove --engine lean
```

```text
succeeded   prove
            P-ee03e6e8b749 (lean): proven_within_model [kernel_checked]
```

Veritas は関数の Lean モデルと Property の定理を生成し、`lake build` でビルドします。Lean 4 と Lake は [elan](https://github.com/leanprover/elan) で入れてください。`veritas doctor` は `PATH` と `~/.elan/bin` を探します。見つからなければ、Lean の結果は `unsupported` になります。

`kernel_checked` になるのは、ビルドが成功し、定理が `propext`、`Classical.choice`、`Quot.sound` 以外の公理に依存していないときだけです。`sorry`、`admit`、`native_decide`、その他の公理を使った証明は受け入れません。

- Lean が扱うのは整数、真偽値、レコードの引数で、配列を含む Property は `unsupported` です。
- Lean のモデルは Property の形式モデルから生成します。TypeScript のコードと対応しているかは証明されておらず、どの Lean の結果にも semantic gaps として記載されます。
- Lean のビルドには制限時間がありますが、メモリの上限はありません。

両方の根拠がほしいときは、`--engine both` を付けるか、`formal.backend` を `both` にします。すべての Property を Z3 でコードに対して確かめたうえで、Z3 が証明でき、Lean に翻訳できる Property について Lean でも証明を試み、kernel で検査した証明が得られたら 2 つ目の結果として加えます。`both` にしても、Z3 だけのときより結果が悪くなることはありません。

- Z3 が証明できなかった Property（反例、semantic mismatch、`unknown`、timeout）では Lean を飛ばします。Lean は同じモデルを数学的な整数で証明するためです。
- Lean に翻訳できない Property でも Lean を飛ばします。
- Lean が入っていなければ、そのことを 1 行表示し、Z3 の結果だけを記録します。そのため `both` の設定をコミットしても、Lean のないマシンや CI でそのまま使えます。
- Z3 が証明した Property を Lean が証明できなかったときは、ステージのメッセージでそう伝え、Lean の結果は記録しません。Z3 の結果はそのまま有効です。

`--engine` を付けなければ、`prove` は `formal.backend` に従います。以前の `veritas init` が書いた `formal.backend: lean` の設定では、`prove` が Lean を使うようになります。Z3 だけで確かめたいときは `--engine z3` を付けてください。`both` に対応する前の Veritas は、`both` を使った設定を読み込めません。

Veritas は、決まった手順のタクティクを順に試し、カーネルが最初に受け入れた証明を採用します。どの手順で証明できたかは結果に記録されます。Property が呼ぶ関数がさらに別の関数を呼ぶとき（たとえば、規則から判定を、判定から終了コードを決める関数）は、最初に `abstract-calls-split` を試します。内側の呼び出しの結果に一度だけ名前を付け、その呼び出しを場合分けする方法で、結果を使う箇所ごとに呼び出しの中身を複製することはしません。

## Property を宣言する {#declare-a-property}

文書から見つけた規則のほかに、自分で書いた規則も Property にできます。規則が成り立つときに `true` を返す関数を export し、`.veritas/config.json` で宣言します。

```ts
// src/stage.ts
export interface StageEvidence {
  failed: boolean;
  undecided: number;
  testsRan: number;
}

export function status(e: StageEvidence): number {
  if (e.failed) return 2;
  if (e.undecided > 0 || e.testsRan <= 0) return 1;
  return 0;
}

export function invariant_succeededNeedsTests(e: StageEvidence): boolean {
  return status(e) !== 0 || e.testsRan >= 1;
}
```

```json
{
  "properties": [
    {
      "id": "stage.succeeded-needs-tests",
      "kind": "holds_for_all",
      "target": "src/stage.ts#invariant_succeededNeedsTests",
      "description": "The stage succeeds only after at least one test ran.",
      "domain": { "integer": { "min": "0", "max": "1000" } }
    }
  ]
}
```

`holds_for_all` の Property は、「範囲内のすべての入力で、対象の関数が `true` を返す」という主張です。項目の一覧は[設定のリファレンス](/ja/reference/configuration#declared-properties)にあります。

| 項目          | 意味                                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | 変わらない名前です。Property の ID は `D-<id>` になるので、宣言の順番を入れ替えたり内容を直したりしても変わりません                                                                                                  |
| `target`      | `<ファイル>#<export 名>`。プロジェクト内のファイルが export する関数で、`boolean` を返し、[対応しているコード](#対応しているコード)に収まっている必要があります。`analysis.include` に含まれていなくてもかまいません |
| `description` | 規則の意味です。レビュー、指摘、レポートに表示されます                                                                                                                                                               |
| `domain`      | 省略可能です。`integer` の範囲（`min`、`max`）と `maxArrayLength` を指定します。省略した部分は `formal.integerDomain` と `formal.maxArrayLength` を使います                                                          |

宣言した Property も、文書から見つけた Property と同じレビューを通ります。最初は origin が `human` の `proposed` で、accept して初めて検査の対象になります（`--include-proposed` を付ければ検査しますが、結果は `suspected` のままです）。accept されていないために検査しなかった宣言は、prove ステージのメッセージで一つずつ名前を挙げます。

```text
succeeded   prove
            D-stage.succeeded-needs-tests: declared property not verified, it is proposed (accept it with `veritas spec accept D-stage.succeeded-needs-tests --reason "<why>"`, or pass --include-proposed)
```

```bash
veritas spec accept D-stage.succeeded-needs-tests --reason "the stage rule we rely on"
veritas prove --engine both
```

```text
succeeded   prove
            D-stage.succeeded-needs-tests: proven_within_model
            D-stage.succeeded-needs-tests (lean): proven_within_model [kernel_checked]
```

宣言した Property は、最初の実行の前でも accept できます。宣言した直後や、新しく clone した環境でもかまいません。宣言の内容は設定だけで決まるので、`veritas spec list`、`spec show`、`spec accept`、`spec reject` は、まだどの実行にもない宣言や、最新の実行が古いバージョンを検査した宣言を設定から組み立てます。決定は、次の実行で付くのと同じバージョンに対して記録されます。

宣言した Property のバージョンは、説明、対象、種類、範囲（範囲の既定値として使う形式検証の設定を含む）から決まります。どれかを変えると承認は適用されなくなり、もう一度 accept するまで `proposed` に戻ります。バージョンは過去の実行に左右されないので、新しく clone した環境や CI でも同じように扱われます。適用されなくなった決定は、prove ステージのメッセージで示します。

```text
D-stage.succeeded-needs-tests: the accept recorded by you (A-7d000af7e5fa) was for version 3103021279 of the declaration; it is now version 2952988804 and needs a new decision
```

accept されていない宣言（一度も accept していないもの、承認が古くなったもののどちらも）は検査しません。ほかの accept されていない Property と同じく、それだけで終了コードは変わりません。すべての宣言を必ず検査したい場合は、下で説明する Veritas のリポジトリと同じように、実行結果を確かめてください。

結果の意味は、ほかの Property と変わりません。

- Z3 は範囲内のすべての入力を調べ、反例は JavaScript で実際の関数に対して再実行します。再実行の結果が食い違えば `semantic_mismatch` になり、反例としては扱いません。
- accept した宣言に対して再実行で確かめた反例が出ると、`confirmed` の `spec_implementation_mismatch` の指摘になります。`policy.confirmedViolation: fail` なら実行は失敗します。
- `--engine both` では、Z3 が証明した Property について Lean がカーネルで検査した証明を加えます。
- Veritas が検査できない宣言は、理由を添えた `unsupported` の結果になり、黙って無視されることはありません。対象のファイルがない、プロジェクトの外にある、その名前の関数を export していない、関数が数値を返す、対応していないコードを使っている、といった場合です。ほかの `unsupported` と同じく判定できない結果なので、`policy.inconclusiveBehavior: fail` なら終了コードは `4` です。
- 宣言そのものが不正なとき（ID の重複、`#<export 名>` のない対象、`min` が `max` より大きい範囲など）は、`CONFIG_INVALID` で終了コード 2 になります。

宣言した Property だけを検査したいときは、文書を読むこととコードから規則を推測することを止めます。`sources.local` と `analysis.inferSpecsFromCode` を `false` にしてください。

Veritas のリポジトリも、この方法で自分自身を検査しています。リポジトリの `.veritas/config.json` は、`packages/core/src/policy-decision.ts` にある実行ポリシーの不変条件（「何も残っていないときだけ判定が `pass` になる」「終了コード 1 はポリシー違反のときだけ」など）を宣言しています。宣言はメンテナーがレビューし、`veritas spec accept` で決定を記録します。記録先の `.veritas/approvals.json` は、設定と一緒にコミットします。`node scripts/check-self-verification.mjs`（`pnpm build` と `veritas prove --engine both` のあとに実行）は、最新の実行で、宣言したすべての Property が accept され、Z3 で証明されて再実行でも確かめられ、Lean のカーネルでも検査されていなければ失敗します。その実行が今のチェックアウトのものであることも確かめます。設定とソース（解析したファイルと、宣言した対象のファイルすべて）が同じであること、作業ツリーに変更がなければコミットが同じであること、どの宣言も今のバージョンであることです。結果を記録しないまま終わった実行も失敗にします。`fixtures/declared-properties` には陰性対照として、わざと偽にした不変条件を置いてあり、これは反例が出なければいけません（`--expect-counterexample`）。証明の対象は判定の規則だけです。Veritas が規則に渡す証拠をどう数えるかは、テストで確かめていて、証明はしていません。CI では、これを変更のたびに実行しています。[CI](/ja/guide/ci#verify-declared-properties-in-ci) を参照してください。

## `proven_within_model` の意味

示したモデル、値の範囲、前提の中では、Property を破る入力がない、という意味です。どの結果にも、それらが記載されます。

```text
assumptions integers are mathematical integers restricted to the stated domains; functions are pure and terminate;
the IR models the TypeScript source of each bound function; agreement is checked by replay, not proven
semantic gaps JavaScript numbers are IEEE-754 doubles; agreement with the integer model holds only while every
intermediate value is a safe integer; inputs outside the stated domains, non-integer numbers, NaN, Infinity and -0 are not covered
```

次のことは意味しません。

- 範囲の外の入力や、浮動小数点数、`NaN`、`-0` でもコードが正しいこと
- 仕様が正しいこと（accepted な規則が誤っていても証明できます）
- テストがよいこと（結果はコードについてのもので、テストについてのものではありません）

結果は範囲と一緒に伝えてください。たとえば「`total` が `[-10000, 10000]` の範囲では反例がない」と書きます。
