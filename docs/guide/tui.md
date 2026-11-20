# Terminal UI

Run `veritas` without arguments to open an interactive interface in your terminal. From it you can browse results, review specifications, start runs, improve tests and edit the configuration without typing commands.

```bash
npm install -g @under18dev/veritas
cd your-project
veritas
```

The TUI opens on the project in the current directory.

## When it opens

The TUI opens only when all of the following hold:

- `veritas` is run with no arguments at all (no command, no option such as `-C` or `--json`);
- both stdin and stdout are an interactive terminal;
- the `CI` environment variable is not set (or is `false` or `0`).

Otherwise `veritas` behaves as before: it prints the help on stderr and exits with code `2`. Scripts and pipelines that call `veritas` without arguments are not affected.

## Layout and keys

The screen has a header with the project name and the latest run (its verdict, exit code and start time), a menu on the left, the current screen on the right and a key hint at the bottom.

| Where    | Key                | Action                                              |
| -------- | ------------------ | --------------------------------------------------- |
| Menu     | `↑` `↓` or `j` `k` | Move between screens                                |
| Menu     | `Enter` or `→`     | Enter the screen                                    |
| Menu     | `?`                | Show or hide the key help                           |
| Menu     | `q`                | Quit                                                |
| Anywhere | `Ctrl+C`           | Quit                                                |
| Screen   | `↑` `↓` or `j` `k` | Move in a list, or scroll text                      |
| Screen   | `Enter`            | Choose                                              |
| Screen   | `Esc`              | Go back; at the top of a screen, return to the menu |

## Screens

### Home

Shows the project directory, the configuration file and the state of each feature as `veritas doctor` reports it. If the project has no configuration yet, it offers to create `.veritas/config.json` with the detected settings, as `veritas init` does.

### Results

Lists the runs, newest first. Choose a run to see its command, profile, verdict, exit code, policy reasons, stages and findings. Choose a finding to see its evidence: the explanation, locations, cited sources, properties, tests, mutants, solver claims and next actions. These are the same lines that `veritas explain <finding-id>` prints.

### Specifications

Lists the properties of the latest run that produced them.

| Key     | Where    | Action                                                                                 |
| ------- | -------- | -------------------------------------------------------------------------------------- |
| `f`     | List     | Filter by status (all, proposed, reviewed, accepted, rejected, conflicted, superseded) |
| `d`     | List     | Show what changed since the previous run (`veritas spec diff`)                         |
| `Enter` | List     | Show the property: targets, cited text, conflicting properties and earlier decisions   |
| `a`     | Property | Accept, after entering a reason                                                        |
| `r`     | Property | Reject, after entering a reason                                                        |

A reason is required; with an empty reason nothing is recorded. The decision is written to `.veritas/approvals.json` with the actor from `VERITAS_ACTOR` or, if that is not set, the git `user.name`, exactly as `veritas spec accept` and `veritas spec reject` record it.

### Run

Choose the options, then **Start**:

| Option                          | Default       | Same as              |
| ------------------------------- | ------------- | -------------------- |
| Profile                         | `quick`       | `--profile`          |
| Offline                         | yes           | `--offline`          |
| Include proposed specifications | no            | `--include-proposed` |
| Since                           | whole project | `--since <ref>`      |

While the run is in progress, each stage is shown as it starts and ends. `Esc` cancels the run. When it finishes, the screen shows the verdict, exit code and number of findings; open **Results** to read them. Leaving the screen or quitting the TUI also cancels a run in progress.

### Improve tests

**Create a plan** works like `veritas improve`: it proposes tests whose expected values come from accepted specifications and writes no project file. Turn on **Also use proposed specifications** to use proposed ones too, as `--include-proposed` does.

The plan shows the goal, the proposed tests, risks and the patch. If there is something to apply, press `a` and confirm with `y`. The TUI then applies the plan with its approval token, as `veritas improve --apply --plan <id> --approve <token>` does. Every check of [applying a plan](/guide/improving-tests) still applies: the tests run in an isolated copy, the new test files are written only if every condition holds, and the attempt is refused in CI. `Esc` cancels planning or applying.

### Settings

Lists every value of `.veritas/config.json` by its path, such as `mutation.timeoutMs`. Choose a value to edit it. Enter numbers, booleans and lists as JSON (`5000`, `true`, `["src"]`); text can be entered as is.

Before anything is written, the new configuration is checked against the same schema `veritas` uses when it loads the file. Invalid values are listed with their path and are not saved. A valid change is shown as before and after, and is saved only after you confirm with `y`. Only `.veritas/config.json` is written.

A project configured with `veritas.config.ts`, `.mjs` or `.js` is shown as read-only, because loading those files executes project code. Edit them directly.
