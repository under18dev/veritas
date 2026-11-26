# テストの改善

`veritas improve` は、実行結果の穴を埋めるテストを計画します。計画は承認してから適用します。適用できないときに何が起きるかは、最後のほうの節にあります。

## `improve` が変えるもの

- 追加するのは新しいテストファイルだけです。既存のテストを編集、削除、弱めることはなく、本番のコード、README、docs にも触れません。
- 期待値は accepted な Property から取り、コードを実行して得た値は使いません。`--include-proposed` を付けると proposed な Property も使います。
- 既定の動作は計画を立てることです。計画は `.veritas/improvements/<plan-id>/plan.json` に書き出し、プロジェクトのファイルは変更しません。
- 適用には、`--apply` と、その計画で表示された計画の ID と承認トークンが必要です。
- 適用するときは、プロジェクトの一時コピーで計画の効果を測り、結果がよくなったときだけテストファイルをプロジェクトに書き込みます。
- CI の中では適用できません。

## 計画する

```bash
veritas improve --dry-run
```

オプションなしの `veritas improve` も同じ動作です。計画は最新の実行から、または `--run <run-id>` で指定した実行から作ります。`standard` か `deep` の実行のあとに計画してください。mutation testing の結果がないと、境界の穴だけが対象になります。

```text
plan IP-a14164357e16 from run-20261120T105517747Z-000-01dbf1: planned

goal: Add 1 test(s) whose expected values come from the specification and at decisive boundary inputs no test checks; applying measures which mutants they kill

proposed tests (expected values from the specification):
  test/veritas-P-ee03e6e8b749.test.ts: discountAmount(1000) is 100
      property P-ee03e6e8b749 (total >= 1000): the guarding condition holds for this input, so the specification documents 100

gaps:
  F-e2324bef333e  boundary of total >= 1000: total=1000 is not checked by an asserting test

budget: 3 iteration(s), 5 file(s), 900000 ms, 1 test retr(y/ies)

patch preview:
--- /dev/null
+++ b/test/veritas-P-ee03e6e8b749.test.ts
@@ -0,0 +1,8 @@
+// Added by `veritas improve` for property P-ee03e6e8b749.
+// Expected values come from the specification (README.md:7), not from the implementation.
+import { expect, it } from 'vitest';
+import { discountAmount } from "../src/pricing.js";
+
+it("discountAmount(1000) is 100 (boundary of the rule)", () => {
+  expect(discountAmount(1000)).toBe(100);
+});
[...]
approval token for plan IP-a14164357e16: 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b
apply after review: veritas improve --apply --plan IP-a14164357e16 --approve 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b

plan: .veritas/improvements/IP-a14164357e16/plan.json (no project file was written)
```

計画には、目的、提案するテストと期待値の出どころ（Property と出典の行）、対象の穴、予算、パッチの全文、見送った入力とその理由、承認トークンが含まれます。計画は `.veritas/improvements/<plan-id>/plan.json` に保存されます。

## 承認して適用する

パッチのプレビューを読んでください。トークンを渡すことは、そのパッチをそのまま承認することを意味します。

```bash
veritas improve --apply --plan IP-a14164357e16 --approve 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b
```

```text
attempt PA-ee6c6c6d4bc3 for plan IP-a14164357e16: improved
before: tests 5 passed / 0 failed, mutants 16 killed / 1 survived
after:  tests 6 passed / 0 failed, mutants 17 killed / 0 survived
note: killed mutants 16 -> 17, survived 1 -> 0
note: newly killed: M-5b67ad8e53c8
note: added: test/veritas-P-ee03e6e8b749.test.ts
note: formal and property-based results re-evaluated in run-20261120T105528565Z-000-2f25ef on the patched copy
```

| オプション             | 意味                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `--plan <id>`          | dry run で表示された計画の ID                                                      |
| `--approve <token>`    | dry run で表示された承認トークン                                                   |
| `--actor <name>`       | 承認した人。省略すると `VERITAS_ACTOR`、次に `git config user.name`                |
| `--run <run-id>`       | 最新ではなく、この実行から計画する                                                 |
| `--include-proposed`   | proposed な Property からも期待値を取る                                            |
| `--max-iterations <n>` | 計画を適用しようとする回数の上限。1〜20（既定は `improvement.maxIterations` の 3） |

`--apply` の中では、次の順に処理します。

1. プロジェクトを、キャッシュディレクトリの中に作るあなた専用の新しいディレクトリにコピーします（`$XDG_CACHE_HOME/veritas/improve` か `~/.cache/veritas/improve`、Windows では `%LOCALAPPDATA%\veritas\improve`）。`node_modules` とツールの状態はコピーせず、`node_modules` はリンクして、プロジェクトのテストランナーと mutator を使います。
2. コピーのファイルと、コピーがリンクしているインストール済みの依存関係のメタデータを記録します（[コピーの検査](#checks-on-the-copy)を参照）。
3. コピーでテストと mutation testing を実行し、コピーが元のままであることを確かめます。
4. コピーに新しいテストファイルを加え、すべての mutant についてテストと mutation testing をもう一度実行します。
5. 計画の元になった実行と同じステージとオプションで、形式検証と property-based testing の結果をオフラインで評価し直します。
6. 次の条件をすべて満たしたときだけ、新しいファイルをプロジェクトに書き込みます。コピーとコピー元との違いが、計画どおりの内容の新しいファイルだけであること、インストール済みの依存関係が変わっていないこと、すべてのテストが通ること、kill した mutant が増えること、パッチの前に生き残っていた mutant を新しいテストのどれかが kill すること、mutation の 2 回の実行がどちらも最後まで終わっていること（mutator の時間の予算が尽きず、外したソースファイルもないこと）、評価し直しがエラーなく終わること。証明と反例は、実装そのものについても mutant についても、もう一度作られて決着したままでなければなりません。例外は、パッチの前には生き残っていて、新しいテストのどれかが kill した mutant で、その結果は作られなくてもかまいません。通った property-based test は、もう一度作られた場合に決着したままでなければなりません。もともと決着していなかった結果は `unknown` や `timeout` のままでもかまいません。どれも試行の記録に残ります。条件を満たさなければコピーを捨て、プロジェクトは変わりません。

### コピーの検査 {#checks-on-the-copy}

新しいテストもコードです。計画を承認すると、プロジェクトのほかのテストと同じように、あなたのユーザーの権限で実行され、ファイルを書き込むこともできます。Veritas は実行の前後で次の 2 点を検査します。

- **コピーそのもの。** 変更前の実行のあとは、コピーのどのファイルも、内容とメタデータの両方がコピーしたときのままでなければなりません。パッチを当てたあとの実行で許される違いは、計画どおりの内容の新しいテストファイルだけです。それ以外のファイルの作成、変更、削除があれば、試行は `no_safe_improvement` になります。書き換えてから元に戻したファイルや、新しい `__snapshots__` のファイルも含みます。試行の記録にファイルの一覧が残り、プロジェクトには何も書き込みません。このため、テストが比較の相手になるコードやほかのテストを書き換えて、結果をごまかすことはできません。コピー自身の `node_modules` にあるパッケージのリンク（各パッケージ、スコープ付きのパッケージ、`.bin`）も比べます。テストランナーと mutator はこのリンクを通して読み込むので、テストが自分で用意したパッケージに差し替えることはできません。`.veritas/`、`.mutator/`、`node_modules/` の隠しエントリー（`.vite` など）はツールの出力とキャッシュの置き場なので、比べません。mutator の作業ディレクトリ `.mutator/` は、コピーでの mutation の実行のたびに前もって消すので、テストがそれまでに残した状態は使われません。ただし mutator は、テストをひととおり実行したあとで再開用のデータベースを開くので、その実行の最中にテストが判定を仕込むことはできます。mutator はそのデータベースから取り込んだ判定を必ず報告するので、コピーでの mutation の実行がひとつでも取り込んだ場合は `error` にします（Veritas は mutator の出力を流れてくるそばからすべて調べるので、出力をどれだけ増やしてもこの報告は隠せません）。mutator はコピーの中だけで探し、コピーを置いた一時ディレクトリからは探しません。
- **インストール済みの依存関係。** コピーは `node_modules` をコピーせず、インストール済みのパッケージをそれぞれ実際の場所にリンクします。そのため、コピーの中で動くテストは、プロジェクトの実際の依存関係に書き込めます。pnpm や bun のストア、ほかの場所からリンクしたワークスペースのパッケージも含みます。Veritas は最初の実行の前に、それらのツリーのすべてのエントリーについて、サイズ、時刻、inode、リンク数、リンク先を記録します。最後の実行のあとと、何かを書き込む前に、もう一度比べます。違いがあれば試行は `error` になり、変わったパスを一覧にして、何も書き込みません。`node_modules` の外からリンクしたパッケージでは `.git` などの隠しエントリーを除きますが、ビルドの出力は比べます。適用の最中にリンクしたパッケージをビルドし直すと（`tsc --watch` など）、コピーが別のコードを実行したことになるので、変更として報告します。そうしたパッケージの中のリンクは、`node_modules` の中か、ほかのパッケージか、同じリポジトリ（`.git`、`pnpm-workspace.yaml`、`workspaces` を持つ `package.json` のあるディレクトリ）の中を指すときだけたどります。それ以外を指すリンク（`logs -> /var/log` など）はたどらず、試行のたびに検査していないものとして一覧にします。これらのツリーのエントリーが 200 万を超えると、一部だけ検査するのではなく、エラーで適用を止めます。テストによる変更は Veritas には元に戻せません。テストをもう一度実行する前に、`node_modules` を消して lockfile からインストールし直してください。変更時刻（ctime）も比べるのは、macOS と Linux では通常のファイル操作でそれを元に戻せないからです。Windows ではプログラムが設定できるので、検査は弱くなります。変更時刻とリンク数だけが変わった場合は無視します。共有のストアからハードリンクするパッケージマネージャーでは、ほかのプロジェクトが同じファイルをインストールすると両方が変わるためです。読むのはメタデータだけで、インストール済みのファイルが約 4 万あるプロジェクトでは、ファイルシステムのキャッシュが温まった状態で約 0.3 秒、冷えた状態ではそれより長くかかりました。

#### 既存のテストがプロジェクトに書き込む場合 {#when-your-existing-tests-write-into-the-project}

変更前の実行はコピーを元のままにしておく必要があるので、プロジェクト自身のテストがプロジェクトの中にファイルを書くと、変更前の実行の段階で `no_safe_improvement` で止まり、試行の記録にファイルの一覧が残ります。よくある原因は次のとおりです。

- テストランナーの設定でカバレッジを有効にしていて、その出力が書かれる
- JUnit の `outputFile` のように、ファイルに書き出すレポーター
- テストがプロジェクトの中に作って消さない一時ファイル
- 初めて書かれるスナップショットのファイル（`__snapshots__`）

計画を適用するには、適用の間はそうした出力をプロジェクトの外に出してください。カバレッジやファイルに書くレポーターは設定ファイルではなくコマンドライン（CI のスクリプトなど）で有効にし、一時ファイルはシステムの一時ディレクトリ（`os.tmpdir()`）に作って消し、スナップショットは適用の前にコミットしておきます。

#### 限界 {#limits}

コピーをシステムの一時ディレクトリではなくキャッシュディレクトリに作るのは、コピーの中のコードが Node と同じように、コピーの親ディレクトリをさかのぼってモジュールを探すからです。Linux の一時ディレクトリはすべてのユーザーが共有しているので、ほかのユーザーがそこに `node_modules` を置くと、あなたの適用で読み込まれてしまいます。Veritas は、キャッシュディレクトリがプロジェクトの中にないこと、そしてコピーを置くディレクトリより上のどのディレクトリも、あなたか管理者のもので、すべてのユーザーが書き込めるものでも、あなたのプライベートグループ以外のグループが書き込めるものでもないことを確かめます（プライベートグループは、Ubuntu などがユーザーごとに作る、ユーザー名と同じ名前のグループです。umask が 002 だと、あなたのディレクトリはこのグループに書き込み可能になります）。そうでなければ `IMPROVE_UNSAFE_WORKSPACE_DIR` で適用を止めます。メッセージにディレクトリが示されるので、あなたのディレクトリがグループに書き込み可能なら `chmod g-w <dir>` で直せます。コピー自身の `node_modules` にないパッケージは、今もこの親ディレクトリから探します。依存関係をプロジェクトより上に巻き上げた monorepo では、コピーからはそれが見えず、キャッシュやホームディレクトリにある `node_modules` が代わりに使われます。

コピーは適用の終わりに消します。Ctrl-C や `SIGTERM` で止めた場合も同じです。強制終了やクラッシュで残ったコピーは、次の適用が消します。コピーの隣には、それを作ったプロセス、ホスト、Linux では起動 ID と pid 名前空間を記した小さな記録があり、そのプロセスがもう動いていなければ消します。ここからプロセスを確かめられない場合（ディレクトリを共有するほかのホストやコンテナー、記録のないコピー）は、1 週間（記録がなければ 1 日）たつまで残します。動いている適用のコピーを消すことはありません。消えるまでの間、残ったコピーにはプロジェクトのファイルが入っているので、すぐに消したいときはキャッシュディレクトリの `veritas/improve` を自分で消してください。

テストされるコードは、テストランナー、mutator、Veritas に `SIGUSR1` を送って Node.js のインスペクターを開き、テストの外でコードを動かせます。Veritas が起動するテストランナーと mutator のプロセスには、Veritas を動かしている Node.js が対応していれば（22.14 以降）コマンドラインに `--disable-sigusr1` を付け、Veritas は計画を適用している間このシグナルを無視します。Node.js のフラグを引き継ぐワーカー（Jest のもの）にも付きますが、独自のフラグで起動されるプロセス（Vitest のワーカー、mutator が起動する Jest のプロセス）には付きません。`NODE_OPTIONS` には入れません。テストが起動する古い Node.js が起動できなくなるためです。

これらの検査は、書き込みをあとから見つけるもので、防ぐものではありません。依存関係を共有したままにしているのは、試行のたびに `node_modules` をコピーすると大きなツリーでは時間がかかり、pnpm や bun の構成はそのままコピーしても共有のストアを指したままだからです。検査は安全網であって、セキュリティの境界ではありません。新しいテストは、絶対パスを使えばあなたのユーザーが書き込める場所のどこにでも書き込め、ファイルを読み、ネットワークを使い、自分のテストランナーが報告する結果を偽ることもできます。また、テストは自分がどの mutant に対して動いているかを調べてわざと失敗し、その mutant を kill したように見せることもできます。これは mutation testing そのものの性質で、どんな検査でも防げません。最後の検査より後の書き込み、たとえばテストが起動して動かしたままにしたバックグラウンドのプロセスによる書き込みには気づきません。依存関係の検査は、同じサイズの内容でファイルを書き換え、変更時刻（mtime）を元に戻し、そのファイルへのハードリンクを別の場所に残しておけばすり抜けられます。共有のストアによる誤検知を避けるため、変更時刻（ctime）とリンク数だけの変化は無視しているからです。計画を適用するのは信頼できるコードだけにし、信頼できないコードではコンテナーの中で Veritas を動かしてください（[信頼できないリポジトリ](/ja/guide/untrusted-repositories)を参照）。

試行は `.veritas/improvements/<plan-id>/attempt-<n>.json` に、承認は `approval-<n>.json`（承認した人、日時、呼び出し元、トークンのハッシュ）に記録されます。

## 結果と終了コード

| 結果                  | 終了コード | 意味                                                                                                                                                                                                                                                                        |
| --------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned`、`improved` | `0`        | 計画ができた、または適用して結果がよくなった                                                                                                                                                                                                                                |
| `no_safe_improvement` | `4`        | 仕様から期待値を取ったテストを作れなかった、追加したテストが失敗したか新しいテストで kill が増えなかった、mutation の実行が最後まで終わらず（時間の予算が尽きたか、ファイルを外した）前後を比べられなかった、または実行が新しいテストファイル以外のコピーのファイルを変えた |
| `needs_spec_decision` | `4`        | 先に仕様を決める必要がある                                                                                                                                                                                                                                                  |
| `blocked`             | `1`        | パッチが安全性の検査を通らない、または試行の上限に達した                                                                                                                                                                                                                    |
| （エラー表示）        | `2`        | 承認トークンが違う、または CI の中で `--apply` した                                                                                                                                                                                                                         |
| `error`               | `3`        | ツールが失敗した、またはコピーでの実行がインストール済みの依存関係を変えた                                                                                                                                                                                                  |

## 仕様を決める必要があるとき

次の場合、計画は `needs_spec_decision` で止まります。

- **対象の Property が accepted でない、または食い違っている。** `veritas spec` で accept か reject をするか（[仕様の確定](/ja/guide/specifications)を参照）、`--include-proposed` を付けて計画します。
- **仕様から作ったテストが、今のコードで失敗する。** Veritas は仕様違反の候補として報告し、実装の修正案を書き出し、何も追加しません。

```text
plan IP-c7176a11a5f3 from run-20261120T105508829Z-000-017911: needs_spec_decision

spec violation candidates (not added; expected values unchanged):
  SVC-ec7787ca9234  discountAmount(1000) returns 0, but the specification (README.md:7) documents 100; the test is not added and its expected value is not changed
  implementation fix proposals: .veritas/improvements/IP-c7176a11a5f3/implementation-fix-proposal.json
```

コードを直すか、仕様を変えてレビューし直してから、もう一度計画してください。

## 適用が拒否されたとき

| エラー                         | 原因                                                                                                                                                                                   | 対処                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `APPROVAL_MISMATCH`            | トークンがその計画のものでない、または計画が変わった（使う Property を reject した など）                                                                                              | `veritas improve --dry-run` をやり直し、新しいトークンを使う    |
| `IMPROVE_APPLY_IN_CI`          | 環境変数 `CI` が、空、`false`、`0` 以外の値になっている                                                                                                                                | 手元で適用する。計画は CI でも立てられる                        |
| `IMPROVE_UNSAFE_LINK`          | プロジェクトの外を指すシンボリックリンクがある                                                                                                                                         | リンクを実際のファイルやディレクトリに置き換える                |
| `IMPROVE_UNSAFE_WORKSPACE_DIR` | 隔離したコピーを作るディレクトリ（キャッシュディレクトリの `veritas/improve`）がプロジェクトの中にある、リンクかほかのユーザーのもの、またはその上のディレクトリにほかの人が書き込める | `XDG_CACHE_HOME` をプロジェクトの外の自分のディレクトリに向ける |

```text
error[IMPROVE_APPLY_IN_CI]: applying an improvement is refused in CI (improvement.autoApply is always false)
hint: run `veritas improve --apply` locally after reviewing the plan
```

エージェントからは MCP サーバーで計画と適用ができます。[エージェントと MCP](/ja/guide/agents) を参照してください。
