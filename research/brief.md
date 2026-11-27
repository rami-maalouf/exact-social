# Exact Social

An iPhone publishing client for a self-hosted Postiz workspace. The existing content-management agents and the mobile app should see the same connected accounts, posts and calendar. Postiz already handles provider authorization, uploads and timed delivery. Exact can own editing, local recovery, review and presentation.

## What Rami highlighted in the recording

| Time | Interaction | Product implication |
| --- | --- | --- |
| 0:06 to 0:45 | Compose from Publish or the bottom plus button. Switch between Queue, Drafts and Sent, then jump between calendar days. | Keep composing within reach even when the queue is empty. Use the same date and account selection across list and calendar. |
| 0:48 to 1:32 | Attach media, open an existing draft, start from a template, select an account and tap to inspect it. | Preserve the current editor while moving between destinations. Distinguish two accounts on the same network. |
| 1:38 to 1:55 | Instagram settings include a first comment and collaborators. | Read each destination's settings before showing an option. |
| 2:25 to 3:26 | Finalize with a time, publish now, save as draft or review each account's post. Closing offers Save as Draft or Discard. | Keep review reversible. Show the chosen account, media, copy and local delivery time together before submission. |
| 3:35 to 3:45 | Explicit request for Instagram Post, Reel and Story. | Verify each media format against the connected provider before enabling delivery. |
| 3:45 to end | Insights, templates and community replies are interesting. Publish is the priority. | Build the full compose-to-schedule loop first. |

Source: [Rami's Buffer walkthrough](https://photos.app.goo.gl/aNmRZL28YyaCZ3gWA).

## Reference screenshots

Buffer's composer keeps the selected destinations above the shared caption, and its schedule settings expose the account's time zone. Things' Upcoming view uses day headings and short rows so a reader can scan several days at once. The six images in references/ are publisher-provided App Store screenshots, collected for design study. [Buffer](https://apps.apple.com/us/app/id490474324) and [Things 3](https://apps.apple.com/us/app/id904237743).

## Existing software and integration evidence

The earlier conversation established an agent publishing project at ~/Documents/life-os/content-management. Its launcher supports local media uploads, draft creation and date-bounded calendar reads. A private draft was previously verified across the Mac and Oracle. The Swift client at ~/Documents/code/swift/PostizMobile already contains a share extension, upload manager, draft editor and account picker. These are references for preserving existing workflows.

A read-only check on November 27 returned eight enabled accounts and no calendar entries in the following seven days. The live Instagram integration reported a 2,200-character maximum, an attachment requirement and a collaborators array with a label per collaborator. Its post_type enum contained post and story. Reel delivery needs a video-specific check before presenting it as supported. Access keys belong in the native secret store.

The read-only adapter in lib/postiz.ts checks the response shape for account discovery and calendar envelopes. Run bun tools/check-postiz.ts with POSTIZ_INSTANCE (the HTTPS instance root) and POSTIZ_API_KEY in the environment. It prints counts only.

## Delivery behavior to verify

A draft saved on the phone should survive relaunch. A server draft should carry a remote ID so an agent can reopen it from Postiz. Scheduling must preserve the chosen instant across time zones. If a multi-account submit times out or partially succeeds, reconcile by destination before retrying. Keep the distinction between queued and published visible through the entire flow.
