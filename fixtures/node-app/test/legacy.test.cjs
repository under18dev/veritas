// CommonJS: the API and the assertions through require.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const double = (n) => n * 2;

describe('legacy doubling', () => {
  it('doubles two', () => {
    assert.equal(double(2), 4);
  });

  it('doubles zero', () => {
    assert.equal(double(0), 0);
  });
});
