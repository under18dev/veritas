# 検証

Veritas は、Z3、fast-check、Lean 4 の三つの方法で Property をコードと照らし合わせます。方法ごとに、結果が何を保証するかと、検査を自分で再実行する方法を載せています。

| エンジン   | コマンド                                      | 結果                                    | 対象                                               |
| ---------- | --------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| Z3         | `veritas prove`、`veritas run --profile deep` | `smt_bounded` の結果                    | 整数モデルで、範囲内のすべての入力                 |
| fast-check | `veritas run --profile deep`                  | シードを記録した property-based testing | 抽出した入力を JavaScript で実行                   |
| Lean 4     | `veritas prove --engine lean`                 | `kernel_checked` の結果                 | 関数の Lean モデルについて、カーネルで検査した証明 |

三つとも accepted な Property を検査します。`--include-proposed` を付けると proposed な Property も検査しますが、結果は `suspected` のままです。

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
- `if`/`else`、三項演算子、`return`、`const`、`+ - *`、比較、`=== !==`、`&& || !`、同じファイルにある対応範囲内の関数の呼び出し

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

- Lean が扱うのは整数と真偽値の引数だけで、レコードや配列を含む Property は `unsupported` です。
- Lean のモデルは Property の形式モデルから生成します。TypeScript のコードと対応しているかは証明されておらず、どの Lean の結果にも semantic gaps として記載されます。
- Lean のビルドには制限時間がありますが、メモリの上限はありません。

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
