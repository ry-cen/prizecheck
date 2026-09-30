# Validate the sub-$10 AWS cost envelope

**Parent:** [Decision-complete Pokémon TCG Collection Tracker MVP](../map.md)

**Label:** wayfinder:research

**Status:** closed

**Assignee:** research_aws_cost

**Blocked by:** None — on the frontier.

**Research:** [AWS cost-envelope validation](../research/aws-cost-envelope.md)

**Resolution:** [Accept the AWS cost envelope with a relational qualification](../resolutions/02-validate-aws-cost-envelope.md)

## Question

Using current first-party AWS documentation and pricing, can the proposed CloudFront, S3, API Gateway HTTP API, Lambda, DynamoDB, Cognito email OTP, SES, EventBridge, SQS, CloudWatch, backup, and CI/CD topology remain below $10/month at idle while supporting the agreed load envelope, and which services or configurations create unavoidable monthly floors or material variable costs?
