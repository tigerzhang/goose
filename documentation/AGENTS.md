# Documentation Style Guide

## Brand Guidelines

The product name is **OpenDuck**. Write it with that capitalization in current documentation.

- ✅ Correct: "OpenDuck", "using OpenDuck", "OpenDuck provides"
- ❌ Incorrect: "openduck" as the product name, "Open Duck"

The CLI binary is `openduck`. The legacy `goose` binary remains as an alias. Environment variables prefer `OPENDUCK_*`; matching `GOOSE_*` names are legacy aliases.

Do **not** rewrite historical blog posts. Those remain as published.

## Context

This rule applies to:
- Current markdown guides in `/docs/` (getting started, CLI, environment variables, and other how-to docs)
- README files
- Configuration files with user-facing text

When editing or creating **new** content in this documentation directory, use OpenDuck / `openduck`. Historical `/blog/` posts should keep their original Goose branding unless you are correcting a factual error about current install or CLI usage.
