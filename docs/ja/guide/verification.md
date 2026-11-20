# 検証

Veritas は三つの方法で Property を検査します。Z3 による範囲を限った SMT の検査、fast-check による property-based testing、Lean 4 によるカーネル検査つきの証明です。どれも「コードは正しいか」より狭い問いに答えるもので、結果にはどの問いに答えたかが必ず付きます。

| エンジン   | コマンド                                      | 結果                                    | 確かめられる範囲                                |
| ---------- | --------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| Z3         | `veritas prove`、`veritas run --profile deep` | `smt_bounded` の結果                    | 整数モデルで、範囲内のすべての入力              |
| fast-check | `veritas run --profile deep`                  | シードを記録した property-based testing | 抽出した入力を、実際の JavaScript で実行        |
| Lean 4     | `veritas prove --engine lean`                 | `kernel_checked` の結果                 | Lean のモデルについての、カーネルで検査した証明 |

既定では、三つとも accepted な Property だけを検査します。`--include-proposed` を付けると proposed な Property も加わりますが、その結果は `suspected` のままで、実験的なものとして扱われます。

## Z3

`veritas prove` は、形式化した Property と、そこから呼ばれる関数を SMT-LIB のクエリに変換し、範囲内に Property を破る入力があるかを Z3 に問います。Z3 は `z3-solver` の WebAssembly 版を別プロセスで動かすので、別にインストールする必要はありません。

```text
succeeded   prove
            P-7f8d3341340c: counterexample_found {"total":"1000"}
            P-abc66b51a716: proven_within_model
```

### 対応している範囲

形式検証の対象は、範囲を限った安全な整数、真偽値、それらを持つ単純なレコードと配列を扱う純粋な関数です。

- 引数と戻り値が `number`（範囲を限った整数として扱います）か `boolean`
- プロパティがすべて `number` か `boolean` のレコードの引数と、`formal.maxArrayLength` 個（既定 3、最大 8）までの数値か真偽値の配列の引数
- `if`/`else`、三項演算子、`return`、`const`、`+ - *`、比較、`=== !==`、`&& || !`、同じファイルにある対応範囲内の関数の呼び出し

割り算、`%`、`**`、浮動小数点数、`NaN`、`Infinity`、`==`、`??`、暗黙の型変換、ループ、`let`/`var`、非同期処理、副作用、入出力は `unsupported` になります。表の全体は[対応環境](/ja/concepts/support-matrix)にあります。

値の範囲は `formal.integerDomain`（既定は `[-10000, 10000]`）、ソルバーの制限時間は `formal.maxSolverMs`（既定は 30000 ミリ秒）で決まります。

### 反例は JavaScript で実行し直す

整数モデルと JavaScript の結果が一致するのは、すべての値が安全な整数に収まっているあいだだけです。そのため、Z3 が見つけた反例はすべて、制限をかけた Node.js のプロセスで、実際の関数に対して実行し直します。

- JavaScript でも同じ違反になれば、結果は `counterexample_found` です。
- ならなければ `semantic_mismatch` です。モデルとコードの意味がずれているので、バグとも証明とも言えません。`formal.integerDomain` を狭めるか、その関数はテストで確かめてください。

再実行には Node.js 25 以上が必要です（[はじめに](/ja/guide/getting-started#必要なもの)を参照）。ない場合、結果は inconclusive のままです。

結果ごとに、`.veritas/runs/<run-id>/proofs/` にファイルが書き出されます。クエリ（`<claim>.smt2`）、ソルバーの出力（`<claim>.out`）、再実行の記録（`<claim>.replay.json`）です。クエリはふつうの SMT-LIB なので、どの Z3 でも実行できます（`z3 -smt2 proofs/<claim>.smt2`）。

### 四つの関係

形式検証の結果はどれも、「範囲内のすべての入力について、前提が成り立てば本体も成り立つ」という同じ形のクエリです。種類（kind）は、本体が何を表すかを示します。

| 種類                  | 問い                                                             | `counterexample_found` の意味                                            | `proven_within_model` の意味                      |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| `conformance`         | 実装は Property を満たすか                                       | 満たさない入力があり、JavaScript で再実行しても同じ                      | 範囲内にそのような入力はない                      |
| `bounded_equivalence` | 生き残った mutant を元のコードと区別できる入力はあるか           | 区別できる入力がある。その入力を使うテストなら mutant を kill できる     | 範囲内にはない。mutant は `equivalent_proven`     |
| `distinguishability`  | テストがすでに使っている入力で、生き残った mutant を区別できるか | できる。テストは違いのある箇所を通っているが、assertion が確かめていない | どの入力でもできない。テストに新しい入力が要る    |
| `property_detection`  | Property は mutant を元のコードと区別できるか                    | Property が変更を検出する入力がある                                      | 範囲内では、Property はこの mutant を区別できない |

`veritas prove` が検査するのは conformance です。残りの三つは mutation testing の結果が必要なので、`veritas run --profile deep` で実行されます。

```text
P-7f8d3341340c vs mutant M-5b67ad8e53c8: detects it with {"total":"1000"}
```

distinguishability が使うのは、引数がすべて範囲内の整数か真偽値のリテラルであるテストの呼び出しだけです。distinguishability と property_detection の検査は、一回の実行で合わせて 40 件までです。見送った件数はステージのメッセージに出ます。

## fast-check

`veritas run --profile deep` の `pbt` ステージは、形式化した Property を fast-check の property として、実際の関数に対して実行します。実行するのは制限をかけた Node.js のプロセス（Node.js 25 以上）です。入力は形式検証と同じ範囲（範囲を限った整数、真偽値、それらのレコードと配列）から取り、Property の境界の値も加えます。文字列、浮動小数点数、`NaN` は生成しません。

```text
succeeded   pbt
            P-7f8d3341340c: passed
```

シード、実行回数、失敗したときの反例と縮小（shrink）の経路は `pbt.json` に記録されます。実行回数は `pbt.numRuns`（既定 1000）、シードは `pbt.seed` を設定しない限り Property ごとに決まります。property-based testing が通ったことは、試した入力についての経験的な根拠で、証明ではありません。

### property-based testing を再実行する

```bash
veritas test replay PBT-3a3897350851
```

```text
PBT-3a3897350851 (P-7f8d3341340c, run run-20261120T101037769Z-000-243d1b, seed 2143163210, 1000 runs)
recorded: passed
replayed: passed
reproduced
```

`test replay` は、記録したシードと縮小の経路で同じテストを実行し直します。記録どおりの結果になれば `0`、ならなければ `4` で終わります。`--run <run-id>` で、探す実行を指定できます。失敗したテストの ID は、finding の `replay:` の行にあります。

### テストファイルを生成する

```bash
veritas test generate                       # 形式化したすべての Property
veritas test generate --property <id>       # 一つの Property
veritas test generate --dry-run             # 書き出さずに表示
```

`test generate` は、fast-check のテストを `.veritas/generated-tests/<property-id>.test.ts` に書き出します。各ファイルの先頭のコメントには、値の範囲、シード、実行回数が書かれます。accepted でない Property のテストには `[experimental]` と付きます。Veritas はこれらのファイルを実行しません。Vitest で実行するのは、プロジェクトのテストを実行するのと同じことです。書き出したあとで編集したファイルは、`--force` を付けたときだけ置き換えます。

## Lean 4

```bash
veritas prove --engine lean
```

```text
succeeded   prove
            P-7f8d3341340c (lean): proven_within_model [kernel_checked]
```

Lean のバックエンドは、関数の Lean モデルと Property の定理を生成し、`lake build` でビルドします。Lean 4 と Lake が必要で、[elan](https://github.com/leanprover/elan) で入れます。`veritas doctor` は `PATH` と `~/.elan/bin` を探します。見つからなければ、Lean の結果は理由付きで `unsupported` になります。

結果が `kernel_checked` になるのは、ビルドが成功し、定理が Lean の標準の公理（`propext`、`Classical.choice`、`Quot.sound`）以外に依存していないときだけです。`sorry`、`admit`、`native_decide`、その他の公理を使った証明は受け入れません。

Lean が扱えるのは整数と真偽値の引数だけで、レコードや配列を含む Property は `unsupported` になります。Lean のモデルと JavaScript のコードの対応は、この証明とは別に確かめる必要があります。ほかの方法で確かめていない限り、レポートには未解決の前提として表示されます。Lean のビルドには制限時間はありますが、メモリの上限はありません。

## `proven_within_model` が意味すること

`proven_within_model` は、「示したモデル、値の範囲、前提の中では、Property を破る入力がない」という意味です。結果にはそれぞれ範囲、前提、意味のずれ（semantic gaps）が付きます。

```text
assumptions integers are mathematical integers restricted to the stated domains; functions are pure and terminate;
the IR models the TypeScript source of each bound function; agreement is checked by replay, not proven
semantic gaps JavaScript numbers are IEEE-754 doubles; agreement with the integer model holds only while every
intermediate value is a safe integer; inputs outside the stated domains, non-integer numbers, NaN, Infinity and -0 are not covered
```

次のことは意味しません。

- 範囲の外の入力、浮動小数点数、`NaN`、`-0` でも実装が正しいこと
- 仕様そのものが正しいこと（誤った規則でも、accepted なら証明できてしまいます）
- テストがよいこと（形式検証の結果はコードについての主張で、テストについての主張ではありません）

結果を伝えるときは、範囲と一緒に伝えてください。「証明済み」ではなく、「`total` が `[-10000, 10000]` の範囲では反例がない」と書きます。
