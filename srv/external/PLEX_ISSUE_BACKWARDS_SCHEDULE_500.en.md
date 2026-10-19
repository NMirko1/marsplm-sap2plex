# `500 REQUEST_PROCESSING_ERROR / "Data is Null"` on Backwards Schedule

> # ✅ RESOLVED — 27 August 2026
>
> **Rockwell has fixed the defect, and we have verified the fix on the tenant:
> `POST /scheduling/v1/jobs/{id}/backwards-schedule` responds.** This document is kept as the record
> of what was observed and how the case was built; **the body below has not been rewritten** and is
> the one delivered on 20 August 2026. See the **"Closure"** section at the end.
>
> One correction is on us, and it is independent of your fix: the third operation listed in §2 — the
> filtered read — **was not a defect of yours.** See §2 and the closure.

| | |
|---|---|
| **Tenant** | `ariston-albacin.test` |
| **Connect API host** | `test.connect.plex.com` |
| **Operation** | `POST /scheduling/v1/jobs/{id}/backwards-schedule` (Job Scheduling API v1) |
| **Building** | `Albacina` (`8b32a82e-2b93-4f70-b9ab-9342e4a61e93`) — the only active building on the tenant |
| **Observed** | 19 and 20 August 2026, reproducible on every attempt |
| **Reported by** | Ariston / Genga — SAP-to-Plex integration project |
| **Status** | **CLOSED on 27 Aug 2026**: fixed by Rockwell and verified on our side |
| **Caller status** | the integration suspended this call on 20 Aug 2026, re-enabled it on 27 Aug 2026 sending `useFirstApprovedWorkcenter: false`, and it is **in operation**. A failure would still not stop the sending sequence: the order would close with a warning carrying the response body |

## 1. Summary

Every call to Backwards Schedule on this tenant returns HTTP `500` with the following body,
regardless of the job it is called on:

```json
{ "code": "REQUEST_PROCESSING_ERROR",
  "message": "An unexpected error occurred while processing the request.",
  "metadata": { "internalMessage": "Data is Null. This method or property cannot be called on Null values." } }
```

The operation documents three outcomes — `200`, `400`, `404` — so this response is undocumented, and
the message text indicates an unhandled null reference inside the service rather than a rejected
request.

The jobs we call it on are created by Plex itself, seconds earlier, through
`POST /scheduling/v1/jobs` returning `201`. They read back correctly through
`GET /scheduling/v1/jobs/{id}`, they display correctly in the Plex UI, their operations exist, their
approved workcenters exist, and — see §4 — their production rates are populated. The request body is a
single optional boolean.

We have ruled out every variable on our side, one at a time (§5). We are asking you to identify the
null (§8).

## 2. Which operations fail, and which work on the same job

| Operation | Result observed 19-20 Aug 2026 | Status as of 27 Aug 2026 |
|---|---|---|
| `POST /scheduling/v1/jobs/{id}/backwards-schedule` | **500** | ✅ **fixed by Rockwell**, verified |
| `PUT /scheduling/v1/jobs/{id}` | **500** — reported separately, see the companion document on job quantity updates | ✅ **fixed by Rockwell**, verified |
| `GET /scheduling/v1/jobs?jobNumber=` · `?partId=` · `?externalJobCode=` | **500** when a matching row exists; `200` when zero rows match | ⚠️ **not a defect of yours** — see below |
| `POST /scheduling/v1/jobs` | `201` | unchanged |
| `GET /scheduling/v1/jobs/{id}` | `200` | unchanged |
| `GET /mdm/v1/parts`, `GET /mdm/v1/part-operations`, `GET /mdm/v1/buildings` | `200` | unchanged |
| `GET /production/v1/production-definitions/approved-workcenters` | `200` | unchanged |
| Data Sources `4216`, `4701`, `20051`, `10603`, `239905` against the same job | `200`, all of them | unchanged |

The three failing operations return an identical error body. The fact that the same message also
appears on a plain **read** — the `GET` by number, where rates, workcenters and operations play no
part — suggests that `"Data is Null"` is a generic wrapper covering more than one root cause.

> **Correction of 27 Aug 2026 on the third row.** The hypothesis above was half right: that message
> does cover more than one root cause, but the third operation **was not a defect of yours.** The
> problem was ours: we were looking a job up **by number** where we should have looked it up **by
> identifier**. We kept the number only as proof that a job does *not* exist, which is the one thing
> it is good for. Corrected on our side, and it has not recurred since. Our apologies: that row was
> reported to you as yours, and it was not.

## 3. Reproducible case

Manufacturing order `000700000162`, part `3201816` (`f88d3fb9-0249-4dcb-ac64-3e16bce7b495`).

**Step 1 — create the job.** Request:

```http
POST /scheduling/v1/jobs
Content-Type: application/json

{"partId":"f88d3fb9-0249-4dcb-ac64-3e16bce7b495",
 "dueDate":"2026-08-25T00:00:00.000Z",
 "quantity":10,
 "jobNumber":"000700000162",
 "externalJobCode":"000700000162",
 "jobType":"ZP07",
 "buildingId":"8b32a82e-2b93-4f70-b9ab-9342e4a61e93"}
```

Response `201 Created`:

```json
{ "id": "04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f",
  "externalJobCode": "000700000162", "jobNumber": "000700000162",
  "createdDate": "2026-08-20T05:00:00Z",
  "partId": "f88d3fb9-0249-4dcb-ac64-3e16bce7b495",
  "partNumber": "3201816", "partRevision": "", "partNumberRevision": "3201816",
  "dueDate": "2026-08-25T00:00:00Z", "completedDate": null,
  "quantity": 10, "quantityCompleted": null,
  "jobStatus": "New",
  "buildingId": "8b32a82e-2b93-4f70-b9ab-9342e4a61e93", "buildingCode": "Albacina",
  "jobType": "ZP07", "earliestStartDateTime": null, "priority": "Medium",
  "unit": "pcs", "endUnitNumber": "", "bomSubstitutionAllow": null }
```

**Step 2 — backwards schedule the job that was just created.** Request:

```http
POST /scheduling/v1/jobs/04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f/backwards-schedule
Content-Type: application/json

{"useFirstApprovedWorkcenter":true}
```

Response `500`, with the body shown in §1.

**Step 3 — the job is intact after the failure.** `GET /scheduling/v1/jobs/04e6a16b-…` returns `200`
with the row above. Data Source `4216` returns `Job_Key 5030152`; Data Source `4701` returns the four
job operations that Plex created together with the header:

| Op | Operation code | `Job_Op_Key` | `Part_Operation_Key` |
|---|---|---|---|
| 10 | `V100-Mont Rosette+Deflettore` | `16077979` | `29632992` |
| 20 | `L500-Mont Molla+Progr Calot` | `16077980` | `29632993` |
| 30 | `L1901-Tampone+Docum+Valv` | `16077981` | `29632994` |
| 40 | `L1500-Posiz Calotta+Manopola` | `16077982` | `29632995` |

Data Source `10603` returns the job BOM rows for each of the four operations, and Data Source `239905`
(`Job_Sort_Order_Update`) returns `Result_Code 0`, `"Job Sort Order Updated Successfully"`. So every
other interaction with this job — reads and writes alike — succeeds.

## 4. Tenant-side preconditions we verified as present

The operation is documented as *«Job Operation due dates are backwards scheduled based on **rates**
specified in process routing»*, so we checked, through your own APIs, everything that calculation
could depend on. All readings were taken on the failing job.

| Precondition | Reading used | Result |
|---|---|---|
| The part has routing operations | `GET /mdm/v1/part-operations?partId=` | **4 operations** |
| The job has operations | Data Sources `4216` → `4701` | **4 operations** (table in §3) |
| The operations have an approved workcenter | `GET /production/v1/production-definitions/approved-workcenters?partId=` | **4 approved rows**, one per operation |
| Those approved workcenters carry a rate | same reading | **4 of 4**, after we populated them — see below |
| The job has a building | `GET /scheduling/v1/jobs/{id}` | `Albacina` |
| The scheduling window has width | same reading | not measurable: `earliestStartDateTime` is `null`, because the field is optional and we do not send it — our source system delivers identical planned start and end dates for these orders |

**On the rates specifically.** They were initially empty, which made them our leading hypothesis. We
populated them by hand in the Plex UI, on `Engineering / ApprovedWorkcenter`, `PartKey 5097153`, one
`PartOperationKey` per operation (`29632992`, `29632993`, `29632994`, `29632995`), setting
`Setup (hrs)`, `Standard Rate`, `Ideal Rate`, `Target Rate` and `Crew` to `1`, with the `Schedule`
flag ticked. `GET /production/v1/production-definitions/approved-workcenters?partId=f88d3fb9-…` now
returns:

| Op | Workcenter | `workcenterId` | Rates |
|---|---|---|---|
| 10 | `LFE10` — *Postazione sacco* | `7193b479-93e2-4e40-8158-2adb5864a353` | `standardProductionRate=1`, `idealRate=1`, `targetRate=1`, `setupTime=1`, `crewSize=1` |
| 20 | `LFE60` — *4° Postazione assemblaggio finale* | `59eaa4d6-8b62-4234-95d3-ca7dc30d19a8` | same |
| 30 | `LFE220` — *19° Postazione assemblaggio finale* | `9698fac0-601b-4f48-993e-7a0ccf0533cc` | same |
| 40 | `LFE160` — *14° Postazione assemblaggio finale* | `90e9f87d-cabb-41b4-9b33-0038c36af482` | same |

With the rates in place we created a **new** job, on manufacturing order `000700000163` and the same
part `3201816`, and called Backwards Schedule on it. It returned **`500`**, with the same body. The
rate dependency named in the operation's own description is therefore satisfied, and is not the cause.

## 5. Variables we ruled out

One variable changed at a time, across three jobs — including one created after every job on the
tenant had been deleted and our own state reset:

| Variable | Values tried | Result |
|---|---|---|
| `buildingId` | absent · valid (`8b32a82e-…`, `Albacina`) | `500` in both cases |
| `earliestStartDateTime` | equal to `dueDate` · absent (`null` on the job) | `500` in both cases |
| `quantity` type | JSON string `"100.0"` · JSON number `10` | `500` in both cases |
| `dueDate` | in the past / same day · in the future (`2026-08-25`) | `500` in both cases |
| `priority` | absent · `"Medium"`, assigned by the tenant default | `500` in both cases |
| `jobType` | `"ZP07"`, accepted by `POST` and stored verbatim, visible in the UI | `500` |
| Job record age | pre-existing · created minutes earlier | `500` in both cases |
| Tenant state | pre-existing jobs · every job deleted, fresh start | `500` in both cases |
| Approved workcenter rates | absent · populated on all four operations | `500` in both cases |

## 6. Null values we cannot influence, in case they are relevant

Offered as information for your engineers, not as a diagnosis:

- `sequenceRate` is `null` on all four approved-workcenter rows, and the Plex UI does not expose the
  field — there is no way for us to populate it from the tenant.
- `quantityCompleted` is `null` on a job in status `New` with no production recorded, where `0` would
  be the expected value.
- `bomSubstitutionAllow` is `null` in the API response, while the job screen in the Plex UI shows
  *BOM Substitution Allowed* ticked.
- Job BOM rows on operation `10` carry `Child_Unit: "m"` with quantities `0.225` and `0.074` against a
  part whose `Unit` is `pc`, and `Unit_Conversion_Key` is `null` on those rows.

## 7. What we have not tested

Stated for completeness, so the list of variables above is not read as exhaustive:

- **An `earliestStartDateTime` strictly earlier than `dueDate`.** We tested "equal to `dueDate`" and
  "absent", both `500`. We have never sent a positive-width window, because our source system delivers
  identical planned start and end dates for these orders and we deliberately do not send a
  zero-width constraint. Note that the field is documented as optional, so a `500` when it is absent is
  a defect in itself.
- **`useFirstApprovedWorkcenter: false`.** Every observation in this document was made with `true`.
  Your API List for this project suggests `false` where operations should be scheduled across multiple
  workcenters, and we have since changed our own default to `false` — but the call is currently
  suspended, so `false` has never been exercised against your service.

## 8. Impact, and what we are asking

**Impact of this specific issue is limited**, and we say so plainly: the API List provided for this
project annotates this very step with *«Operator will change the Job Status to Schedule. We can ignore
this step in Integration»*. We have therefore temporarily disabled the call in our integration so that
end users are not shown an error, and job operations are simply left unscheduled after creation. This
is a workaround, not a resolution.

The companion issue on `PUT /scheduling/v1/jobs/{id}` is the one that blocks us, and it is documented
separately.

**What we would like from you:**

1. Confirmation of whether this is a defect in the service or a tenant configuration we can correct —
   and if the latter, which setting.
2. If it is a configuration gap, we would expect a `400` naming the field rather than a `500`: your
   service already does this elsewhere (for example `REQUEST_VALIDATION_FAILED` /
   `FIELD_REFERENCE_NOT_FOUND` naming `Type` when a part-operation type is not present in the tenant
   setup table). A `500` with a generic null message gives us nothing to act on.
3. If useful, we can enable additional tracing on our side, re-run any specific request you name, or
   grant you the order and job identifiers above to inspect directly on the tenant.

---

## Closure — 27 August 2026

**Rockwell has fixed the defect and we have verified the fix on tenant `ariston-albacin.test`:
`POST /scheduling/v1/jobs/{id}/backwards-schedule` responds.** The companion defect on the `PUT`
was fixed together with it and has its own document
([PLEX_ISSUE_JOB_QUANTITY_UPDATE_500](PLEX_ISSUE_JOB_QUANTITY_UPDATE_500.en.md)).

The body of this document — §1 through §8 — **has not been rewritten**: it is the one delivered on
20 August 2026 and remains the record of what was observed and how the case was built. Read it in
the past tense.

Three notes, closing as many loose ends in the text.

**§7, the two tests never performed.** They were `useFirstApprovedWorkcenter: false` and an
`earliestStartDateTime` strictly earlier than `dueDate`. The first has been exercised since 27 Aug
2026, when the call went back into operation carrying that value. The second **is still not
performed**, and that remains a deliberate choice of ours: the source system delivers identical
planned start and end dates, and we do not send a zero-width constraint. The field is optional, so
there is nothing to test.

**§2, third row — the correction.** The filtered read (`?jobNumber=`, `?partId=`,
`?externalJobCode=`) was reported to you as a third face of the same defect. **It was not.** The
problem was ours: we were looking a job up **by number** where we should have looked it up **by
identifier** — the UUID your creation call had already returned to us and which we store. The number
stayed, but only for the one thing it is genuinely good for: proving that a job does **not** exist.
Corrected on our side, and it has not recurred since. Our apologies.

**§8, the three requests.** All three fall away: it was a defect in the service, you fixed it, and
there is no tenant setting for us to change.

One general observation from §8 still stands, and we repeat it because it does not depend on this
defect: when a configuration value is missing, a `400` that **names the field** is actionable and a
`500` with a generic null message is not. Your service already does this elsewhere
(`REQUEST_VALIDATION_FAILED` / `FIELD_REFERENCE_NOT_FOUND` on `Type`), and it is the difference
between a case that closes in an hour and one that took two dossiers.
