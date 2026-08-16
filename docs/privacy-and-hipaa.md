# Sea Shell privacy and HIPAA posture

## Current answer

Sea Shell is **not represented as HIPAA compliant or HIPAA certified today**.
HIPAA applies to a regulated organization's people, policies, contracts, and
technical environment—not to a source repository in isolation. A local-only
Sea Shell deployment is a useful privacy architecture, but it is not by itself
a compliance program.

The U.S. Department of Health and Human Services describes required
administrative, physical, and technical safeguards, including access control,
audit controls, integrity, authentication, and transmission security. It also
requires appropriate written business-associate arrangements when a service
provider handles protected health information:

- [HHS Security Rule overview](https://www.hhs.gov/hipaa/for-professionals/security/index.html)
- [HHS Security Rule summary and safeguards](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html)
- [HHS business-associate contract guidance](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html)

This document is an engineering posture, not legal advice or a certification.

## Current data boundaries

| Feature | Default boundary | Network behavior |
|---|---|---|
| File/live transcription | Local | None after local model installation |
| Durable mic/system capture | Local | None |
| Deterministic speaker identity | Local | None |
| pyannote diarization | Local inference | Hugging Face only for model acquisition unless preloaded/offline |
| Humain via Codex or Claude Code | Remote subscription service | Transcript and approved context leave the device |
| Humain via OpenRouter | Remote gateway/provider | Transcript and approved context leave the device |
| Cloud STT | Remote gateway/provider | Audio chunks leave the device only with explicit config consent |

New Sea Shell artifact files are written with per-user permissions. The
background watcher does not load Whisper while idle or during capture, does not
embed secrets in its LaunchAgent, and does not send data to Humain unless exact
meeting routes are configured. Context files are explicit and bounded.

OpenRouter Zero Data Retention routing is a privacy control, not a substitute
for a Business Associate Agreement. Do not send PHI through an OpenRouter route
unless the covered organization has independently verified an appropriate BAA
and eligible provider/endpoint terms. OpenRouter documents its current ZDR and
provider logging controls here:

- [OpenRouter Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)
- [OpenRouter provider logging controls](https://openrouter.ai/docs/guides/privacy/provider-logging/)

Some direct AI vendors offer BAAs for eligible business offerings—for example,
[OpenAI describes its healthcare BAA process](https://openai.com/enterprise-privacy/)—but
eligibility is account-, product-, endpoint-, and configuration-specific.

## Controls still needed for a regulated deployment

Before making a HIPAA claim, a deploying organization would need at least:

- a formal risk analysis and risk-management plan;
- authenticated identities, least-privilege roles, and access review;
- durable audit logs for viewing, exporting, changing, and deleting PHI;
- approved retention, deletion, backup, recovery, and legal-hold behavior;
- managed encryption and device security, including FileVault and screen lock;
- a complete vendor/subprocessor inventory and signed BAAs where required;
- documented workforce training, incident response, breach notification, and
  contingency procedures;
- recording consent and notice behavior appropriate to every jurisdiction;
- security testing, dependency response, and operational monitoring; and
- validation by qualified privacy/security counsel for the intended workflow.

## Sensible near-term product path

Keep the default local-only and add a separately testable regulated-deployment
profile: cloud routes disabled unless an administrator allow-lists a BAA-backed
endpoint; encrypted managed storage; organization identity and roles; audit and
retention policies; explicit recording notices; export/delete audit evidence;
and a deployer checklist. Until that profile and its operational controls are
validated, the accurate product language is “local-first with privacy-oriented
defaults,” not “HIPAA compliant.”
