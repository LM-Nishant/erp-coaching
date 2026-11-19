# Tally accounting export

The app keeps a double-entry ledger of fees, payments, refunds, expenses and other income. Accountants who keep the
books in Tally export that ledger as files that TallyPrime imports:

- a **masters** file with the ledgers the vouchers use;
- a **vouchers** file with one voucher per accounting entry.

Every export is kept with its totals, so the accountant can see what was recorded or changed after it and tie the app
to Tally.

Contents:

- [How it works](#how-it-works)
- [Supported Tally versions](#supported-tally-versions)
- [Who can use it](#who-can-use-it)
- [Setting up](#setting-up)
- [Importing Tally's ledger list](#importing-tallys-ledger-list)
- [Creating an export](#creating-an-export)
- [Importing into Tally](#importing-into-tally)
- [What the vouchers contain](#what-the-vouchers-contain)
- [Importing again](#importing-again)
- [Reconciliation](#reconciliation)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Testing without Tally](#testing-without-tally)
- [What only a real Tally install can verify](#what-only-a-real-tally-install-can-verify)

## How it works

Tally has no cloud API. Its XML server listens on the accountant's own computer, which a hosted server can't reach, so
the integration works with files:

1. **Map** the app's ledger accounts to Tally ledgers (**Tally export** in the menu, then its settings). The defaults work
   without changes.
2. **Export** a period for a branch or for the whole institute: preview it, then create the export.
3. **Import** the two files in Tally: the masters first, then the vouchers.
4. **Reconcile:** the export's page lists entries recorded, changed or cancelled after it, and compares its ledger
   totals with the app.

The files use Tally's XML import format: an `ENVELOPE` with an `Import Data` request whose `IMPORTDATA` holds the
`All Masters` (ledgers) or `Vouchers` report. Nothing is sent to Tally, and nothing is read back from it apart from
the optional [ledger list](#importing-tallys-ledger-list). No server settings are needed.

## Supported Tally versions

| Tally                          | Import menu                                                        |
| ------------------------------ | ------------------------------------------------------------------ |
| TallyPrime (the files' target) | Alt+O (Import) → **Masters**, then Alt+O → **Transactions**        |
| Tally.ERP 9 (release 6.x)      | Gateway of Tally → Import of Data → **Masters**, then **Vouchers** |
| Tally 9 and older              | Not supported                                                      |

The files are plain ASCII without an XML declaration, like Tally's own exports. Characters outside ASCII (₹, names in
Indian scripts) are written as XML character references such as `&#8377;`. Dates are `YYYYMMDD`, and amounts have
two decimals.

## Who can use it

| Role            | Permissions (`tally.*`)   | Can                                                                   |
| --------------- | ------------------------- | --------------------------------------------------------------------- |
| Institute admin | all                       | Everything                                                            |
| Accountant      | `view, configure, export` | Settings and ledger mapping, the ledger list, exports and their files |
| Branch admin    | `view, export`            | See the settings and exports, create exports and download their files |
| Other roles     | none                      | Nothing                                                               |

Users limited to some branches, or with a branch selected in the branch switcher, work only with those branches:
their settings, mapping, ledger list and exports. Institute-wide settings and **All branches** exports need an
institute-level user with no branch selected.

Audit events: `tally.settings.updated`, `tally.mapping.updated`, `tally.ledgers.imported`, `tally.ledgers.cleared`,
`tally.export.created` and `tally.export.downloaded` (with the file and its count). Each is logged against its branch,
or as institute-wide for institute-wide settings and **All branches** exports, so users limited to some branches see
their branches' events in the audit log.

## Setting up

Settings, the ledger mapping and the ledger list exist for the institute (**All branches**) and for each branch. A
branch inherits whatever it doesn't set itself. Two common setups:

- **One Tally company for the institute:** export **All branches**. Map each branch's cash or bank account to its
  own ledger if Tally should keep them apart.
- **One Tally company per branch:** set each branch's company name and export each branch on its own.

Entries without a branch are only in **All branches** exports. A voucher has the same id in a branch export and an
institute-wide export, so importing both into one company doesn't duplicate it.

### Company

The **company name** is the Tally company the files are for. It is written into the files (`SVCURRENTCOMPANY`) and
shown on the export page, and **Only new entries** compares an export with earlier exports to the same company.
Open that company in Tally before importing.

### Ledger mapping

Every app account maps to a Tally ledger name and its parent group. The defaults:

| App account                                     | Tally ledger                                               | Group                               |
| ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| Student fees receivable                         | Student Fees Receivable                                    | Sundry Debtors                      |
| Student fee advances                            | Student Fee Advances                                       | Current Liabilities                 |
| Fee income                                      | Fee Income                                                 | Direct Incomes                      |
| Late fee income                                 | Late Fee Income                                            | Indirect Incomes                    |
| Fee concessions and discounts                   | Fee Concessions & Discounts                                | Indirect Expenses                   |
| GST payable, [split](#gst-ledgers)              | Output CGST, Output SGST, Output IGST                      | Duties & Taxes                      |
| GST payable, one ledger                         | Output GST                                                 | Duties & Taxes                      |
| Cash                                            | Cash                                                       | Cash-in-Hand                        |
| Cheques and transfers not yet in a bank account | Cheques in Hand                                            | Cash-in-Hand                        |
| Each bank account (Accounting → Bank accounts)  | The bank account's name                                    | Bank Accounts                       |
| Each payment gateway (online payments)          | _Gateway_ Gateway Clearing, e.g. Razorpay Gateway Clearing | Bank Accounts                       |
| Payment gateway charges                         | Payment Gateway Charges                                    | Indirect Expenses                   |
| Each expense category                           | The category's name                                        | Indirect Expenses                   |
| Each income category                            | The category's name                                        | Indirect Incomes                    |
| Expenses and other income without a category    | Expenses, Other Income                                     | Indirect Expenses, Indirect Incomes |
| An account the app doesn't recognise            | Its name in title case                                     | Suspense A/c                        |

Change a row to use your existing ledger, for example `HDFC Bank A/c` or `Tuition Fees`. **Reset** goes back to what
the level inherits. A branch's change applies only to that branch's entries; the institute's applies to every branch
that doesn't override it.

Rules:

- Tally ledger names are unique and case-insensitive. Several app accounts may share a ledger in the same group (all
  expense categories in `Office Expenses`, say), but one name under two groups is a **conflict**, and conflicts block
  exports until fixed.
- A ledger's group must exist in Tally. Tally's predefined groups always do. Create custom groups in Tally first: the
  preview lists the groups it doesn't know, and [importing the ledger list](#importing-tallys-ledger-list) teaches it
  yours.
- Names are at most 100 characters.

### Student dues: one ledger or a ledger per student

- **One receivable ledger** (default): every student's dues and advances post to `Student Fees Receivable` and
  `Student Fee Advances`. The app keeps the detail per student.
- **A ledger per student:** dues and advances post to a party ledger named `Name (Admission no.)`, or `Name (ST-12)`
  for a student without an admission number, under the receivable's group (Sundry Debtors by default). The masters
  file creates the party ledgers, with bill-wise details off.

Renaming a student or changing their admission number gives a new ledger name. The old ledger stays in Tally, and the
reconciliation flags the student's exported vouchers as **Ledger mapping changed**; export them again to move them.

### GST ledgers

- **Split** (default): `Output CGST`, `Output SGST` and `Output IGST`, written with the GST duty heads Central Tax,
  State Tax and Integrated Tax. Each receipt's tax is split in that receipt's CGST/SGST/IGST proportions.
- **One ledger:** `Output GST`.

The app carves GST out when a fee payment is received: a journal moves the tax from Fee Income to GST payable, under
the receipt's GST invoice number. See [Limitations](#limitations) for what this means for Tally's GST returns.

### Voucher types

The defaults are Tally's own **Receipt**, **Payment**, **Contra** and **Journal**. Fee charges are journals; give
them their own type by entering its name, after creating it in Tally as a voucher type of class Journal (for example
`Fee Charge`). Any custom name must exist in Tally before the vouchers are imported.

## Importing Tally's ledger list

Optional, but recommended. With your ledger list imported:

- the mapping editor suggests your existing ledgers and groups;
- the masters file creates only the ledgers Tally doesn't have yet, and leaves yours alone;
- your custom groups are known, and ledgers under groups beneath Cash-in-Hand or Bank Accounts count as cash or bank
  when choosing voucher types.

Export the list from Tally:

- **TallyPrime:** Alt+G (Go To) → List of Accounts → Ledgers (or Gateway of Tally → Chart of Accounts → Ledgers).
  Press Alt+E (Export) → Current, then C (Configure): File Format **XML (Data Interchange)**, Type of Master **All
  Masters**. Press E (Send).
- **Tally.ERP 9:** Gateway of Tally → Display → List of Accounts, then Alt+E with the format XML (Data Interchange).

Upload the file on the **Tally list** tab of the settings, for the institute or for a branch. It may be up to 25 MB, in
UTF-8 or UTF-16. Only ledger and group names and their parents are read. A new upload replaces the level's previous
list, and a branch without its own list uses the institute's.

## Creating an export

1. Open **Tally export** in the menu. Pick the branch (or **All branches**), the period (at most 366 days), and
   whether to include **only new entries**.
2. **Preview** shows the vouchers by type, the debit and credit per ledger, the ledgers the masters file will create,
   and warnings: mapping conflicts (these block the export), groups Tally may not have, entries changed since an
   earlier export, and entries left out.
3. **Create export** saves the export with every voucher in it. Its files can be downloaded again at any time and
   always have the same content.
4. Download the **Masters** and **Vouchers** files. On iOS and Android they open the share sheet, so you can send
   them to the computer that runs Tally.

**Only new entries** leaves out entries already exported, unchanged, to the same company. Entries changed since are
included again, and Tally updates them in place. Without it, the export holds every entry in the period, which is
safe to import again (see [Importing again](#importing-again)).

An entry is left out of the files, and listed on the export's page, when its lines cancel out in Tally (for example
when both sides map to the same ledger), or when it doesn't balance or has no valid date (neither should happen).

An export holds at most 20,000 vouchers; split a longer period.

## Importing into Tally

1. Back up the company. TallyPrime offers this on the import screen.
2. Open (select) the company the files are for.
3. Import the **masters** file:
   - TallyPrime: Alt+O (Import) → Masters. Choose the file. For **Behaviour of import if masters already exist**,
     choose **Ignore Duplicates**, which keeps your existing ledgers as they are.
   - Tally.ERP 9: Gateway of Tally → Import of Data → Masters, with the same behaviour.
4. Import the **vouchers** file:
   - TallyPrime: Alt+O (Import) → Transactions.
   - Tally.ERP 9: Gateway of Tally → Import of Data → Vouchers.
   - If your release asks what to do with vouchers that already exist, choose to modify or overwrite them, not to add
     them.
5. Check Tally's import summary for errors. Tally logs the details in `tally.imp` in its folder.
6. [Reconcile](#reconciliation) the period.

The masters come first because a voucher that uses a missing ledger fails.

## What the vouchers contain

One voucher per accounting entry in the app, with the entry's date. Lines that map to the same Tally ledger are
combined, debits first.

| Entry in the app                         | Lines                                                                         | Voucher type      | Voucher number                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| Fees charged to a student                | Dr receivable, Cr Fee Income                                                  | Fee charge        | `CHG-<account>`                                       |
| Extra charge                             | Dr receivable, Cr Fee Income                                                  | Fee charge        | `ADJ-<id>`                                            |
| Concession or discount                   | Dr Fee Concessions & Discounts, Cr receivable                                 | Journal           | `ADJ-<id>`                                            |
| Late fee                                 | Dr receivable, Cr Late Fee Income                                             | Fee charge        | `LATE-…`                                              |
| Fee account cancelled (dues written off) | Dr Fee Income, Cr receivable                                                  | Journal           | `ACX-<account>`                                       |
| Advance applied to dues                  | Dr advances, Cr receivable                                                    | Journal           | `ADV-…`                                               |
| Fee payment                              | Dr cash, bank, Cheques in Hand or gateway clearing; Cr receivable or advances | Receipt           | The receipt number                                    |
| GST on a payment                         | Dr Fee Income, Cr Output GST ledgers                                          | Journal           | The GST invoice number                                |
| Gateway charges on an online payment     | Dr Payment Gateway Charges, Cr gateway clearing                               | Payment           | `GWF-<payment>`                                       |
| Coupon on a payment, and its reversal    | Fee Income against receivable                                                 | Journal           | `CPN-…`, `CPNR-…`                                     |
| Refund                                   | The payment reversed, plus its GST and any write-off                          | Payment / Journal | `RFD-<refund>`, `RFD-<refund>-GST`, `RFD-<refund>-WO` |
| Payment cancelled                        | The same, for the cancelled payment                                           | Payment / Journal | `PCX-<payment>`, …                                    |
| Expense                                  | Dr expense category, Cr cash or bank                                          | Payment           | `FIN-<id>`                                            |
| Other income                             | Dr cash or bank, Cr income category                                           | Receipt           | `FIN-<id>`                                            |
| Expense or income cancelled              | The entry reversed                                                            | Receipt / Payment | `FINX-<id>`                                           |

The voucher type follows the lines, as Tally expects: **Receipt** when money only comes into cash or bank ledgers,
**Payment** when it only goes out, **Contra** when every line is cash or bank, and **Journal** otherwise, or the fee
charge type for charges with no cash or bank line. A ledger is cash or bank when its group is Cash-in-Hand, Bank
Accounts or Bank OD A/c, or a group beneath them in your ledger list.

The narration is the entry's own, then the student, then the app's entry key in brackets, such as
`Fees: Class 11; Student: Asha Rao (A-102) [charge:42]`. The party ledger is the largest non-cash line of a receipt
or payment, and the student's receivable on a fee charge.

## Importing again

Every voucher carries a fixed `REMOTEID` and `GUID`, `erpc-<institute>-<hash of the entry>`, the same in every export.
Tally matches vouchers on it, so importing a voucher again updates it instead of adding a copy. You can:

- import overlapping periods, or the same file twice;
- export a period again after changing the mapping, and import it over the earlier vouchers;
- download an old export again.

But:

- a voucher edited in Tally is overwritten when the same voucher is imported again;
- a voucher deleted in Tally comes back if it is imported again;
- nothing is ever deleted in Tally. An entry removed from the app is flagged **Removed from the app**, and you delete
  or reverse it in Tally yourself.

To keep the app's voucher numbers, set the voucher types' numbering to Manual (or Automatic with manual override) in
Tally.

## Reconciliation

Each export keeps its period, branch, company, the number of vouchers by type, the debit and credit per ledger, and a
fingerprint of every voucher. Its page compares that with the app now. The history shows, for each export, how many
entries in its period were recorded after it.

| Flag                        | Meaning                                                                                                  | What to do                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Recorded after the export   | An entry dated in the period, recorded after the export                                                  | Export again with **Only new entries**              |
| Changed since the export    | The entry's amounts, accounts or date changed in the app                                                 | Export again; Tally updates the voucher             |
| Removed from the app        | An exported entry no longer exists                                                                       | Delete or reverse the voucher in Tally              |
| Refunded or cancelled later | A refund or cancellation of an exported entry, recorded after the export, even if dated after the period | Export the period it is dated in                    |
| Ledger mapping changed      | The same entry, but now mapped to other ledgers, another voucher type or number                          | Export again if Tally should follow the new mapping |

**Totals** compares, per ledger, what the export sent with what Tally should hold for it now: the current version of
the exported entries plus the new ones. When the export says **In sync**, compare the exported totals with Tally: the
debit and credit of each ledger's vouchers for the same period (Ledger Vouchers, or the Trial Balance with its
transaction columns shown). Opening balances, entries made directly in Tally, and other exports on the same ledgers
also count there.

## Limitations

- **One way.** The app sends entries to Tally. Entries made in Tally don't come back, and the ledger list import
  reads only names and groups.
- **Payroll isn't exported.** Payroll doesn't post accounting entries in the app yet, so record salaries in Tally.
  Exporting payroll is a follow-up.
- **No deposits or settlements.** The app records neither banking cheques nor gateway settlements, so
  `Cheques in Hand` and the gateway clearing ledgers keep growing in Tally. Record the transfers to your bank in Tally
  as Contra vouchers, or map those accounts straight to the bank ledger. The bank statement matching in Accounting
  posts no entries.
- **GST returns.** GST is recorded as journals at receipt time, not as sales vouchers with GST details (party GSTIN,
  SAC, place of supply), so Tally's GSTR-1 and GSTR-3B don't include the app's fees. Use the app's receipts and
  invoices for GST filing.
- **Not exported:** opening balances, cost centres, bill-wise references and inventory. Start from a period after the
  opening balances you entered in Tally.
- **Voucher class.** Mixed vouchers with cash or bank lines on both sides are Journals.

## Troubleshooting

| Symptom                                                      | Check                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Tally: a ledger doesn't exist                                | Import the masters file first. If your ledger list says the ledger exists but it was renamed or deleted in Tally, upload the list again |
| Tally: a group doesn't exist                                 | Create the group in Tally, or map the ledger to a predefined group. The preview lists groups it doesn't know                            |
| Tally: a voucher type doesn't exist                          | Custom voucher type names in the settings must exist in Tally                                                                           |
| The vouchers went into the wrong company                     | Tally imports into the open company. Select the right one and import again                                                              |
| Vouchers doubled after a second import                       | The company differs, or Tally didn't match the voucher ids. Delete the copies, and report the Tally release                             |
| Export refused: a ledger is mapped under more than one group | Fix the conflict on the **Ledgers** tab; the preview names it                                                                           |
| Export refused: nothing to export                            | No entries in the period for the branch, or **Only new entries** with everything already exported to that company                       |
| Export refused: too many vouchers                            | Export a shorter period                                                                                                                 |
| Totals in Tally differ from the export                       | Vouchers edited or deleted in Tally, failed vouchers in `tally.imp`, entries made in Tally, or flags on the export's page               |
| Ledger list upload: no ledgers or groups found               | Export the List of Accounts as XML (Data Interchange), not Excel or PDF                                                                 |

## Testing without Tally

- `backend/src/modules/tally/tally-xml.test.ts`: the XML (well-formed, escaping, character references, balanced
  vouchers, amount signs, dates), voucher types and numbers, the GST split, and reading ledger lists in UTF-8 and
  UTF-16.
- `backend/test/tally.test.ts`: settings, mapping and conflicts, ledger lists, preview, exports and files, **Only new
  entries**, reconciliation flags and totals, permissions, and tenant and branch isolation.
- `e2e/tests/tally-export.spec.ts`: an accountant imports a Tally ledger list and sets the company name, previews and
  creates an export, downloads both files (checking names, balanced vouchers and `REMOTEID`s) and sees a later
  payment in the export's reconciliation.

## What only a real Tally install can verify

The files follow Tally's published XML structure, but these need TallyPrime and Tally.ERP 9 to confirm:

- **Re-import:** that `REMOTEID`/`GUID` makes Tally alter a voucher instead of adding a copy, and what the voucher
  import's behaviour options do on each release.
- **Masters:** what `ACTION="Create"` does for a ledger that already exists under each masters behaviour, and that
  the `TAXTYPE`/`GSTDUTYHEAD` tags set up the split GST ledgers.
- **Text:** that Tally decodes `&#…;` character references in names and narrations without an XML declaration or
  UTF-16.
- **Company:** whether `SVCURRENTCOMPANY` makes Tally refuse or redirect a file when another company is open.
- **Vouchers:** receipts into `Cheques in Hand` (a Cash-in-Hand ledger), mixed cash and non-cash journals, party
  ledgers with bill-wise details off, a custom fee charge type of class Journal, and voucher numbers under each
  numbering method.
- **GST:** that journals to the duty-head ledgers stay out of GSTR-1 without errors.
- **Ledger lists:** the List of Accounts export formats and menu paths across releases.
- **Tally.ERP 9:** that release 6.x imports the same files.
