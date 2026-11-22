<system-reminder>
Plan mode turn ended without a required tool call.

Choose exactly one next action:
1. If a material boundary is still open (scope, compatibility, permissions, or acceptance), call `{{askToolName}}` with concrete choices and wait for the answer.
2. Otherwise, submit the decision-complete plan: write its slug/title (`<slug>`, matching `local://<slug>-plan.md`) as plain text to `xd://propose` with `{{writeToolName}}`.

Do not ask and propose in the same response. Do not return another prose-only reply.
</system-reminder>
