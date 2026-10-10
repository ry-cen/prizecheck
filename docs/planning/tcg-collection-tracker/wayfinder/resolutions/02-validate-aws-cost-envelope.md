# Resolution — Validate the sub-$10 AWS cost envelope

The research in [AWS cost-envelope validation](../research/aws-cost-envelope.md) was reviewed and accepted with a qualification caused by the later relational-database decision.

## Findings retained

- AWS's non-database serverless services have no material idle floor at the agreed load when configured conservatively. CloudFront/S3, HTTP API, Lambda, Cognito Essentials, SES shared sending, EventBridge Scheduler, SQS, bounded CloudWatch usage, and deployment infrastructure can remain comfortably within the sub-$10 target.
- The original DynamoDB topology was defensibly estimated at roughly $1.50–$3.00 per month for the bounded MVP assumptions.
- Aggregate storage, requests, email, and log volume must be capped and monitored. NAT gateways, paid CloudFront/WAF tiers, provisioned concurrency, customer-managed KMS keys, dedicated email infrastructure, and unbounded observability are explicit budget breakers.
- Public Deck snapshots should be edge/object projections so anonymous traffic does not repeatedly wake or query the private relational database.

## Qualification

DynamoDB is no longer the selected persistence model because its bounded transaction action count conflicts with unrestricted all-or-nothing bulk transfers. The DynamoDB estimate therefore does not validate the final application below $10.

AWS remains a relational candidate through Aurora PostgreSQL Serverless v2 with scale-to-zero. Its cost depends on measured awake time: an active 0.5-ACU minimum can exceed the entire budget when queries prevent auto-pause. The AWS relational topology is not certified below $10 until representative catalog, inventory, synchronization, and traffic fixtures measure Aurora wake behavior.

## Consequence

Carry the inexpensive AWS service choices and cost guardrails into the hosting decision, but decide the actual runtime only after comparing relational candidates. Do not describe AWS relational hosting as guaranteed below $10 from request counts alone.
