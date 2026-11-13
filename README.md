# LLM DeID

De-identify client files before they reach an LLM.

Point it at a folder of client documents and it writes one Markdown file per
document, with names, email addresses, hostnames, file paths and account
identifiers replaced by tokens like `[NAME_01]` and `[HOST_02]`. The same value
always gets the same token, so the model can still follow one person across three
documents. A local map turns the answer back into real names.

Nothing is uploaded. There is no network code in the application.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Install

Node 18 or newer, tested on 22.

```bash
npm install --save-dev electron
npm start
```

Four optional packages widen format support. The app tells you when a file needed
one that is missing.

| Package | Adds |
|---|---|
| `@kenjiuno/msgreader` | Outlook `.msg`, without Outlook installed |
| `pdfjs-dist` | better PDF text |
| `xlsx` | legacy `.xls`, and a fuller `.xlsx` read |
| `word-extractor` | legacy `.doc` |

```bash
npm install --save @kenjiuno/msgreader pdfjs-dist xlsx word-extractor
```

## Using it

Add files or a folder, paste a name dictionary if you have one, press
**De-identify**.

Every file gets a completeness tag, a token count and a **Copy** button.
**Save to folder…** writes the payloads and the two reports into a folder you
pick. The map is not written; press **Save map…** if you want to keep it.

For a chunk you already have in front of you, paste it into the **Paste text**
panel and press **De-identify** there. Nothing is written to disk, and the
de-identified text stays on that panel until you copy it.

That panel works in both directions. Paste an answer that contains tokens and
**Re-identify** appears beside De-identify; it swaps them back from this session's
map and tells you how many resolved. Tokens it has never seen are left alone and
counted, so an unresolved token is never passed off as a real value.

Read `_secrets.csv` before anything leaves the machine. It records the rule, the
line and the length of anything that looked like a credential, never the value.
If something is listed, rotate it. A secret sitting in a client file is a finding,
not a redaction problem.

Attach the `.llm.md` files to the model. Not the originals, and not the map.

Put the real values back either way: **Re-identify** on the paste panel, or the
Restore panel at the bottom. Both read this session's map.

## Formats

| Format | How | Fidelity |
|---|---|---|
| `.docx` | native OOXML | body, headers, footers, footnotes, comments, document properties |
| `.xlsx` / `.xlsm` | native OOXML, or SheetJS when installed | one CSV block per sheet, cached values rather than formulas |
| `.pptx` | native OOXML | every slide plus speaker notes |
| `.pdf` | `pdfjs-dist`, else a built-in content-stream scrape | text layer only, a scan yields nothing and is flagged |
| `.eml` | native MIME | encoded headers, base64, quoted-printable, attachment names |
| `.msg` | `@kenjiuno/msgreader` | MAPI properties, no Outlook required |
| `.doc` | `word-extractor` | body text |
| `.xls` | SheetJS | cell values per sheet |
| `.ppt` | none | not readable without Office, convert to `.pptx` |
| `.txt` `.md` `.ps1` `.bat` `.csv` `.json` `.xml` `.log` | read as UTF-8 | verbatim |

## What gets replaced

`[NAME_01]` `[ORG_01]` `[EMAIL_01]` `[PHONE_01]` `[SSN_01]` `[EIN_01]`
`[CREDITCARD_01]` (Luhn-checked) `[GUID_01]` `[SID_01]` `[MAC_01]` `[IP_01]`
`[HOST_01]` `[UNC_01]` `[USERPATH_01]`

Credentials are removed rather than tokenized: `[SECRET_REDACTED]`,
`[CONNSTR_REDACTED]`, `[SECRET_REDACTED_PEM]`. Each one is logged by rule, line and
length, never by value. Quotes around a replaced value are kept so a redacted
script still parses.

Build numbers, version strings, dates, error codes, licence counts and public
vendor domains are left as they are. The vendor list is `KEEP_HOSTS` in
`src/redact.js`.

## What it misses

- Pictures inside Office files, and scanned PDFs. A scan is flagged `EMPTY` rather
  than producing a clean-looking empty payload.
- Names that are not in your dictionary. Matching is by dictionary and pattern,
  not by model.
- Someone identifiable by combination, such as a single job title in a town of
  900.
- File contents attached to a `.msg`. Only the attachment names are read.

## Dictionary

One entry per line, optionally typed.

```text
person: Jane Doe
org: Acme Holdings
host: PC-NAME-01
```

`host:` is for device and server names that carry no domain, where the automatic
hostname rule cannot see them. `machine:` works as a synonym. Untyped lines are
treated as people.

The people are easier to generate than to type.

```powershell
Connect-MgGraph -Scopes User.Read.All, Organization.Read.All
Get-MgUser -All -Property DisplayName |
  ForEach-Object { 'person: ' + $_.DisplayName } |
  Set-Content .\names.txt -Encoding UTF8
```

Add the client's legal name, trading names and brands as `org:` lines. That is the
one people forget.

A CSV with `Type,Name` columns works too. **Load CSV…** appends to whatever is
already in the box and skips duplicates, and **Save template** writes a starter
file.

```csv
Type,Name
person,Jane Doe
org,Acme Holdings
host,PC-NAME-01
```

## The map

`redaction-map.json` holds the token-to-value pairs. It is not written to disk
unless you press **Save map…** in the Results header, so nothing lands in your
folders by accident. Keep one per client; never merge them.

The map lives in memory for as long as the app is open. That is what lets Restore
work without saving anything, and what keeps a pasted chunk using the same tokens
as the files you processed before it. Closing the app discards it unless you saved
a copy.

**Clear session** in the header drops the map and the quarantined-secret log there
and then, without a restart. That is the control for moving from one client to the
next.

## Themes

Three, chosen in the header, remembered between launches.

| Theme | Look |
|---|---|
| Midnight | cool slate with a periwinkle accent, the default |
| Iris | warmer near-black with a lavender accent |
| Daylight | light paper and ink, for projectors and screenshots |

They swap CSS custom properties only.

## Tests

```bash
npm test
```

The suite builds a synthetic corpus in a temp folder (docx, xlsx, pptx, pdf, eml,
text, an empty PDF) and checks extraction, tokenizing, secret quarantine, the
round-trip restore, and that no raw value survives into a payload. It runs without
Electron and without network access.

## Building

```bash
npm install --save-dev electron-builder
npm run build
```

The exe lands in `dist\<version>\LLM DeID Setup.exe`. It is a portable build, so
the machine that runs it needs nothing installed. It is unsigned, so SmartScreen
warns on first run.

For an installed build with shortcuts and an uninstaller:

```bash
npx electron-builder --win nsis
```

## Known issues

- The map is plain JSON and is not encrypted at rest. Electron's `safeStorage`
  would close that gap.
- `.msg` and legacy `.doc` / `.xls` need the optional packages above. Without them
  those formats degrade or fail rather than producing a partial payload.

## Layout

```text
main.js              Electron main: window, dialogs, file walking, disk writes
preload.js           contextBridge API handed to the renderer
src/zip.js           minimal ZIP reader for OOXML containers (no dependencies)
src/extract.js       one extractor per file type
src/redact.js        the token engine
src/engine.js        batch orchestration: payloads, reports, map
renderer/            the window
scripts/notices.js   regenerates NOTICE from what actually ships
test/run.js          standalone checks, builds its own corpus
```

## Licence

Apache-2.0, see [LICENSE](LICENSE).

You can use, modify and redistribute this, commercially and inside a closed
product, as long as you keep the copyright and licence notices and say what you
changed. Apache-2.0 also carries a patent grant, which MIT does not.

`NOTICE` lists the third-party code that ships in the built application. It is
generated:

```bash
npm run notices
```

Run that after adding or removing a runtime dependency, or the list drifts from
what is actually in the exe.
