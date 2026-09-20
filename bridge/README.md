# The Drive bridge

`Code.gs` is the Google Apps Script web app that the pipeline talks to. It is
the only route to the Question Papers folders: the tools in this repo never
use the Drive API directly.

## What it does

- `list`, `download`, `upload`, `move` on the five folders (`inbox`,
  `formatted`, `needsfixes`, `archive`, `template`), checked against the
  shared secret in the script property `TOKEN`.
- Class sub-folders: `formatted`, `needsfixes` and `archive` accept a path
  such as `formatted/Class-VII`. The sub-folder is created on first use, and
  only `Class-<Roman numeral>` names are allowed. `list` on the root of one of
  these folders also returns the files in its class sub-folders, each with a
  `sub` field, so the pipeline still sees every name in one call.
- `track`: appends one row per processed paper to the Google Sheet
  **Question Papers - Tracker**. The bridge creates the sheet next to the
  pipeline folders on first use and remembers it in the script property
  `TRACKER_ID` (to start a fresh sheet, delete that property).
- `notify`: emails the teacher who uploaded a paper. The recipient is always
  the owner of the file in Drive, chosen by the bridge, so the token cannot be
  used to mail anyone else. If the script property `COORDINATOR_EMAIL` is set,
  that address is copied on every mail and becomes the reply-to. Mail goes out
  under the name "VVCHS Question Papers" from the account that owns the script;
  Google allows about 100 such mails a day on a personal account. When Drive
  does not expose the uploader's email (shared drives), the bridge answers
  `sent: false` and the tracker row says so.
- `list` on the inbox and `download` also report the file's `owner` (the
  uploader's email) so the pipeline can record it.
- It never deletes, and it refuses to upload or move a file onto a name that
  already exists in the destination.

## Deploying a new version

1. Open the script project (Extensions › Apps Script from any file in the
   Question Papers folder, or script.google.com).
2. Replace the contents of `Code.gs` with this file. Keep the `TOKEN` script
   property as it is (Project Settings › Script Properties). Optionally add
   `COORDINATOR_EMAIL` there to get a copy of every teacher mail.
3. Check the five folder IDs at the top of the file match your folders.
4. Deploy › Manage deployments › edit the existing deployment (pencil) ›
   Version: **New version** › Deploy. Editing the existing deployment keeps
   the `/exec` URL the same, so `QP_BRIDGE_URL` does not change. If you create
   a new deployment instead, update `QP_BRIDGE_URL` in the environment.
5. Test from the repo:

   ```
   python3 qp.py ping                           # tracker URL, whether a coordinator copy is set, mail quota
   python3 qp.py list formatted                 # still works, now shows a "sub" column
   python3 qp.py list formatted/Class-VII       # empty until something is filed there
   python3 qp.py track '{"Original file": "test", "Result": "bridge test"}'   # creates the sheet on first use
   python3 qp.py notify <file-id> --subject "Bridge test" --body "Hello"    # mails the uploader of that file
   ```

   The first time the script uses Sheets or Mail, Google asks the script owner
   to grant those permissions: run any function once from the editor (Run ›
   `ping`) and accept the prompt, then redeploy.

## Turning the features on in the pipeline

Each bridge feature has a matching pipeline flag, all off by default, so the
pipeline keeps working against an older bridge:

| Flag | Needs | Effect |
| --- | --- | --- |
| `--class-folders` | class-aware bridge | outputs go into `Class-<n>` sub-folders |
| `--track` | `track` action | one tracker-sheet row per paper |
| `--notify` | `notify` action | the uploading teacher is emailed the outcome |

Once the tests above work, the routine's command becomes

```
python3 pipeline.py run --class-folders --track --notify --json
```
