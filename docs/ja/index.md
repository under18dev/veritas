---
layout: home

hero:
  name: Veritas
  text: そのテストは、本当に何を保証していますか？
  tagline: TypeScript と Vitest のための、仕様を踏まえたテスト検証ツール。スコアではなく、mutant・反例・証明という根拠で答えます。
  actions:
    - theme: brand
      text: はじめる
      link: /ja/guide/getting-started
    - theme: alt
      text: Veritas とは
      link: /ja/guide/what-is-veritas
    - theme: alt
      text: GitHub
      link: https://github.com/under18dev/veritas

features:
  - title: ドキュメントから仕様を読む
    details: README、docs、CHANGELOG、コードを読み、「1000 以上」のような規則を、出典の行つきの Property にします。レビューなしに accepted になることはありません。
  - title: 意味のある mutant
    details: 実際に mutation testing を実行し、生き残った mutant を、それが破る仕様に結び付けます。「誰も total = 1000 を確かめていない」という形で、穴が見えます。
  - title: 勘ではなく反例
    details: Z3 と fast-check で Property を検査し、反例はすべて JavaScript で再生します。モデルと言語の意味のずれは、隠さずに報告します。
  - title: 範囲を明示した証明
    details: Z3 の有界な整数モデルと、カーネルで検査する Lean 4 の証明。主張には必ず範囲と前提が付き、sorry・admit・独自の公理は検証済みになりません。
  - title: スコアではなく証拠
    details: テストごとに、仕様との関係、assertion、kill、境界、形式的な主張、不明な点からなる証拠を示し、5 種類のどれかで正直に判定します。
  - title: CI とエージェントのために
    details: CLI、Node API、MCP サーバー、Agent Skill、GitHub Action が同じエンジンで動き、JSON・SARIF・終了コードは安定しています。既定でオフラインです。
---

<div class="vp-doc" style="max-width: 760px; margin: 64px auto 0; padding: 0 24px;">

## 30 秒で試す

```bash
npm install -D @under18dev/veritas
npx veritas init --yes
npx veritas run --profile standard
```

```text
run run-20261120T095804553Z-000-1b553f  verdict: pass_with_warnings (exit 0)

succeeded   mutate
            counts: {"killed":16,"survived":1}
succeeded   assess
            assessments: {"weak_or_incomplete":2,"meaningful_with_evidence":2,"tautological_or_disconnected":1}

findings (3):
  F-0b43c88cc3a6  [confirmed medium] no test detects total > 1000 -> total >= 1000 at src/pricing.ts:3
  F-628f7fdacb0b  [suspected medium] src/pricing.ts#discountAmount may not satisfy "total >= 1000"
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour
```

Veritas は「テストの品質は 87%」とは言いません。各テストがどの仕様を確かめているか、どんな誤りなら検出できるか、何をどの範囲で形式的に確かめたか、そして何がまだ分からないかを示します。

</div>
