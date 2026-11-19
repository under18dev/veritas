# Fixture: agent-loop

| Item                 | Ground truth                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| README rule          | `age >= 65` (README.md line 5)                                                                                                |
| Implementation       | `age >= 65` (src/age.ts line 3): agrees with the README                                                                       |
| Existing tests       | ages 80 and 20 only; the `>=` to `>` mutant survives                                                                          |
| Expected improvement | a new test asserting `isSenior(65) === true` (value from the README rule) kills the survivor; existing files are not modified |
| Rollback case        | a plan whose new test fails in the isolated workspace must leave the repository byte-for-byte unchanged                       |
