// Native ESM with TypeScript: Node strips the types (no ts-jest or babel), and `.js` specifiers map to the `.ts` files.
export default {
  testEnvironment: 'node',
  transform: {},
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
