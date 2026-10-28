---
paths:
  - 'infra/**'
  - '.github/**'
  - '**/Dockerfile*'
  - 'docker-compose*.yml'
---

# Infrastructure and CI

- Server scripts run on Ubuntu. Write GNU-compatible bash with `set -euo pipefail`, and call out macOS (BSD) differences.
- No secrets in the repository, images, compose files, or CI logs. Production secrets live in the server's `.env` (mode 600).
- Containers run as a non-root user, with healthchecks and base images pinned to a major/minor tag.
- Pin GitHub Actions to their current major version, verified with `gh api repos/<owner>/<action>/releases/latest`.
- CI installs with `npm ci --ignore-scripts`. The security job (`npm audit`, registry signatures) must stay green; it also runs daily.
