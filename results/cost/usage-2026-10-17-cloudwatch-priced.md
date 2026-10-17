# Measured usage priced (results/cost/usage-2026-10-17-cloudwatch.json)

List price: **US$3.25**; after free tier: **US$1.19**; after credits: US$0.00 while credits last.

| key | dimension | quantity | unit | unit_usd | free_allowance | list_usd | after_free_usd | verification |
|---|---|---|---|---|---|---|---|---|
| lambda_request_arm | Requests (arm64) | 324,222 | request | 2e-07 | 1,000,000 | 0.0648 | 0.0000 | verified_pricelist |
| lambda_gbs_arm | Duration (arm64), GB-seconds | 3,128 | GB-second | 1.33334e-05 | 400,000 | 0.0417 | 0.0000 | verified_pricelist |
| http_api_request | Requests | 218,167 | request | 1.25e-06 | 0 | 0.2727 | 0.2727 | verified_pricelist |
| data_transfer_out_gb | Data transfer out from ap-southeast-1 to the internet (API Gateway responses) | 0.3823 | GB | 0.12 | 100.00 | 0.0459 | 0.0000 | verified_pricelist |
| sqs_request_fifo | FIFO queue requests | 257,581 | request | 5e-07 | 257,581 | 0.1288 | 0.0000 | verified_pricelist |
| sqs_request_standard | Standard queue requests | 118,443 | request | 4e-07 | 118,443 | 0.0474 | 0.0000 | verified_pricelist |
| ddb_rru_ondemand | On-demand read request units | 513,724 | RRU | 1.425e-07 | 0 | 0.0732 | 0.0732 | verified_pricelist |
| ddb_wru_ondemand | On-demand write request units | 1,165,074 | WRU | 7.1e-07 | 0 | 0.8272 | 0.8272 | verified_pricelist |
| ddb_streams_rru | Streams read request units (GetRecords) | 0 | stream read request unit | 2.28e-07 | 2,500,000 | 0.0000 | 0.0000 | verified_pricelist |
| cw_logs_ingest_gb | Log data ingested (Standard log class) | 0.4768 | GB | 0.7 | 5.00 | 0.3338 | 0.0000 | verified_pricelist |
| eventbridge_scheduler_invocation | Scheduled invocations | 245.00 | invocation | 1.25e-06 | 14,000,000 | 0.0003 | 0.0000 | verified_pricelist |
| ses_email_essentials | Outbound e-mail, Essentials pricing plan | 126.00 | email | 0.00016 | 0 | 0.0202 | 0.0202 | verified_pricelist |
| cloudfront_https_request_asia | HTTPS requests, Asia Pacific edge locations | 157.00 | request | 1.2e-06 | 10,000,000 | 0.0002 | 0.0000 | verified_pricelist |
| cloudfront_dto_gb_asia | Data transfer out to internet, Asia Pacific edge locations | 0.002884 | GB | 0.12 | 1,024 | 0.0003 | 0.0000 | verified_pricelist |
| cognito_mau_essentials | Monthly active users, Essentials tier | 93.00 | MAU | 0.015 | 10,000 | 1.3950 | 0.0000 | verified_pricelist |
