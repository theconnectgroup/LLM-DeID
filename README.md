# LLM DeID

**De-identify client files before they reach an LLM.** Drop files or a folder in,
get one Markdown payload per file with every identifier replaced by a stable
token — plus a local map that puts the real values back into the model's answer.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#requirements)
[![Node](https://img.shields.io/badge/node-18%2B-brightgreen.svg)](#requirements)
[![Network](https://img.shields.io/badge/network-none-success.svg)](#privacy-model)

---

## Contents

- [Why](#why)
- [Privacy model](#privacy-model)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Supported formats](#supported-formats)
- [What gets tokenized](#what-gets-tokenized)
- [What it does not catch](#what-it-does-not-catch)
- [The dictionary](#the-dictionary)
- [The map](#the-map)
- [Themes](#themes)
- [Tests](#tests)
- [Packaging](#packaging)
- [Known gaps](#known-gaps)
- [Project layout](#project-layout)
- [Contributing](#contributing)
- [Licence](#licence)

## Why

Pseudonymization, not anonymization. True anonymization is irreversible, and
irreversible data is useless: the model cannot tell you that the same person
appears in three documents, and you cannot map its answer back to the real
ticket.

This replaces each identifier with a stable, typed token, keeps the key on your
machine, and restores the real values in whatever the model returns. The same
value always gets the same token — across files, and across runs.

It matters the moment text leaves the tenant boundary: a third-party chat window,
an API call, a vendor portal, a model you are evaluating. Purview labels and DLP
decide *where* a file may go; they do not deidentify its *content*.

## Privacy model

There is no network code in this app at all. It reads local files, writes local
files, and stops. No telemetry, no update check, no analytics.

Payloads are written as `.llm.md`. The map is the sensitive artifact — one per
client, never merged, never sent.

## Requirements

- **Node 18 or newer** (tested on Node 22) to run from source.
- **Windows** for the packaged build and for `.msg` / legacy formats via COM.
- **Office**, only if you want legacy `.doc` / `.ppt` extraction through COM.

Optional packages — each widens coverage, and the app tells you when a file
needed one that is missing:

| Package | Adds |
|---|---|
| `@kenjiuno/msgreader` | Outlook `.msg` without Outlook installed |
| `pdfjs-dist` | much better PDF text |
| `xlsx` | legacy `.xls`, and a fuller `.xlsx` read |
| `word-extractor` | legacy `.doc` |

```bash
npm install --save @kenjiuno/msgreader pdfjs-dist xlsx word-extractor
```

## Quick start

```bash
npm install --save-dev electron
npm start
```

Add files or a folder, optionally paste your name dictionary, press
**De-identify**. Per file you get a completeness badge, a token count and a
**Copy payload** button; **Save to folder…** writes everything out at once.

## Usage

1. **Triage first.** Drop a sample in and read the badges before batching a
   whole case folder — `_report.csv` shows per-file completeness.
2. **Check `_secrets.csv` before anything leaves the machine.** It records the
   rule, the line and the length, never the value. A credential sitting in a
   client file is a finding, not a redaction problem — rotate it.
3. **Attach the `.llm.md` payloads.** Never the originals, and never the map.
4. **Restore** the answer in the Restore panel with the in-session map.

## Supported formats

| Format | How | Fidelity |
|---|---|---|
| `.docx` | native OOXML | body, headers, footers, footnotes, comments, document properties |
| `.xlsx` / `.xlsm` | native OOXML, or SheetJS when installed | one CSV block per sheet; cached values, not formulas |
| `.pptx` | native OOXML | every slide plus speaker notes |
| `.pdf` | `pdfjs-dist`, else a built-in content-stream scrape | text layer only; a scan yields nothing and is flagged |
| `.eml` | native MIME | encoded headers, base64, quoted-printable, attachment names |
| `.msg` | `@kenjiuno/msgreader` | MAPI properties, no Outlook required |
| `.doc` | `word-extractor` | body text |
| `.xls` | SheetJS | cell values per sheet |
| `.ppt` | — | not readable without Office; convert to `.pptx` |
| `.txt` `.md` `.ps1` `.bat` `.csv` `.json` `.xml` `.log` | read as UTF-8 | verbatim |

## What gets tokenized

Stable typed tokens, consistent across a batch:

`[NAME_01]` `[ORG_01]` `[EMAIL_01]` `[PHONE_01]` `[SSN_01]` `[EIN_01]`
`[CREDITCARD_01]` (Luhn-checked) `[GUID_01]` `[SID_01]` `[MAC_01]` `[IP_01]`
`[HOST_01]` `[UNC_01]` `[USERPATH_01]`

Credentials are **not** tokenized — they are removed (`[SECRET_REDACTED]`,
`[CONNSTR_REDACTED]`, `[SECRET_REDACTED_PEM]`) and logged to `_secrets.csv` by
rule, line and length only. The value is never written to the log. Quotes around
a replaced value are kept so a redacted script still parses.

Deliberately left alone: build numbers, version strings, dates, error codes,
licence counts, and public vendor domains (see `KEEP_HOSTS` in `src/redact.js`).

## What it does not catch

- **Pictures inside Office files, and scanned PDFs.** Neither is read — a scan is
  flagged `EMPTY` rather than producing an empty-looking clean payload.
- **Names outside your dictionary.** Detection is dictionary and pattern based,
  not machine learning. Build the dictionary from the tenant.
- **Identification by combination** — a unique job title in a small town.
- **The contents of attachments** referenced by a `.msg`; only their names are read.

## The dictionary

One entry per line, optionally typed:

```text
person: Jane Doe
org: Acme Holdings
host: PC-NAME-01
```

`host:` covers device and server names — the ones with no domain in them, so the
automatic hostname rule cannot see them. `machine:` is accepted as a synonym.
Untyped lines are treated as people.

Generate the people from the tenant rather than typing them:

```powershell
Connect-MgGraph -Scopes User.Read.All, Organization.Read.All
Get-MgUser -All -Property DisplayName |
  ForEach-Object { 'person: ' + $_.DisplayName } |
  Set-Content .\names.txt -Encoding UTF8
```

Then add the client's legal name, trading names and brands as `org:` lines —
that is the leak that matters most, and the one nobody remembers.

The same list loads from a CSV with `Type,Name` columns. **Load CSV…** appends to
whatever is already in the box and skips anything already listed; **Save
template** writes a starter file:

```csv
Type,Name
person,Jane Doe
org,Acme Holdings
host,PC-NAME-01
```

## The map

`redaction-map.json` is the key: token to real value. It is written only when you
press **Save to folder…**, into the folder you choose. Treat it as client data;
one map per client, never merged.

The **Restore** panel uses the in-session map, so you can paste an answer and get
the real values back without saving anything.

## Themes

Three, switchable from the header, remembered between launches:

| Theme | Character |
|---|---|
| **Midnight** | cool slate, periwinkle accent — the default |
| **Iris** | warmer near-black, lavender accent |
| **Daylight** | light paper and ink, for projectors and screenshots |

Themes override CSS custom properties only. Adding a fourth is a
`[data-theme="name"]` block in `renderer/styles.css` plus one `<option>` — no
rule changes. Every text and control pair clears 4.5:1 contrast.

## Tests

```bash
npm test
```

Builds a synthetic corpus (docx, xlsx, pptx, pdf, eml, text, an empty PDF) in a
temp folder and checks extraction, tokenizing, secret quarantine, the round-trip
restore, and that no raw value survives into a payload. No Electron, no network.

## Packaging

```bash
npm install --save-dev electron-builder
npm run build
```

`npm run build` produces one portable `.exe` in `dist\` — self-contained, with
no runtime prerequisite. It is unsigned, so SmartScreen warns and any
allowlisting EDR needs a rule. For an installed build with shortcuts and an
uninstaller, use `npx electron-builder --win nsis`.

Two things bite when you sign it yourself:

- **Sign the inner exe, not just the installer.** The installer embeds a copy of
  the application exe, and that inner copy is what Windows and EDR see execute.
  Signing after packaging leaves it unsigned.
- **Allowlist by publisher, not by hash.** Every rebuild changes the hash; the
  signer is stable, and Electron's renderer, GPU and utility helpers are the same
  signed binary, so one certificate rule covers them all. A portable exe unpacks
  into `%TEMP%` on each launch, so no path rule can match it.

The filename carries no version — `win.artifactName` keeps it
`${productName} Setup.${ext}`, so a shortcut never goes stale on a bump. The
version is in the exe's own FileVersion/ProductVersion properties and in the
`dist\<version>\` folder.

Only the exe needs handing out. `win-unpacked/`, `.cache/`, `*.blockmap` and the
`builder-*.yml` diagnostics are build residue.

## Known gaps

- `redaction-map.json` is written as plain JSON. Electron's `safeStorage` (DPAPI,
  per Windows profile) would close it in a few lines.
- `.msg` and legacy `.doc` / `.xls` need the optional packages above; without
  them those formats degrade or fail rather than silently producing a partial
  payload.

## Project layout

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

## Contributing

```bash
npm test        # offline by design — no Electron, no network
npm run notices # after adding or removing a runtime dependency
```

The app has no network code; a change that adds any will be rejected. Run the
suite before opening a pull request, and keep the map out of any example or
fixture.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

You may use, modify and redistribute this, including commercially and inside a
closed product, provided you keep the copyright and licence notices and state
what you changed. Apache-2.0 also grants an explicit patent licence, which is why
it was chosen over MIT for a tool that touches security tooling.

`NOTICE` lists every third-party component that ships in the built application.
It is generated, not hand-maintained — dev tooling does not ship and is not
listed, and the Electron runtime is:

```bash
npm run notices
```

Re-run that after adding or removing a runtime dependency, or the list drifts
from what is actually in the installer.
