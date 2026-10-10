# Relational hosting options for the Pokémon TCG Collection Tracker

**Researched:** 2026-08-06  
**Decision question:** Which managed AWS or non-AWS combination can provide a TypeScript frontend/backend, PostgreSQL-compatible relational storage, passwordless email authentication, scheduled catalog synchronization, backups, logs, and public Deck pages while targeting less than $10/month and preserving unrestricted atomic bulk transfers?

## Recommendation

Keep the application **provider-neutral at the PostgreSQL and HTTP boundaries**, and carry two candidates into a measured cost prototype:

1. **Preferred MVP candidate: Cloudflare Workers Paid + Neon Postgres + portable Better Auth email OTP.** It has the clearest fixed application-hosting floor ($5/month), a standard PostgreSQL database, useful queue/cron primitives, no application egress charge, and little infrastructure to operate. It meets the budget on Neon Free and can meet it on Neon Launch only when database compute remains below a measured active-CU budget. The weaknesses are the Free database's 0.5 GB storage, short restore/log windows, and dependence on scale-to-zero.
2. **AWS candidate: the existing serverless application topology, replacing DynamoDB with Aurora PostgreSQL Serverless v2 and using the RDS Data API.** It preserves Cognito/SES, CDK, Lambda, EventBridge, SQS, and CloudFront decisions while enabling relational transactions. It can be cheap when dormant, but 10,000 evenly distributed uncached public Deck reads can keep its 0.5-ACU minimum awake and make it cost roughly $44/month for database compute alone. Public Deck snapshots must therefore be served from edge/object storage, not read from Aurora on every view.

The sub-$10 target is **feasible but not guaranteed** for either candidate. It depends on edge-caching public content, bounding catalog/database bytes, keeping scheduled synchronization bursty, and measuring actual database awake time. Supabase is the cleanest integrated fallback if the production budget can rise to at least $25/month.

Do not couple the domain layer to Cognito identifiers, DynamoDB keys, Neon APIs, Supabase Row Level Security, or a platform-specific database HTTP API. Use ordinary PostgreSQL migrations, a repository boundary, portable user IDs, and adapters for authentication, email, jobs, object storage, and logging. This makes the Cloudflare/Neon and AWS/Aurora candidates replaceable without rewriting inventory rules.

## Workload and cost assumptions

The comparison uses the agreed envelope:

- 1,000 registered users and 200 monthly active users.
- One heavy collector with up to 25,000 Holdings.
- 10,000 anonymous public Deck views per month.
- English and Japanese TCGdex catalog synchronization on a schedule.
- Bulk transfer has no product-level Card Edition count limit. All Holding changes in one submitted transfer either commit in one PostgreSQL transaction or none do.
- Approximately 1,000 passwordless emails/month, matching the earlier conservative assumption of five emails per active user. Actual daily peaks are unspecified.
- US-region public pricing, USD, no promotional credits, and one production environment. Domain registration, taxes, paid support, staging environments, and CI overages are excluded.

Database size and traffic shape remain important unknowns. A 25,000-Holding user is unlikely by itself to challenge a small PostgreSQL database, but the normalized bilingual catalog, search indexes, auth tables, and other users may challenge Neon's 0.5 GB Free limit. A representative catalog import and 25,000-Holding fixture must be measured before selecting a free database plan.

## Candidate comparison

| Candidate | Estimated MVP bill | Under $10? | Sleep/resume and principal limits | Backups/logs | Operational and portability assessment |
|---|---:|---|---|---|---|
| **Cloudflare Workers Paid + Neon Free + Better Auth + Resend Free** | **About $5/month** | Yes, while all free quotas fit | Workers Paid includes 10M requests and 30M CPU-ms/month; Cron/Queue consumers can run for 15 minutes. Neon Free includes 100 CU-hours/project, 0.5 GB, 5 GB egress, and scales to zero after five idle minutes. | Neon: up to 6 hours or 1 GB of changes for restore, one day of metrics/logs. Workers Paid logs retain seven days within their included event allowance. | Lowest fixed cost and low operations. Standard PostgreSQL is portable; Workers runtime and Neon Auth are avoidable coupling. Free database size and recovery are marginal for production. |
| **Cloudflare Workers Paid + Neon Launch + Better Auth + email provider** | **$5 + Neon usage; Neon calls 140 CU-hours/1 GB a typical $15 intermittent database** | Possible only below a strict compute/storage budget | Neon Launch is $0.106/CU-hour, $0.35/GB-month database storage, $0.20/GB-month history, 100 GB egress included, up to seven-day restore, and three-day database logs. It scales to zero after five minutes. | Up to seven-day time travel; short native log retention. Cloudflare supplies seven-day Worker logs. | Better production recovery and support, but not reliably sub-$10. Pure usage billing avoids a fixed Neon subscription and standard PostgreSQL keeps migration straightforward. |
| **AWS serverless app + Aurora PostgreSQL Serverless v2/Data API** | **Roughly $1 fixed/storage/API floor plus $0.06 per active hour at 0.5 ACU; potentially $44/month if continuously awake** | Yes only with low awake time and cached public reads | Supported Aurora PostgreSQL versions can pause at 0 ACU after 5 minutes; typical resume is about 15 seconds and can exceed 30 seconds after deep sleep. The public pricing example is $0.12/ACU-hour. Data API avoids VPC/NAT/RDS Proxy, but responses are limited to 1 MiB and statements default to a 45-second timeout. | Automated backup storage up to 100% of cluster size is included; Aurora storage is durable across three AZs. CloudWatch provides the application logs under the existing bounded-log design. | Strong AWS integration and mature recovery, but much more infrastructure and AWS coupling. Standard PostgreSQL remains portable; Data API and Cognito need adapters. Cold-resume latency is visible. |
| **Vercel Hobby + Neon Free** | **$0 plus email** | Only for a personal, non-commercial MVP | Hobby includes 1M function invocations and can run functions up to five minutes with Fluid Compute; its cron schedule runs at most daily with loose timing. | Neon Free recovery/log limits; Vercel Hobby runtime logs are only one hour. | Technically credible for a private hobby project, but Vercel explicitly restricts Hobby to personal, non-commercial use. Vercel Pro starts at $20, so this cannot be the general production choice under $10. |
| **Railway Hobby with app + PostgreSQL** | **$5 minimum, likely around or above $10** | Uncertain and too tight to promise | Hobby includes $5 of usage; RAM is $10/GB-month, CPU $20/vCPU-month, volume $0.15/GB-month, and egress $0.05/GB. An always-resident PostgreSQL process using 0.5 GB consumes about the entire included $5 before application memory/CPU. App sleeping can be prevented by open connections or outbound traffic. | Seven-day app logs; volume/database backups and cron are available. | Easy deployment and standard PostgreSQL, but database operations/backups are attached to a volume service rather than a separately described managed HA database. Requires external auth/email and measured resource use. Not a safe hard-budget choice. |
| **Supabase Free or Pro** | **Free: $0; Pro: at least $25** | Free does not meet backup requirements; Pro misses budget | Free includes 500 MB database, 50,000 MAU, 5 GB egress, 500,000 Edge Function calls, and pauses after a week without activity. Pro includes 8 GB and does not pause. Supabase supports passwordless email OTP/magic links and `pg_cron`. | Free has no automatic backups. Pro has daily backups retained seven days; PITR costs about $100/month for seven-day retention. | Best all-in-one developer experience and PostgreSQL portability, but production recovery requires a plan above budget. Strong coupling is optional if the app avoids direct client/RLS dependence. |
| **Render app + Render Postgres** | **Above the target for backed-up paid database + app** | No credible production configuration below $10 | Free PostgreSQL is 1 GB, expires after 30 days, and is explicitly not for production; free web services sleep. Paid database storage is $0.30/GB in 5 GB increments, and each cron service has a $1 monthly minimum. | Paid PostgreSQL has automatic PITR: three days on Hobby workspaces and seven days on Pro. Free PostgreSQL has no backups. | Simple and portable, but paid app/database/cron resources do not provide a convincing sub-$10 production package. External auth/email required. |
| **Fly.io Managed Postgres + Machines** | **At least $38 database + $0.28/GB storage, before app** | No | Managed Postgres Basic is $38/month and includes HA, backups, pooling, monitoring, and support. | Managed backups and recovery included. | Solid managed product but far over budget. Fly's cheaper unmanaged Postgres is explicitly unsupported and would violate the managed-database/low-operations goal. |

Primary pricing and limits: [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Neon pricing](https://neon.com/pricing), [Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/), [Aurora auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html), [Data API limitations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.limitations.html), [Supabase pricing](https://supabase.com/pricing), [Supabase backups](https://supabase.com/docs/guides/platform/backups), [Railway pricing](https://docs.railway.com/pricing), [Railway serverless behavior](https://docs.railway.com/deployments/serverless), [Render free services](https://render.com/docs/free), [Render Postgres plans](https://render.com/docs/postgresql-refresh), [Render backups](https://render.com/docs/postgresql-backups), [Fly Managed Postgres](https://fly.io/docs/mpg/), and [Vercel Hobby](https://vercel.com/docs/plans/hobby).

## Cost sensitivity of the shortlisted candidates

### Cloudflare and Neon

Cloudflare Workers Paid has a $5 account minimum and includes static assets, 10 million dynamic requests, 30 million CPU milliseconds, Cron Triggers, and one million Queue operations; static asset requests and network egress do not add a charge at this scale. The agreed 10,000 public views and low authenticated traffic fit by several orders of magnitude, provided catalog work is queued and logs are sampled/bounded. [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Neon Free is the only configuration that makes the combined cost predictably $5, but it provides just 0.5 GB and 100 CU-hours. Compute suspends after five inactive minutes. A steady trickle of uncached queries can therefore consume the allowance even though the request count is small. Free recovery is limited to six hours or 1 GB of data changes, whichever applies first. [Neon pricing](https://neon.com/pricing)

Neon Launch has no monthly minimum, but the budget arithmetic is tight. With 2 GB of database storage and 1 GB-month of changed-data history, the $10 total ceiling leaves approximately `$10 - $5 - $0.70 - $0.20 = $4.10`, or only about **38.7 CU-hours**, for Neon compute. At 5 GB of data and 1 GB-month of history, the remaining compute allowance is about **28.8 CU-hours**. Neon's published representative intermittent workload is 140 CU-hours and 1 GB, with a typical spend of $15 for Neon alone. Launch is therefore a measured optimization target, not a cost guarantee. [Neon pricing](https://neon.com/pricing)

Public Deck snapshots should be immutable edge-cacheable documents. Publishing or revoking updates/deletes the cached object; anonymous reads do not need PostgreSQL. This improves latency, makes 10,000 public views almost irrelevant to database awake time, and keeps revocation independent from private Location data.

### AWS and Aurora

Aurora Serverless v2 can set its minimum to 0 ACUs on supported PostgreSQL engine versions, pause after a configurable minimum of five idle minutes, and stop compute billing while paused. A resume typically takes approximately 15 seconds and can take 30 seconds or more after more than 24 hours paused. [Aurora auto-pause documentation](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)

AWS's US East pricing example uses $0.12/ACU-hour for Aurora Standard. At the 0.5-ACU active minimum, an always-awake writer costs approximately `0.5 × 730 × $0.12 = $43.80/month`. Every wake also creates at least five minutes in which the next query prevents pausing. The request envelope alone does not predict cost: 10,000 reads clustered behind cache can cost pennies, while the same reads spaced throughout the month can keep compute active. [Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/)

Aurora Standard storage is shown at $0.10/GB-month and I/O at $0.20/million operations in AWS's US East example. Data API has no minimum and is $0.35/million 32 KB request units, with one million requests/month free only for the first year; it additionally requires a Secrets Manager secret. Automated backup storage up to the current cluster size is free. [Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/)

The rest of the previously researched AWS stack remains inexpensive at this load: CloudFront/S3 for SPA and public snapshots, Lambda/API Gateway, Cognito Essentials, SES shared sending, EventBridge Scheduler, SQS, and bounded CloudWatch logs. Cognito Essentials includes the first 10,000 direct/social MAU and supports passwordless email through separately billed SES. [Cognito pricing](https://aws.amazon.com/cognito/pricing/)

The AWS candidate must use an object/edge projection for public Deck snapshots, a non-VPC Lambda calling Data API, Aurora Standard rather than I/O-Optimized at this low-I/O load, minimum 0 ACU, a five-minute pause timeout, and no reader instance. An alert should fire well before 100 Aurora ACU-hours/month; at $0.12/ACU-hour, that is $12 in database compute before other charges.

## Authentication and email

For provider neutrality, use a narrow authentication adapter whose application identity is an opaque internal user ID. **Better Auth** supports PostgreSQL through its Drizzle adapter and provides an email-OTP plugin with configurable expiry, attempt limits, and OTP storage. This avoids binding the domain model to Cognito or Neon Auth. [Better Auth PostgreSQL adapter](https://better-auth.com/docs/adapters/drizzle), [Better Auth email OTP](https://better-auth.com/docs/plugins/email-otp)

On Cloudflare/Neon, use Better Auth with a replaceable transactional-email adapter. Resend Free includes 3,000 transactional emails/month but imposes a 100-email/day limit; this fits the assumed 1,000/month only when login traffic is not sharply concentrated. Resend Pro starts at $20, so a production spike past the free daily limit would break the infrastructure budget. Rate-limit OTP requests by normalized email and IP, monitor daily sends, and retain the ability to substitute SES or another metered sender without changing auth behavior. [Resend pricing](https://resend.com/docs/knowledge-base/what-is-resend-pricing)

Neon Auth is included up to 60,000 MAU on Free and 1 million MAU on Launch and is based on Better Auth, but using the independently configured Better Auth layer makes email-OTP behavior explicit and easier to move. Neon Auth can remain a later simplification after confirming that its managed configuration exposes all required OTP/rate-limit controls. [Neon pricing](https://neon.com/pricing), [Neon Auth architecture](https://neon.com/docs/changelog/2025-12-12)

On AWS, keep Cognito Essentials and SES because they already meet the requirement and are inexpensive at 200 MAU. The application adapter must map the Cognito subject to the same opaque internal user ID used by the non-AWS implementation.

## Unrestricted atomic bulk transfer

PostgreSQL removes DynamoDB's 100-action transaction limit, but no HTTP/database system is literally unbounded in payload size or execution time. Interpret the requirement as **no product-level limit on selected Card Editions**, with all inventory mutations in one database transaction.

Use this provider-independent flow:

1. Create an idempotent bulk-transfer draft owned by the authenticated user.
2. Upload selected Card Edition IDs and quantities into staging rows in as many bounded requests as necessary. Uploading the manifest does not alter Holdings.
3. On confirmation, begin one PostgreSQL transaction. Lock the source/destination Location and affected Holding rows in stable order, validate ownership, leaf rules, versions, and every requested balance, then apply the source decrements and destination increments with set-based statements.
4. Mark the transfer committed with its idempotency key and commit. Any validation or write failure rolls back every Holding mutation and returns row-level conflicts. Expired uncommitted drafts are removed asynchronously.

This keeps a million-line manifest out of a single HTTP request while preserving one atomic transaction for the actual move. It works through a normal PostgreSQL connection or the RDS Data API. The Data API transaction may run for up to 24 hours but rolls back after three minutes without a call; its statement call defaults to a 45-second timeout and result sets are capped at 1 MiB, so conflict results must be paged and long set-based work must be designed/tested rather than issuing one API call per Holding. [Data API transaction rules](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_BeginTransaction.html), [Data API timeout behavior](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api-timeouts.html), [Data API limitations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.limitations.html)

For Cloudflare, paid HTTP invocations allow up to five minutes of CPU time and no hard wall-time limit while the client remains connected; Queue/Cron consumers have a 15-minute wall-time limit. The confirmation transaction should normally be a short, set-based database operation. A pathological transfer that exceeds platform or database safety timeouts may fail and retry safely, but it must never partially mutate inventory. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)

## Background synchronization, caching, and observability

- **Cloudflare candidate:** a Cron Trigger creates a catalog generation and queues bounded fetch/import work. Queue consumers support 15 minutes wall time, retries, dead-letter handling, and batch processing. Promote the generation only after all partitions succeed. Store only card metadata/search fields and provider image URLs in PostgreSQL; do not copy images. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- **AWS candidate:** retain EventBridge Scheduler, SQS/DLQ, and Lambda generation promotion from the existing plan, replacing DynamoDB writes with PostgreSQL staging and a final generation switch.
- **Public pages:** materialize sanitized Published Deck JSON/HTML in Cloudflare Cache/R2 or S3/CloudFront. Use an unguessable token, immutable versioned objects, and an owner-controlled pointer or deletion for republish/revoke. Never cache private Deck/Location responses publicly.
- **Logs:** emit compact structured operational events without card payloads, OTPs, email addresses, tokens, or Location names. Cloudflare Workers Paid includes seven-day Workers Logs; Neon Launch includes three days of database metrics/logs, Neon Free one day. Longer retention would require an external sink and a new cost decision. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Neon pricing](https://neon.com/pricing)

## Excluded configurations

- **Cloudflare D1:** SQLite rather than PostgreSQL-compatible and therefore outside the decided relational requirement. Cloudflare Workers may instead reach PostgreSQL through its driver or Hyperdrive; Hyperdrive uses transaction-mode pooling and supports a connection for the duration of a transaction. [Hyperdrive architecture](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)
- **Supabase Free as production:** lacks automatic backups. Supabase Pro is viable but starts at $25/month, while optional seven-day PITR is approximately $100/month. [Supabase pricing](https://supabase.com/pricing), [Supabase backups](https://supabase.com/docs/guides/platform/backups)
- **Fly.io Managed Postgres:** Basic is $38/month plus $0.28/GB storage. Fly's inexpensive self-managed Postgres is explicitly unsupported and transfers database operations to the project. [Fly Managed Postgres](https://fly.io/docs/mpg/), [Fly resource pricing](https://fly.io/docs/about/pricing/)
- **Render Free PostgreSQL:** expires after 30 days and has no backups. Paid resources are technically suitable but not a credible sub-$10 app/database/job package. [Render free services](https://render.com/docs/free), [Render PostgreSQL backups](https://render.com/docs/postgresql-backups)
- **Vercel Hobby for a general release:** restricted to personal, non-commercial use; Vercel Pro starts at $20. [Vercel Hobby terms and limits](https://vercel.com/docs/plans/hobby), [Vercel pricing](https://vercel.com/pricing)
- **Ordinary always-on RDS PostgreSQL or Lightsail managed database:** fixed monthly compute exceeds the target before application services and offers no advantage over the shortlisted serverless PostgreSQL products at this load.

## Decision inputs still requiring measurement

Before locking the host, run one disposable cost/feasibility prototype against both shortlisted candidates using the same schema and repository tests:

1. Import the full English/Japanese catalog, build production indexes, add 25,000 representative Holdings, and record database plus history/WAL bytes. Neon Free is disqualified if the complete fixture cannot stay comfortably below 0.5 GB; target at most 70% utilization to leave migration and temporary-index headroom.
2. Replay a month-shaped trace for 200 MAU and 10,000 public views, with public snapshots edge-cached, and record Neon CU-hours versus Aurora ACU-hours/wake count. Do not extrapolate solely from request counts.
3. Execute atomic transfer fixtures at 40, 1,000, 10,000, and 25,000 selected Card Editions. Verify all-or-nothing behavior, idempotent retry, stale-row conflict reporting, lock duration, and platform timeout margins.
4. Run a complete catalog generation through the queue/scheduler path, including partial failure, retry, dead letter, and generation promotion; record CPU, duration, database awake time, egress, and log volume.
5. Exercise passwordless sign-in bursts and provider failure. Confirm the 100-email/day Resend Free limit is acceptable or replace it with a metered sender before deployment.

Select **Cloudflare Workers + Neon** if the fixture fits the chosen Neon capacity and projected total remains below $8/month, leaving a $2 safety margin. Select **AWS + Aurora** if its monthly trace remains below roughly 60 ACU-hours and AWS operational consistency is worth the higher infrastructure complexity. If neither clears the safety margin, raise the production budget to **$25/month** and select Supabase Pro or Neon Launch based on the team's preference for integrated features versus provider-neutral application services; do not weaken backups or inventory atomicity to preserve an arbitrary hosting ceiling.

## Resolution

The best current route is **provider-neutral TypeScript + PostgreSQL**, with **Cloudflare Workers Paid + Neon** as the preferred non-AWS MVP candidate and **AWS serverless + Aurora PostgreSQL Serverless v2/Data API** as the AWS candidate. Both satisfy unrestricted atomic inventory transfers through a staging-manifest plus one set-based PostgreSQL transaction. Neither can be certified below $10 from user counts alone: the decision is gated by measured catalog size and database awake time. Public Published Decks must be edge/object projections in either architecture.

Cloudflare/Neon has the lower fixed platform floor and simpler operations. Aurora has stronger AWS-native integration and recovery but carries a severe cost/latency penalty if reads prevent auto-pause. Supabase Pro is the default fallback when reliable production backups matter more than the sub-$10 ceiling.
