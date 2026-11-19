# Fixture: unsupported-js

| Function         | Construct outside the formal subset | Expected                                                                    |
| ---------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `passes`         | division (`/`)                      | property not formalizable; verification reports `unsupported`, never proven |
| `allowRequest`   | module state and side effect        | impure; `unsupported`                                                       |
| `uploadRejected` | `Number.isNaN` call                 | `unsupported`                                                               |
