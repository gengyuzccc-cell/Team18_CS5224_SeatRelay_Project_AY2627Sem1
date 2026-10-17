# AWS account setup for the team (day 0)

> 团队摘要：一位组员用 AWS 账号（root 或已有管理员）做四件事：(1) 建 IAM 用户 `seatrelay-deployer`（项目期内 AdministratorAccess）并生成 access key；(2) 开启 Cost Explorer；(3) 激活成本分配标签 `Project`；(4) 把 key 放进云端构建环境的 **环境设置（secrets）** 里，变量名 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_DEFAULT_REGION=ap-southeast-1`。**key 绝不粘贴到聊天、Telegram、仓库或任何文档。** 验证命令 `aws sts get-caller-identity`。项目结束（11/13 teardown 后）停用 key 并删除用户。

Plan reference: `docs/plan/execution-plan.md` §2.4 (cost allocation tag, budgets), §2.8 (credentials are entered only by a team member, never via chat), §8 (10/14 deadline). Related: `docs/RUNBOOK.md` §0–§1, `tools/scripts/bin/activate-cost-tags.sh`, `docs/deployment-state.md` (current state: account `379549361891`, user `seatrelay-deployer` exists).

If a step is already done (see `docs/deployment-state.md`), skip it; never create a second IAM user or a third access key.

## A. Root account hygiene (5 min, once)

1. Sign in as root → account menu → **Security credentials** → enable **MFA** on the root user (authenticator app).
2. Do **not** create root access keys. Everything below runs under the IAM user.
3. Billing → **Billing preferences** → turn on "Receive AWS Free Tier alerts" and "Receive CloudWatch billing alerts" (the stack's own budgets are created by `seatrelay-auth`, plan §2.4).

## B. Create the IAM user `seatrelay-deployer` (5 min)

1. IAM → Users → **Create user** → name `seatrelay-deployer`.
2. "Provide user access to the AWS Management Console": **yes** (console access is useful for SES, Cost Explorer and debugging); choose "I want to create an IAM user", set a password, untick "must create a new password at next sign-in" only if the whole team shares it (prefer one named console user per member in that case).
3. Permissions → **Attach policies directly** → `AdministratorAccess` → Create user. (Project-period choice, plan §8; it is deleted at teardown.)
4. Optional but recommended: Users → `seatrelay-deployer` → Security credentials → **Assign MFA device** for console sign-in.

## C. Create an access key for the CLI / cloud build (3 min)

1. IAM → Users → `seatrelay-deployer` → **Security credentials** → Access keys → **Create access key**.
2. Use case **Command Line Interface (CLI)** → tick the confirmation → Next → description `seatrelay cloud build` → Create.
3. Download the `.csv` **once** and store it in the team password manager (or the creator's private password manager). The secret is shown only here.
4. Rules: at most **two** active keys exist per user; never paste a key into chat, Telegram, WhatsApp, a shared doc, a commit, a screenshot or an issue; never put it in a file inside the repository (`.gitignore` already excludes `.env*`; check with `git status` before committing anything).

## D. Enable Cost Explorer (2 min, 24 h latency)

1. Billing and Cost Management → **Cost Explorer** → **Launch Cost Explorer** (or "Enable").
2. Data appears within 24 h. `tools/scripts/bin/cost-snapshot.sh` and the budgets rely on it (plan §3 step 24).

## E. Activate the cost allocation tag `Project` (2 min, up to 24 h latency)

Console: Billing and Cost Management → **Cost allocation tags** → *User-defined cost allocation tags* → select `Project` → **Activate**.
The tag only appears in that list after at least one tagged resource exists (deploy `seatrelay-auth` first; all stacks tag everything `Project=SeatRelay`).

CLI alternative (same effect) once the key works:

```bash
tools/scripts/bin/activate-cost-tags.sh
# = aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Project,Status=Active
```

Check the next day: Cost Explorer → Group by → Tag → `Project`.

## F. Give the cloud build session the keys (3 min)

The build session reads standard AWS environment variables. Add them as **secrets of the cloud environment**, never in the chat:

1. In the cloud session, open the **cloud environment menu in the session's title bar** → **Edit** the environment.
2. Under **Network secrets** (labelled **API credentials** in older app versions); if that section is not offered, use the environment's **Environment variables** section. Add three entries:

| Name | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | the key ID from step C (starts with `AKIA`) |
| `AWS_SECRET_ACCESS_KEY` | the secret from step C |
| `AWS_DEFAULT_REGION` | `ap-southeast-1` |

3. Save. **Start a new session** (an already-running session does not see new secrets).
4. In the new session, say only that the three variables are set. The values are never typed into the chat and are never requested there (plan §2.8).

Laptop alternative (for `sam deploy` from your own machine): `aws configure` → paste key ID, secret, region `ap-southeast-1`, output `json`; the credentials land in `~/.aws/credentials` (Windows: `%USERPROFILE%\.aws\credentials`), which is outside the repository.

## G. Verify (1 min)

```bash
aws sts get-caller-identity
```

Expected:

```json
{
    "UserId": "AIDA...",
    "Account": "379549361891",
    "Arn": "arn:aws:iam::379549361891:user/seatrelay-deployer"
}
```

Also `aws configure list` should show `region ap-southeast-1` with source `env` (cloud) or `config-file` (laptop). If you see `InvalidClientTokenId`, the key was copied with a stray space or is inactive; `AccessDenied` on a later command means the policy is missing (step B3).

## H. Rotation, leaks, teardown

- **Leak** (key seen in a chat, screenshot, commit): IAM → Users → `seatrelay-deployer` → Access keys → **Deactivate** immediately, create a new key (step C), update the environment secrets (step F), then **Delete** the old key; check CloudTrail → Event history for the last 24 h and `docs/deployment-state.md` budgets. If the leak was in a git commit, the commit must be rewritten before pushing; a pushed secret is treated as public.
- **Rotation**: once at the end of the project; no scheduled rotation is required for a 4-week project.
- **Teardown (after 11/13 and after the grade is released)**: `tools/scripts/bin/teardown.sh` for dev/pilot (keep `seatrelay-auth`, plan §3 step 29), then deactivate and delete the access key, remove the environment secrets, delete the IAM user, confirm Budgets and Cost Explorer show no further spend.

## I. Checklist (owner, date)

| # | Step | Owner | Done on |
|---|---|---|---|
| A | Root MFA on; no root keys | | |
| B | IAM user `seatrelay-deployer` with AdministratorAccess | | 2026-10-16 (see `deployment-state.md`) |
| C | One access key, stored in password manager | | |
| D | Cost Explorer enabled | | |
| E | Cost allocation tag `Project` activated | | 2026-10-16 requested |
| F | Three environment secrets set in the cloud environment; new session started | | |
| G | `aws sts get-caller-identity` shows the user ARN | | |
| H | Teardown date agreed | | |
