# Batch D: manual checklist (real Chrome on the Mac)

Run `npm run build`, then reload the extension.

| # | Do | Expect |
|---|---|---|
| U1 | Open a page with a file upload (e.g. a form with "Choose file"). Click the **paperclip**, pick a small PDF | Chip "📎 name (KB) — say "upload it"" |
| U2 | Type **upload it** | The field shows the file name; the result says "not submitted"; nothing was sent |
| U3 | Type **upload it** with no file attached | "Attach the file first with the paperclip…"; nothing changes on the page |
| U4 | A 15 MB file | "larger than 10 MB" |
| P1 | Run any task, then open the **Privacy** tab | Inspector: last task, pages read, sensitive data (kinds only), models asked, "Sent off this device" |
| P2 | Open the Privacy tab after reopening the side panel | Shows the latest task from history |
| R1 | Re-test the Batch C Mac fixes: D7 stock alert, romanized Kannada/Hindi mixes by voice, the "/" menu | Work as fixed |
| R2 | Final regression: `npm test`, `npm run test:browser`, `npm run test:live` | Record the counts in BATCH_D_MAC_CHECK.md |
