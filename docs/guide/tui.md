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

The screen has a header with the project name and the latest run (its verdict as a colored label, exit code and start time), a menu on the left, the current screen on the right and the keys that work at the bottom. The panel that has the keyboard has a cyan border. Under the menu, a line says what the highlighted screen is for.

| Where    | Key                | Action                                              |
| -------- | ------------------ | --------------------------------------------------- |
| Menu     | `↑` `↓` or `j` `k` | Move between screens                                |
| Menu     | `Enter` or `→`     | Enter the screen                                    |
| Menu     | `1` to `6`         | Open that screen directly                           |
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

While the run is in progress, the screen shows:

- the elapsed time and a progress bar of finished stages;
- every stage of the profile, with the time each finished one took and a clock on the running one;
- an activity log of what is happening: stages starting and ending, their results, processes such as mutator, Z3 and Vitest starting and ending, the output lines of mutator, and cache hits.

The spinner and the clocks move even when no new event arrives, so a long stage such as mutation testing does not look frozen. `Esc` cancels the run.

When the run finishes, the activity log is cleared and the screen shows the verdict, exit code, number of findings, total time, policy reasons and the stages as the run recorded them. `Enter` opens **Results** to read the findings.

If you cancel the run, the screen says **Run cancelled** and shows the run id and the stages as the run recorded them (a stage stopped by the cancel is usually `cancelled`, but can be recorded as `error`), without a verdict: the results of a cancelled run are incomplete. `Enter` still opens **Results**, where the cancelled run is the newest one. If the run fails or is cancelled, the last lines of the activity log stay on the screen to show where it stopped. Leaving the screen or quitting the TUI also cancels a run in progress.

### Improve tests

**Create a plan** works like `veritas improve`: it proposes tests whose expected values come from accepted specifications and writes no project file. Turn on **Also use proposed specifications** to use proposed ones too, as `--include-proposed` does.

The plan shows the goal, the proposed tests, risks and the patch. If there is something to apply, press `a` and confirm with `y`. The TUI then applies the plan with its approval token, as `veritas improve --apply --plan <id> --approve <token>` does. Every check of [applying a plan](/guide/improving-tests) still applies: the tests run in an isolated copy, the new test files are written only if every condition holds, and the attempt is refused in CI. `Esc` cancels planning or applying.

### Settings

Lists every value of `.veritas/config.json` by its path, such as `mutation.timeoutMs`. Choose a value to edit it. Enter numbers, booleans and lists as JSON (`5000`, `true`, `["src"]`); text can be entered as is.

Before anything is written, the new configuration is checked against the same schema `veritas` uses when it loads the file. Invalid values are listed with their path and are not saved. A valid change is shown as before and after, and is saved only after you confirm with `y`. Only `.veritas/config.json` is written.

A project configured with `veritas.config.ts`, `.mjs` or `.js` is shown as read-only, because loading those files executes project code. Edit them directly.
