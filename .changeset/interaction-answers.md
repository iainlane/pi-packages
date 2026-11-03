---
'@mzwing/pi-permission-auto-review': minor
---

The `codex` preset recognises completed `ask_user` answers from pi-ask-user, single and batched, and `submit_plan` approvals from the planning extension, alongside `ask_user_question` and `plan_mode_question`. Only the answer is trusted: the reviewer receives the questions and options, or the approved plan, as an untrusted record kept with the answer. A question and answer larger than 900 tokens are left out together, and the transcript says so.
