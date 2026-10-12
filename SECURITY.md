# Security Policy

## Supported releases

Security fixes should target the latest supported release. If an older release is affected, maintainers will document whether a fix or workaround is available.

## Reporting a vulnerability

Please do **not** report exploitable details in a public issue or pull request.

Preferred path: use GitHub's **private vulnerability reporting** for this repository from the repository's Security tab. Repository owners should enable private vulnerability reporting before the public release. If that feature is unavailable, contact the maintainers privately through the contact method published on the repository owner's GitHub profile and ask for a secure reporting channel.

Include the affected version/commit, operating system, Node version, impact, minimal reproduction steps, and any relevant logs with secrets and personal transcript contents removed. Do not attach raw Antigravity transcript files unless the maintainer has agreed on a secure transfer method.

## Response expectations

Maintainers will make a reasonable effort to acknowledge reports within seven calendar days and provide a status update within fourteen calendar days. These are targets, not a guarantee; response time may vary based on severity and maintainer availability.

Please allow time for triage and a coordinated fix before public disclosure. The reporter and maintainers should agree on a disclosure date when practical.

## Security-sensitive areas

The project installs executable hooks, modifies user-level Antigravity configuration, provisions an external native binary, and inspects local transcripts. Reports involving unintended config replacement, code execution, path traversal, archive extraction, integrity verification, or transcript data exposure should identify the exact reproduction conditions whenever possible.
