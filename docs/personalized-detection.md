# Personalized detection experiments

This local workflow trains a separate classifier from selected GitHub issue and pull request snapshots.
It does not change the GitHub Action, its pinned model, or its fixed 0.80 cutoff.

## Requirements

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
