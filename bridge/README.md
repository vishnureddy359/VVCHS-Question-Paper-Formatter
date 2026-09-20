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
- It never deletes, and it refuses to upload or move a file onto a name that
  already exists in the destination.

## Deploying a new version

1. Open the script project (Extensions › Apps Script from any file in the
   Question Papers folder, or script.google.com).
2. Replace the contents of `Code.gs` with this file. Keep the `TOKEN` script
   property as it is (Project Settings › Script Properties).
3. Check the five folder IDs at the top of the file match your folders.
4. Deploy › Manage deployments › edit the existing deployment (pencil) ›
   Version: **New version** › Deploy. Editing the existing deployment keeps
   the `/exec` URL the same, so `QP_BRIDGE_URL` does not change. If you create
   a new deployment instead, update `QP_BRIDGE_URL` in the environment.
5. Test from the repo:

   ```
   python3 qp.py list formatted                 # still works, now shows a "sub" column
   python3 qp.py list formatted/Class-VII       # empty until something is filed there
   ```

## Turning class folders on in the pipeline

The pipeline only files into class sub-folders when run with
`--class-folders`. Until the new bridge is deployed, run it without the flag.
Once the test above works, the routine's command can be changed to

```
python3 pipeline.py run --class-folders --json
```

Files already in the flat folders stay where they are; new outputs go into
`Class-<n>` sub-folders. Moving the existing files into class folders is a
one-off `qp.py move` per file.
