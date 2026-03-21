# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x (latest) | ✅ |
| < 0.1.0 | ❌ |

## Reporting a Vulnerability

MemOS is a **local-first, privacy-first** project. We take security seriously.

If you discover a security vulnerability, **please do not open a public GitHub issue**.

Instead, please report it privately via one of these methods:

1. **GitHub Private Vulnerability Reporting** (preferred) 
   Go to [Security → Advisories](https://github.com/Markgatcha/memos/security/advisories/new) and click "Report a vulnerability"

2. **Email** 
   Send details to the repository maintainer via the email listed on their [GitHub profile](https://github.com/Markgatcha)

## What to Include in Your Report

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept if available)
- Affected version(s)
- Any suggested mitigation or fix

## Response Timeline

| Stage | Target Time |
|-------|-------------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix or mitigation | Within 30 days (depending on severity) |

## Security Design Notes

MemOS is designed with security in mind:

- **100% local** — no data ever leaves your machine by default
- **No telemetry** — zero phone-home functionality
- **No API keys required** for the core engine
- **SQLite storage** — stored in your user's local directory
- **MIT license** — full auditability of all code

If you believe there is a design-level security concern with the local storage or memory graph model, we welcome responsible disclosure.
