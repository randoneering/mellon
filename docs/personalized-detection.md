# Personalized detection experiments

This local workflow trains a separate classifier from selected GitHub issue and pull request snapshots.
It does not change the GitHub Action, its pinned model, or its fixed 0.80 cutoff.

## Guided workflow

Use Node 24 and Git, and set `GH_TOKEN` or `GITHUB_TOKEN` to a read-only GitHub token.
Start the guide from the repository root:

```sh
node scripts/personalized-detection.mjs guided
```

Choose a source at the first prompt:

| Answer | Source |
| --- | --- |
| `repo` | Enter `OWNER/REPO` or `https://github.com/OWNER/REPO`, then choose issue and PR counts |
| `file` | Enter a path to a URL-list file |
| `manual` or blank | Enter individual issue and PR URLs, then a blank line to finish |
| A URL-list file path | Use that file directly, as before |

Repository counts default to 20 issues and 20 PRs.
Each count accepts 0 through 100; zero skips that type, and at least one count must be positive.
The guide selects the newest-created submissions across open and closed states, excludes PRs from the issue count, and labels issues before PRs.
For example, choose `repo`, enter `acme/project`, then enter `10` issues and `5` PRs.
If fewer submissions exist, the guide uses the available selection.
If none match, it offers another source without starting training.
Each type scans at most 10 pages of 100 entries; a PR-heavy issue listing can reach that bound.
If the scan limit stops selection, choose fewer issues or skip issues with a count of zero and retry.
Repository discovery uses fixed GitHub API endpoints, disables redirects, and gives each request a five-second timeout.
For access or rate-limit failures, check the repository and read-only token access, then retry after the GitHub rate limit resets if needed.

Choose separate local paths for the dataset, model, and report, preferably in a private directory outside the repository.
The guide asks for confirmation before writing to a Git-tracked destination or a new, unignored path inside a Git working tree.
It checks symlinked directories and enclosing repositories, and stops if it cannot verify Git status.
Git-ignored paths and paths outside Git working trees need no unignored-path confirmation.
Choose model and report paths that do not already exist: the guide checks both before collection or training starts.
Existing files, directories and dangling symlinks at either artifact path stop the guide.
Final exclusive writes still prevent overwriting an artifact created after those checks.

The guide starts with collection each time and skips previously labeled URLs.
Repository counts describe the newest selected submissions, including already labeled ones; reruns do not replace saved labels with older submissions.
To add older examples, increase the count within the limit or provide specific URLs.
Each accepted label is saved before the next prompt, so rerun the guide after an interruption to continue.
If you entered URLs manually, enter them again when restarting; the guide skips URLs already labeled.
Choose new model and report paths for each run.
If you add labels after training, train a new model before evaluating the changed dataset.
Training requires examples from both labels, and a usable holdout is needed for evaluation.
The report records comparison metrics and warnings; small or unrepresentative datasets cannot establish authorship or prove which detector is better.

## Individual commands

Use Node 24.
Choose explicit paths for URL list, dataset, model, and report.
Keep dataset and artifacts outside tracked paths; the CLI warns before writing to a tracked dataset.
Artifact writes do not overwrite existing model or report files.
Missing parent directories are created with owner-only permissions; existing directory permissions remain unchanged.
New artifact files use owner-only permissions.

```sh
export GH_TOKEN=github_pat_read_only_value
node scripts/personalized-detection.mjs collect --urls ./private-urls.txt --dataset ./private-data/submissions.json
node scripts/personalized-detection.mjs train --dataset ./private-data/submissions.json --model ./private-data/model.json
node scripts/personalized-detection.mjs evaluate --dataset ./private-data/submissions.json --model ./private-data/model.json --report ./private-data/report.json
```

Token needs read access to issue and pull request metadata in selected repositories.
Use a fine-grained token with **Issues: read** and **Pull requests: read** only, or equivalent read-only public access.
The CLI never prints the token and sends it only to GitHub's API.
Do not put token in URL list or command arguments.

The URL list accepts one `https://github.com/OWNER/REPO/issues/NUMBER` or `/pull/NUMBER` URL per line.
Terminal control characters in fetched titles and descriptions are escaped for display; saved snapshots retain original text.
CLI snapshots title and description locally, then prompts for `human`, `ai`, or `unsure`.
Each accepted label is saved atomically, so rerunning collect skips already labeled URLs and resumes after interruption.
Fetch failures do not remove existing records.

## Privacy and labels

Snapshots, labels, model, and report can contain private repository text.
They remain local; workflow does not upload them.
Protect destination permissions and do not commit the dataset, model, report, token, or private text.

Labels capture reviewer belief, not verified authorship.
Choose `unsure` when evidence is unclear.
Unsure examples remain in dataset and are excluded from split, training, and evaluation.
Avoid using current detector output as sole label evidence.

## Split and limits

The workflow groups identical prepared text, removes exact duplicates with conflicting labels, and assigns groups deterministically to an approximately 20% holdout.
Class-stratified group assignment places both labels in training and holdout when each label has enough independent groups; impossible splits retain warnings.
Training-only documents determine classifier vocabulary and IDF.
Classifier version 2 tokenizes Unicode letters, marks, and numbers; scoring retains compatibility with version 1 artifacts using their original ASCII tokenizer.
Small datasets may produce empty, small, or class-imbalanced holdouts; split warnings are stored with model.
Repeated templates and near-duplicates may still leak across groups.
Selected URLs may not represent future submissions, and reviewer labels may be wrong.
Newest-created repository samples can overrepresent recent templates, authors, or submission types; larger counts alone do not remove that bias.

The evaluation compares both detectors on the same holdout records.
Baseline flags scores at or above 0.80; personalized classifier uses 0.50.
Report includes class support, confusion counts, false positives, false negatives, precision, recall, unscorable examples, and warnings.
`null` precision or recall means denominator was zero.
Warnings indicate small or missing classes; metrics do not establish authorship or prove one detector is better.
Evaluation refuses a dataset that differs from the model's recorded snapshot.

## Synthetic example

For a disposable test, create a URL list containing selected public test issues and choose labels based on a synthetic exercise, not presumed authorship.
Use a temporary directory outside the repository for `--dataset`, `--model`, and `--report` paths.
The model is an experiment artifact and does not affect Action moderation.
