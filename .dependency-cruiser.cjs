/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'core-is-leaf',
      comment: 'core must not depend on any other workspace package, CLI framework or LLM SDK',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(?!core/)|node_modules/(commander|@anthropic-ai|openai|@modelcontextprotocol)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|test)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'node', 'default'] },
  },
};
