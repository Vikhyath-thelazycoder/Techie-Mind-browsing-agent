# Multilingual

**Status:** Complete in Batch C (Phase 7). English, Hindi, Kannada, Tamil and Telugu work, in native
script and romanized, and so do code-switched requests. All of them resolve to the same structured
intent as English.

- **How:** `canonicalize` (`packages/agent-core/src/multilingual.ts`) rewrites command words, site
  names and grammar particles into the resolver's vocabulary. The words to search for are kept as
  written.
- **Language:** always detected from the user's original text. It is reported and used for spoken
  replies.
- **Security:** language never changes security policy. The rewritten request goes through the same
  router, firewall and verification.
- **Examples and voice:** see [VOICE.md](VOICE.md).

## References

- Spec §44–45
- Plan §38
