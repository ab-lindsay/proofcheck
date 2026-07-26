# Submission Checklist

Use this before submitting the take-home project.

## Pre-Submission Verification

### 1. Brief Scenarios (All Must Pass)

```bash
# Sarah's < 5s latency budget
pnpm check-latency --provider local-ocr --set real-world

# Jenny's exact warning + Dave's brand judgment
pnpm eval --provider mock | grep -E "title-case-warning|stones-throw"
```

### 2. Code Quality Gates

```bash
pnpm lint && pnpm typecheck && pnpm test
```

### 3. Deployed URL Smoke Test

Visit https://proofcheck-ttb.vercel.app - verify basic workflow works

### 4. Documentation Check

- README.md, REVIEWER_SUMMARY.md, .env.example exist and are current

## What to Submit

1. Repository URL (public or with reviewer access)
2. Deployed URL
3. Point to REVIEWER_SUMMARY.md
