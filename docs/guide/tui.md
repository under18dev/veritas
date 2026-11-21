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

The screen has a header with the project name and the latest run (its verdict as a colored label, exit code and start time), a menu on the left, the current screen on the right and the keys that work at the bottom. The bar at the bottom changes with the view, so it always lists the keys you can press right now. The panel that has the keyboard has a cyan border. Under the menu, a line says what the highlighted screen is for.

Colors mean the same thing on every screen: green is a success, yellow a warning or an incomplete result (partial, skipped, timeout, unsupported), red a failure, and cyan the item or panel you are on. A partial or inconclusive result is never shown in green. The TUI fits in an 80x24 terminal; content that does not fit scrolls with `↑` `↓`, and a line at the bottom of the panel says which rows are shown.

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

Home is a dashboard of four cards:

- **Project**: the project directory (with your home directory as `~`), the package manager and the configuration file.
- **Latest run**: the verdict, profile, how long ago it ran, how long it took, the exit code, every stage with a mark (`✔` succeeded, `!` partial or unsupported, `✖` failed, timed out or cancelled), the number of findings by severity, and the evidence the run recorded: test assessments, mutants, property-based tests and solver claims, each counted by status. There is no single score; the counts are the result.
- **Next steps**: what to do now and the key of the screen to do it on, such as `4` to start the first run, `2` to read findings or `3` to review proposed specifications. Press the key on Home to go there.
- **Tools**: each feature that `veritas doctor` reports, marked enabled (`✔`), degraded (`!`) or disabled (`✖`), and each missing tool with the features it turns off or limits.

In a wide terminal the cards sit in two columns. If the project has no configuration yet, Home offers to create `.veritas/config.json` with the detected settings, as `veritas init` does.

### Results

Lists the runs, newest first, one row per run: the verdict as a colored label, the number of findings, the profile, how long ago it ran and how long it took.

Choose a run to open it. A card at the top shows the verdict, exit code and policy reasons, followed by the stages with their marks and timings, the number of findings by severity and by kind, and the findings themselves, most severe first. Each finding shows its severity in color and whether it is `confirmed` or only `suspected`. Press `e` to see the run's evidence counts instead of the findings, and `e` again to go back.

Choose a finding to see why it was reported, then its evidence in sections: locations, sources with the quoted text, properties, tests and their assessments, mutants (survivors first) and solver claims. This is the same evidence that `veritas explain <finding-id>` prints. The next actions come last, under a separate heading, because they are suggestions and not evidence. Long findings scroll with `↑` `↓`. The linked evidence is kept for the latest run; for an older run, the finding is shown with the IDs of its evidence.

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

Lists every setting by section, such as **Sources**, **Mutation testing** or **Policy**, including settings the file does not set. `Enter` opens and closes a section (`→` and `←` work too). Each setting shows a readable name, its value and `changed` when the value differs from the default. A section's row counts the settings in it that are changed or unsaved.

The setting under the cursor is explained below the list: what it does, its current value, its default and the values it accepts. The descriptions and defaults come from the configuration schema, the same one behind the [configuration reference](/reference/configuration).

| Key     | Action                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter` | Change the setting: a switch turns on or off, a setting with fixed choices opens a list of them, a number or text opens a field, and a list opens a list editor |
| `Space` | Turn a switch on or off                                                                                                                                         |
| `r`     | Reset the setting to its default                                                                                                                                |
| `s`     | Review the unsaved changes and save them                                                                                                                        |
| `Esc`   | Leave; with unsaved changes, you are asked whether to discard them                                                                                              |

In the list editor, `a` adds an entry, `Enter` changes the selected one and `d` deletes it. A list of fixed choices, such as the report formats, is a list of boxes you tick with `Space`.

Every change is checked against the same schema `veritas` uses when it loads the file. A value it would refuse, such as text in a number field or a number out of range, is explained in red at the setting and does not change anything. Changes are not written right away: a setting with an unsaved edit is marked `*`, and the header counts the unsaved changes. `s` shows how many changes there are and each one as the value before and after. When they do not all fit, the review says how many more there are and `y` is accepted only after you have scrolled down to the last one, so nothing is saved unseen. A change that turns on network or LLM use is marked in the review. Only `.veritas/config.json` is written.

If the file already has problems, each one is listed above the settings. You can still fix them one at a time: an edit is accepted when it adds no new problem, and saving waits until there are none left. If the file cannot be read at all, for example because it is not valid JSON, Settings shows the error and `Esc` returns to the menu; fix the file in your editor.

The settings that let Veritas use the network or an LLM are marked `network` or `LLM`: the GitHub and web sources, sending whole documents to the LLM, the LLM provider, codex file reads, and running project code without network isolation. The mark is highlighted when the setting is on, and the explanation says what turning it on does. All of them are off by default. Even when they are on, a run that is offline (the default on the Run screen) reads no network source and sends nothing to an LLM. Running project code without network isolation is the exception: offline does not change it, because it is about what the project's own code can reach while Veritas runs it.

A project configured with `veritas.config.ts`, `.mjs` or `.js` is shown as read-only, because loading those files executes project code. The TUI never reads or writes them; edit them directly.
