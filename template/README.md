# Template assets

Local copies of the read-only `_Template` folder in the Question Papers Drive
pipeline. The formatter uses these at build time so it never has to fetch
them through the bridge.

| File | Purpose | Drive file id |
| --- | --- | --- |
| `VVCHS_Question_Paper_Format_Spec.md` | Formatting rules, review checklist, naming and folder workflow | `1r-EmhXiP7diyiS7n1tWKclG3lK9HLzyJ` |
| `build_paper_example.js` | Reference docx-js builder (Maths IX HYE 2026-27) that the spec was written against | `1lrRzcISGOLk4b-hGD3VrheSz5VxGQ9BS` |
| `vvchs_logo.jpg` | School crest for the page-1 header (rendered at 47 x 41 pt) | `1GZOrns5f1U229skiAhMvL_EHtFjvl6Ra` |

To refresh a file from Drive:

```
python3 qp.py download <drive-file-id> --out template/
```
