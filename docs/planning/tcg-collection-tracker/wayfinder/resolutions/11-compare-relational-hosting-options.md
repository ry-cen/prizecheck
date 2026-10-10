# Resolution — Compare sub-$10 relational hosting options

**Historical comparison:** Provider selection is deferred by [ADR 0002](../../../../adr/0002-defer-deployment-provider-selection.md). The listed vendors remain researched candidates, not a current deployment commitment.

The research in [Relational hosting options](../research/relational-hosting-options.md) was reviewed and accepted. The user selected the cheapest viable path to get the MVP online immediately.

## Decision

Start on a zero-dollar launch topology before domain registration:

- Cloudflare Workers Free as the first tier to test for the Python/FastAPI API and internal TypeScript Better Auth service, with React/TypeScript/Vite as Cloudflare static assets. The later [runtime amendment](06-decide-aws-runtime-topology.md) records this language split.
- Neon Free for PostgreSQL.
- Better Auth with email OTP and a replaceable email adapter.
- Resend Free for initial transactional email.
- Cloudflare R2 within its free allowance for public Deck projections and bounded logical backups.
- GitHub Actions within included minutes for deployment, catalog synchronization, and backup jobs that do not fit comfortably inside free Worker execution limits.

Keep ordinary PostgreSQL migrations, opaque application user IDs, HTTP contracts, and adapters for authentication, email, jobs, object storage, and logs so the application can move to paid Neon, Aurora, or another PostgreSQL provider without rewriting domain behavior.

## Free-tier constraints

- Neon Free's 0.5 GB project storage is a hard feasibility gate. Measure the English catalog, indexes, auth data, and a 25,000-Holding fixture before launch.
- Neon compute, Cloudflare request/CPU/queue quotas, Resend's monthly and daily email caps, R2 operations/storage, and GitHub Actions minutes require monitoring and bounded work.
- Free-tier recovery and observability are limited. User data needs an application-managed logical backup process; catalog data is rebuilt from TCGdex.
- Public Deck views must use R2/edge projections rather than querying PostgreSQL on every anonymous request.
- Upgrade the constrained component when measured usage approaches 70% of its applicable quota. Do not weaken atomic inventory behavior or backups to remain free.

## Rejected for launch

- Aurora Serverless v2 remains a portable PostgreSQL destination but has less predictable awake-time cost and more infrastructure.
- Supabase Pro is the integrated fallback if the budget increases to at least $25/month.
- Vercel Hobby, Railway, Render, Fly managed PostgreSQL, ordinary RDS, and Lightsail do not provide a better general-purpose managed launch configuration at the selected budget.
