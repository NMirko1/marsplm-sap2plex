# `500 REQUEST_PROCESSING_ERROR / "Data is Null"` on job update — we cannot change a job quantity

> # ✅ RESOLVED — 27 August 2026
>
> **Rockwell has fixed the defect, and we have verified the fix on the tenant:
> `PUT /scheduling/v1/jobs/{id}` responds.** The companion defect on backwards-schedule was fixed
> with it and has its own document
> ([PLEX_ISSUE_BACKWARDS_SCHEDULE_500](PLEX_ISSUE_BACKWARDS_SCHEDULE_500.en.md)). This document is
> kept as the record of what was observed; **the body below has not been rewritten** and is the one
> delivered on 20 August 2026. See the **"Closure"** at the end.
>
> One correction is on us, and it is independent of your fix: the "related defect" in §7 — the
> filtered read — **was not a defect of yours.** See §7 and the closure.

| | |
|---|---|
| **Tenant** | `ariston-albacin.test` |
| **Connect API host** | `test.connect.plex.com` |
| **Operation** | `PUT /scheduling/v1/jobs/{id}` (Job Scheduling API v1, `UpdateJob`) |
| **Building** | `Albacina` (`8b32a82e-2b93-4f70-b9ab-9342e4a61e93`) — the only active building on the tenant |
| **Observed** | 19 and 20 August 2026, reproducible on every attempt |
| **Severity** | ~~**Blocking.** No alternative path exists — see §5~~ · **RESOLVED on 27 Aug 2026** |
| **Status** | **CLOSED on 27 Aug 2026**: fixed by Rockwell and verified on our side |
| **Reported by** | Ariston / Genga — SAP-to-Plex integration project |

## 1. Summary

Every call to `PUT /scheduling/v1/jobs/{id}` on this tenant returns HTTP `500`:

```json
{ "code": "REQUEST_PROCESSING_ERROR",
  "message": "An unexpected error occurred while processing the request.",
  "metadata": { "internalMessage": "Data is Null. This method or property cannot be called on Null values." } }
```

This holds both with the full model and with **only the three fields `UpdateJob` declares mandatory**,
on a job that Plex itself created seconds earlier with a `201`, whose every field value we take
directly from the row `GET /scheduling/v1/jobs/{id}` returns for that same job.

`UpdateJob` documents `200`, `400` and `404`. A `500` with this message text indicates an unhandled
null reference inside the service, not a rejected request.

This is the operation that blocks us, for three compounding reasons:

- it is the **only** way to change a job's quantity or due date — no Data Source in our integration
  can do it (§5);
- our compensating rollback uses the **same** operation, so a partial failure cannot be undone (§6);
- a related read, `GET /scheduling/v1/jobs?jobNumber=`, fails the same way whenever a matching row
  exists, which leaves us unable to determine whether a job already exists (§7).

## 2. What we are trying to do, and why a quantity update is required

A SAP production order is shared with Plex as a single job, with the order number as `jobNumber` and
`externalJobCode`.

The plant frequently needs to work one order as several separate lots — different shifts, different
lines, partial releases. SAP does not model this: the order stays one order with one quantity.
Our integration therefore performs the split **on the Plex side only**, and the total quantity in
production must remain unchanged. Given a parent lot of `R` and a requested package of `q` (with
`0 < q < R`):

1. reduce the parent job from `R` to `R − q` → `PUT /scheduling/v1/jobs/{parentId}`
2. reschedule the parent, since its quantity changed → `POST .../backwards-schedule`
3. create the package as a new job, `<orderNumber>-000N`, with quantity `q` → `POST /scheduling/v1/jobs`
4. reschedule the package → `POST .../backwards-schedule`
5. align the package operations and BOM to the SAP order content → Data Sources
6. record the link back to the SAP order, so production booked on the package returns to the right order

The invariant is that parent quantity plus the quantity of every live package always equals the
original order quantity. Step 1 is the first write of the sequence, and it fails. Nothing after it
runs.

We reduce the parent **before** creating the package deliberately: if the second half fails, the
residual state is "the plant has less quantity than ordered", which is recoverable. The reverse order
would leave "more quantity than ordered" on a lot that operators may already have started, which is
not.

## 3. Reproducible case

Manufacturing order `000700000162`, part `3201816` (`f88d3fb9-0249-4dcb-ac64-3e16bce7b495`), job
`04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f`. Every job on the tenant had been deleted beforehand and our own
state reset, so this is a clean sequence.

**The job as Plex created it** (`POST /scheduling/v1/jobs` → `201`, read back identically with
`GET /scheduling/v1/jobs/{id}` → `200`):

```json
{ "id": "04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f",
  "externalJobCode": "000700000162", "jobNumber": "000700000162",
  "createdDate": "2026-08-20T05:00:00Z",
  "partId": "f88d3fb9-0249-4dcb-ac64-3e16bce7b495", "partNumber": "3201816",
  "dueDate": "2026-08-25T00:00:00Z", "completedDate": null,
  "quantity": 10, "quantityCompleted": null,
  "jobStatus": "New",
  "buildingId": "8b32a82e-2b93-4f70-b9ab-9342e4a61e93", "buildingCode": "Albacina",
  "jobType": "ZP07", "earliestStartDateTime": null, "priority": "Medium",
  "unit": "pcs", "endUnitNumber": "", "bomSubstitutionAllow": null }
```

**Attempt 1 — full model.** A `PUT` is the whole model rather than a patch, so we resend every field
the job currently carries, reducing quantity from `10` to `5`:

```http
PUT /scheduling/v1/jobs/04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f
Content-Type: application/json

{"dueDate":"2026-08-25T00:00:00Z",
 "quantity":5,
 "buildingId":"8b32a82e-2b93-4f70-b9ab-9342e4a61e93",
 "jobType":"ZP07",
 "priority":"Medium"}
```

→ `500`, body as in §1.

**Attempt 2 — the three mandatory fields only.** Our integration retries with the minimal documented
body on a `5xx`, to establish which shape the tenant accepts:

```http
PUT /scheduling/v1/jobs/04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f
Content-Type: application/json

{"dueDate":"2026-08-25T00:00:00Z","quantity":5,"jobType":"ZP07"}
```

→ `500`, identical body.

Notes on the values, since all of them are drawn from Plex and not from SAP:

- `dueDate` is read from the job, not from the SAP order, precisely so that a date changed inside Plex
  is not overwritten.
- `jobType` `"ZP07"` was accepted by `POST /scheduling/v1/jobs` and is stored verbatim; it is visible
  on the job in the Plex UI.
- `buildingId` and `priority` are echoed back from the same job. `priority: "Medium"` was assigned by
  the tenant default at creation.
- `earliestStartDateTime` is `null` on the job and is therefore not sent. The field is optional in
  `UpdateJob`.
- `quantity` is sent as a JSON number, as the contract declares.

## 4. Variables we ruled out

One variable changed at a time, across three jobs — including one created after every job on the
tenant had been deleted:

| Variable | Values tried | Result |
|---|---|---|
| Request body shape | full model (5–6 fields) · the 3 mandatory fields only | `500` in both cases |
| `buildingId` | absent · valid (`8b32a82e-…`, `Albacina`) | `500` in both cases |
| `earliestStartDateTime` | equal to `dueDate` · absent (`null` on the job) | `500` in both cases |
| `priority` | absent · `"Medium"`, assigned by the tenant default | `500` in both cases |
| `quantity` type | JSON string `"100.0"` · JSON number `5` | `500` in both cases |
| `dueDate` | in the past / same day · in the future (`2026-08-25`) | `500` in both cases |
| Job record age | pre-existing · created minutes earlier | `500` in both cases |
| Tenant state | pre-existing jobs · every job deleted, fresh start | `500` in both cases |

Meanwhile, on the same job and in the same minute: `POST /scheduling/v1/jobs` returns `201`,
`GET /scheduling/v1/jobs/{id}` returns `200`, and Data Sources `4216`, `4701`, `20051`, `10603` and
`239905` all return `200` — including the two that **write** (operation status, and the job sort order
update, which reports `"Job Sort Order Updated Successfully"`).

## 5. We have no alternative path, and this is our main question

Our integration uses twelve Data Sources on this tenant. Five of them write. **None of them writes a
job quantity:**

| Data Source | Purpose | Reads or writes |
|---|---|---|
| `4216` | job number → `Job_Key` | reads |
| `4701` | job operations | reads |
| `20051` | job operation → *NOT Required* | **writes** operation status |
| `10603` | job BOM rows of an operation | reads |
| `4858` | job BOM row → `Active = 0` | **writes** BOM row flag |
| `239905` | `Job_Sort_Order_Update` | **writes** work list sequence |
| `19529` | `Job_Complete` | **writes** job completion |
| `1786` | part number → `Part_Key` | reads |
| `29200` | `Part_Operation_Key_Get2` | reads |
| `11835` | workcenter code → `Workcenter_Key` | reads |
| `755` | `Approved_Workcenter_Delete` | **writes** approved workcenter |
| `20793` | `Part_Attribute_Upload` | **writes** part attribute |

So `PUT /scheduling/v1/jobs/{id}` is the only way we know of to change a job's quantity, and it is
unavailable.

There is a precedent worth citing, because it is how we solved a structurally identical gap. Approved
workcenters cannot be removed through the Connect API — it exposes only `GET` and `POST` on that
resource — and the removal was achieved through Data Source `755`, `Approved_Workcenter_Delete`.

**Our question is therefore:** is there a Data Source or stored procedure on this tenant that updates
the quantity of an existing job, in the same way `19529` `Job_Complete` closes one? If there is, we can
route around the defect immediately. If there is not, the `PUT` has to work.

## 6. Why a partial failure would be unrecoverable

The sequence in §2 is designed with a compensating rollback: if the parent lot has been reduced and the
package creation then fails, we restore the parent to its previous quantity. That restore is
**the same** `PUT /scheduling/v1/jobs/{id}`, sending the absolute previous quantity.

The consequence is not simply that the split cannot start. If the `PUT` were intermittently rather
than consistently broken, a split could reduce a parent lot, fail to create the package, and then fail
to restore it — leaving a production order permanently short on the shop floor, with quantity that is
in production on no lot at all, and no API path to correct it. Our operators would see the discrepancy
and have no remedy other than manual intervention in the Plex UI.

## 7. ~~Related defect~~ CORRECTED — the error was ours, not yours

> **Correction of 27 Aug 2026.** This section reported a third broken operation to you. **It was
> not.** The problem was ours: we were looking a job up **by number** where we should have looked it
> up **by identifier** — the UUID `POST /scheduling/v1/jobs` had already returned to us and which we
> store. The number stayed, but only for the one thing it is genuinely good for: proving that a job
> does **not** exist. Corrected on our side, and it has not recurred since.
>
> Our apologies: this section was delivered to you as a defect of yours, and it was not. The text
> below is the one from 20 Aug 2026 and remains as the record of what we had observed; **it is not to
> be read as an open report.** One thing it says does still hold, and it is ours: faced with an
> inconclusive result our integration **stops rather than guesses**, because creating a second job
> with the same number would be the worst outcome. That rule never depended on the defect and has not
> been touched.

`GET /scheduling/v1/jobs` returns `500` with the same body when a matching row exists, and `200` when
zero rows match. Observed on `?jobNumber=`, `?partId=` and `?externalJobCode=`, on jobs that are
visible and healthy in the Plex UI — for example `000700000000`, `000700000162`, `000700000163`.

We report it here because the split sequence depends on this read twice: to find the first free package
code, and to verify the outcome of a package creation whose response was inconclusive.

It also has a consequence beyond the split. Before sharing a production order with Plex we check
whether its job already exists. When that check returns an error rather than an answer, we cannot
distinguish "the job is not there" from "we could not find out" — and creating a second job with the
same number would be the worse mistake. Our integration now stops in that situation rather than
guessing, which means an order that cannot be checked is not sent at all.

Note also that this failing operation is a **read**: rates, workcenters, buildings and job operations
have no part in it. That is our reason for believing `"Data is Null"` covers at least two distinct root
causes.

## 8. What we have not tested

Stated for completeness, so §4 is not read as exhaustive. The first of these is probably the cheapest
test available to you, and we have not run it because our integration has no reason to:

- **A `PUT` that does not change the quantity** — resending the job's exact current quantity, or
  changing only `dueDate`. Every attempt we made reduced the quantity, so we cannot tell you whether
  the trigger is the write itself or the change of that particular field.
- **An `earliestStartDateTime` strictly earlier than `dueDate`.** We tested "equal to `dueDate`" and
  "absent", both `500`. Our source system delivers identical planned start and end dates for these
  orders, so we have never sent a positive-width window.

## 9. Impact, and what we are asking

**What is blocked today:**

- **Lot splitting is unusable.** The first write of the sequence fails, so no order can be split.
- **Re-synchronisation of any order already in Plex fails.** When a quantity or a delivery date changes
  in SAP, we update the existing job through this same `PUT`. That step is terminal in our sequence, so
  the order ends in error and is retried on every subsequent run, indefinitely.
- **The compensating rollback is unavailable**, as described in §6.
- **Existence checks are unreliable**, as described in §7.

Only the initial creation of a job works, which is enough for a first release but not for operations.

**What we would like from you:**

1. Whether a Data Source or stored procedure exists on this tenant to update a job quantity (§5). This
   is the fastest path to unblocking us, and it does not depend on a fix.
2. Confirmation of whether the `500` is a defect in the service or a tenant configuration we can
   correct — and if the latter, which setting. Note that where a tenant setup value is genuinely
   missing, your service returns `400` naming the field (for example `REQUEST_VALIDATION_FAILED` /
   `FIELD_REFERENCE_NOT_FOUND` on `Type` for a part-operation type not present in the setup table). A
   `500` with a generic null message gives us nothing to act on.
3. Whether `GET /scheduling/v1/jobs` with a filter (§7) is the same defect or a separate one.
4. We can re-run any specific request you name, enable additional tracing on our side, or give you the
   order and job identifiers above to inspect directly on the tenant.

---

## Update of 27/08/2026 — what changed on our side

The text above is the one delivered on 20/08/2026 and still stands: **the defect has not been
reproduced in any different way, and we have no workaround.** One thing has changed in our own
behaviour, however, and it needs stating because it affects §8 and §9.

**We no longer send a `PUT` when there is nothing to change.** Before updating a job we now re-read
its quantity and its due date and compare them with the SAP order; the `PUT` is issued only if at
least one of the two actually differs.

Two consequences for you:

- **§8, item 1.** The test we listed as never performed — "a `PUT` that does not change the quantity"
  — now **does not occur at all** on our side, because that call is not issued. It remains the
  cheapest test available to you, but it will no longer arrive spontaneously from our traffic.
- **§9, second bullet.** Re-synchronisation of an **unchanged** order no longer fails: it issues no
  request at all. It still fails, with the same `500`, for every order whose quantity or date has
  genuinely changed in SAP — which is the use case the operation exists for.

The rest of the impact is unchanged: lot splitting remains unusable and the compensating rollback is
unavailable.

---

## Closure — 27 August 2026

**Rockwell has fixed the defect and we have verified the fix on tenant `ariston-albacin.test`:
`PUT /scheduling/v1/jobs/{id}` responds.** The companion defect on backwards-schedule was fixed with
it ([PLEX_ISSUE_BACKWARDS_SCHEDULE_500](PLEX_ISSUE_BACKWARDS_SCHEDULE_500.en.md)).

The body of this document — §1 through §9, plus the 27 Aug update above — **has not been rewritten**:
it is the record of what was observed and how the case was built. Read it in the past tense.

**What this unblocks**, point by point against §9:

- **Lot splitting**: step P1 reduces the main lot and the sequence proceeds.
- **Re-synchronisation of an order already in Plex**: a quantity or due date changed in SAP now
  reaches Plex. Since feature 0033 the `PUT` is issued **only if one of the two actually changed**,
  and that choice stays — it was never a workaround for the defect but a saved call, and it still is.
- **The compensating rollback**: R1 can restore the main lot to its previous quantity. The scenario in
  §6 — an order permanently short on the shop floor with no API path to correct it — is no longer
  possible.
- **Existence checks**: those were broken through our own fault, and have been corrected. See §7.

**What falls away from the §9 requests.** All four close. In particular the first, which was the most
important — *"is there a Data Source that updates a job quantity, the way 19529 completes it?"* — is
**no longer needed**: it was a request for a workaround, and with a working `PUT` there is nothing to
work around. We therefore do not need that Data Source.

**What remains untested**, stated so §8 is not read as closed: an `earliestStartDateTime` **strictly
earlier** than `dueDate`. We still do not send it, and that remains a deliberate choice of ours — the
source system delivers identical planned start and end dates, and a zero-width constraint is not sent.
The field is optional.

One general observation still stands, independent of this defect: when a configuration value is
missing, a `400` that **names the field** is actionable and a `500` with a generic null message is
not. It is the difference between a case that closes in an hour and one that took two dossiers.
