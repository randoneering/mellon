# Qodo GitHub review evidence

`createReviewReader({ token, repositoryId, fetch })` reads only fixed GitHub resources for `randoneering/mellon`.
`readReview(run)` receives the repository/PR, exact full head SHA, externally approved identities and absolute deadline.
The existing Qodo PR-open integration stays unchanged.
No separate Qodo API credential, review command, settings change or test PR is required by this reader.

## Approved completion boundary

The maintainer explicitly approves a published current-head GitHub review as the completion boundary.
This establishes that a GitHub review was submitted, not that every Qodo background process finished.
Enable it only through this closed, externally pinned identity descriptor:

```js
qodoIdentities: [{
  userId: 151058649,
  appId: 484649,
  appSlug: 'qodo-code-review',
  completion: 'github-submitted-review-v1',
}]
```

The reader requires all of the following:

- GitHub App metadata and the App-slug bot account match both pinned immutable IDs.
- The open PR number, repository ID and full current head match the run.
- Current reviews belong to that verified bot, link to this PR, and have supported published states and valid submission metadata.
- Review bodies match the supported empty-body inline-review shape.
- All bounded associated comments are available without pagination/truncation or orphan current-head bot comments.
- Every finding binds its review/comment IDs, bot, PR, full commit, approved current right-side path/line and prepared-file blob.

Only that explicit submitted-review evidence can return `status: 'complete'`.
An empty body or no comments alone cannot establish completion.
`CHANGES_REQUESTED` without usable findings, pending reviews, unknown bodies or ambiguous data remain unsupported.
The representative `reviewId` is deterministic; findings from all accepted current-head reviews remain included.
An old-head review waits for a new submission until the existing deadline.
Historical reviews never count as current evidence.

Legacy `qodoIdentities: [{ userId }]` stays finding-only and cannot enable completion.
The coordinator passes `requireDraft: true` on every read, including waits.
An externally changed draft state stops before another model or publication effect rather than being hidden behind unsupported-review waiting.
The coordinator still requires fresh approved CI, no findings, an owned draft and every other authorization guard before `ready_for_human`.
It never approves, merges or marks the PR ready.

## Finding data and bounds

Existing current-head draft findings can enter the shared two-repair flow.
Qodo references use a null native CI test identity.
Text escapes markup, terminal and bidi controls within 4,000 UTF-8 bytes.
The Agent receives it only in a separate digest-bound untrusted data block.
The journal stores IDs/hashes, never the report text.

Requests have independent local five-second waits and 64 KiB response bounds.
Redirects, pagination and truncation fail closed.
Results are `waiting`, `findings`, `complete`, or `needs_attention` with fixed reason categories.
No raw API errors, credentials or provider bodies enter diagnostics.

## Evidence and live gates

`tests/fixtures/agent-worker-review/observed-pr22.json` records a public review whose commit is stale relative to the eventual PR head.
`observed-pr20.json` records an existing closed public PR with an empty-body current-head submitted review and independently observed App/bot metadata.
Both fixtures omit submitted issue text and provider comment bodies.
Controlled tests adapt that observed metadata into an open draft shape; they do not establish actual automatic draft/re-review behavior.

Before activation, separately verify the target installation reviews drafts and updated heads automatically.
Keep processing disabled if that preflight fails.
Do not post a command comment, change integration settings or mark the draft ready to manufacture evidence.
