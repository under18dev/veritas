import { type DefaultTheme, defineConfig } from 'vitepress';

const repo = 'https://github.com/under18dev/veritas';

function sidebar(prefix: '' | '/ja', t: Record<string, string>): DefaultTheme.Sidebar {
  return [
    {
      text: t.guide,
      items: [
        { text: t.whatIs, link: `${prefix}/guide/what-is-veritas` },
        { text: t.gettingStarted, link: `${prefix}/guide/getting-started` },
        { text: t.tutorial, link: `${prefix}/guide/tutorial` },
        { text: t.readingResults, link: `${prefix}/guide/reading-results` },
        { text: t.specifications, link: `${prefix}/guide/specifications` },
        { text: t.verification, link: `${prefix}/guide/verification` },
        { text: t.improving, link: `${prefix}/guide/improving-tests` },
      ],
    },
    {
      text: t.integrations,
      items: [
        { text: t.ci, link: `${prefix}/guide/ci` },
        { text: t.agents, link: `${prefix}/guide/agents` },
        { text: t.llm, link: `${prefix}/guide/llm-providers` },
        { text: t.untrusted, link: `${prefix}/guide/untrusted-repositories` },
        { text: t.troubleshooting, link: `${prefix}/guide/troubleshooting` },
      ],
    },
    {
      text: t.reference,
      items: [
        { text: t.cli, link: `${prefix}/reference/cli` },
        { text: t.configuration, link: `${prefix}/reference/configuration` },
        { text: t.api, link: `${prefix}/reference/api` },
        { text: t.mcp, link: `${prefix}/reference/mcp` },
        { text: t.action, link: `${prefix}/reference/github-action` },
        { text: t.reports, link: `${prefix}/reference/reports` },
      ],
    },
    {
      text: t.concepts,
      items: [
        { text: t.semantics, link: `${prefix}/concepts/semantics` },
        { text: t.architecture, link: `${prefix}/concepts/architecture` },
        { text: t.security, link: `${prefix}/concepts/security` },
        { text: t.support, link: `${prefix}/concepts/support-matrix` },
        { text: t.adr, link: '/adr/' },
      ],
    },
  ];
}

const en = {
  guide: 'Guide',
  whatIs: 'What is Veritas?',
  gettingStarted: 'Getting started',
  tutorial: 'Tutorial',
  readingResults: 'Reading results',
  specifications: 'Specifications',
  verification: 'Verification',
  improving: 'Improving tests',
  integrations: 'Integrations',
  ci: 'CI and GitHub Action',
  agents: 'Agents and MCP',
  llm: 'LLM providers',
  untrusted: 'Untrusted repositories',
  troubleshooting: 'Troubleshooting',
  reference: 'Reference',
  cli: 'CLI',
  configuration: 'Configuration',
  api: 'Node API',
  mcp: 'MCP server',
  action: 'GitHub Action',
  reports: 'Reports and artifacts',
  concepts: 'Concepts',
  semantics: 'Semantics',
  architecture: 'Architecture',
  security: 'Security model',
  support: 'Support matrix',
  adr: 'Design decisions (ADR)',
};

const ja: typeof en = {
  guide: 'ガイド',
  whatIs: 'Veritas とは',
  gettingStarted: 'はじめに',
  tutorial: 'チュートリアル',
  readingResults: '結果の読み方',
  specifications: '仕様の確定',
  verification: '検証',
  improving: 'テストの改善',
  integrations: '連携',
  ci: 'CI と GitHub Action',
  agents: 'エージェントと MCP',
  llm: 'LLM プロバイダー',
  untrusted: '信頼できないリポジトリ',
  troubleshooting: 'トラブルシューティング',
  reference: 'リファレンス',
  cli: 'CLI',
  configuration: '設定',
  api: 'Node API',
  mcp: 'MCP サーバー',
  action: 'GitHub Action',
  reports: 'レポートと成果物',
  concepts: 'コンセプト',
  semantics: 'セマンティクス',
  architecture: 'アーキテクチャ',
  security: 'セキュリティモデル',
  support: '対応環境',
  adr: '設計判断（ADR、英語）',
};

export default defineConfig({
  title: 'Veritas',
  description:
    'What does your test actually guarantee? Evidence-backed test verification for TypeScript and Vitest.',
  base: '/veritas/',
  cleanUrls: true,
  // The ADR index keeps its GitHub-friendly README.md name; the generated reference fragments are only included.
  rewrites: { 'adr/README.md': 'adr/index.md' },
  srcExclude: [
    '**/_generated/**',
    'user-guide.md',
    'api.md',
    'github-action.md',
    'semantics.md',
    'architecture.md',
    'threat-model.md',
    'support-matrix.md',
  ],
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/veritas/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#0f766e' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [
      { icon: 'github', link: repo },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@under18dev/veritas' },
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          ja: {
            translations: {
              button: { buttonText: '検索', buttonAriaLabel: '検索' },
              modal: {
                noResultsText: '結果が見つかりません',
                resetButtonTitle: 'リセット',
                footer: { selectText: '選択', navigateText: '移動', closeText: '閉じる' },
              },
            },
          },
        },
      },
    },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: en.guide, link: '/guide/getting-started' },
          { text: en.reference, link: '/reference/cli' },
          { text: en.concepts, link: '/concepts/semantics' },
        ],
        sidebar: sidebar('', en),
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
        footer: { message: 'Released under the Apache-2.0 License.', copyright: 'Copyright © under18dev' },
      },
    },
    ja: {
      label: '日本語',
      lang: 'ja',
      link: '/ja/',
      themeConfig: {
        nav: [
          { text: ja.guide, link: '/ja/guide/getting-started' },
          { text: ja.reference, link: '/ja/reference/cli' },
          { text: ja.concepts, link: '/ja/concepts/semantics' },
        ],
        sidebar: sidebar('/ja', ja),
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'GitHub でこのページを編集' },
        outline: { label: 'このページの内容' },
        docFooter: { prev: '前のページ', next: '次のページ' },
        lastUpdated: { text: '最終更新' },
        returnToTopLabel: 'トップへ戻る',
        sidebarMenuLabel: 'メニュー',
        darkModeSwitchLabel: '外観',
        footer: { message: 'Apache-2.0 ライセンスで公開しています。', copyright: 'Copyright © under18dev' },
      },
    },
  },
});
