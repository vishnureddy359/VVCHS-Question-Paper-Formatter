# VVCHS Question Paper Formatter

Tooling that reformats teacher-submitted question papers for Vidya Vihar
Convent High School, Chandrapur, to the school's CBSE-pattern template.

Papers flow through Google Drive folders (1_Inbox, 2_Formatted, 3_Needs-Fixes,
4_Archive, _Template) via a small Apps Script bridge; the tools in this repo
talk to that bridge, never to Drive directly.
