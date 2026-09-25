# Applyfy AWS Backend

A serverless AWS pipeline for resume upload and text extraction, built as an
infrastructure-as-code migration for [Applyfy](https://applyfy.net), an AI job
platform. Built with AWS CDK (TypeScript).

## Architecture

```
Client → API Gateway (/upload-url) → Lambda → pre-signed S3 URL
Client → PUT file directly to S3
S3 ObjectCreated → Lambda (ParseResume) → extracts text (PDF/DOCX) → DynamoDB
```

## Services used

- **API Gateway** — REST endpoints, WAF-protected
- **Lambda** (×3) — URL generation, resume parsing, hello-world
- **S3** — private bucket, versioned, CORS-enabled, UUID-prefixed keys
- **DynamoDB** — stores extracted resume text + metadata
- **WAF v2** — rate limiting (10 req/min/IP) on the upload endpoint
- **CDK** — full infrastructure as code

## Security

- Private S3 bucket (no public access), pre-signed PUT URLs (5-min expiry)
- UUID-prefixed object keys to prevent collisions
- Least-privilege IAM (scoped `grantPut`/`grantRead`, no wildcard permissions)
- WAF rate limiting to prevent endpoint abuse

## Load testing & findings

Tested at 50 concurrent requests. Initial results showed unexpected `500`
errors instead of clean `429` rate-limit responses. Root-caused using WAF
and Lambda CloudWatch logs to two independent throttling layers:

1. **WAF rate limiting** (10 req/min/IP) — evaluates on a rolling window,
   didn't catch the full burst since 50 requests arrived faster than WAF's
   evaluation cycle
2. **Lambda account concurrency limit** (10 simultaneous executions, an AWS
   account default) — this is what actually rejected the excess requests,
   surfaced by API Gateway as a generic `500`

**Result:** 45 req/sec sustained throughput, 1.9s average parsing latency,
100% success rate for requests within capacity.

## Tech

CDK, TypeScript, Node.js Lambda runtime, `unpdf` (PDF parsing), `mammoth`
(DOCX parsing), `@aws-sdk/client-s3`

## Useful commands

* `npm run build`   type-check the project
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emit the synthesized CloudFormation template
* `node load-test.js`  run a concurrent upload-url load test
