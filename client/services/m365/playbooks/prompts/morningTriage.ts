/**
 * "Morning triage" — the tool-only counterpart to meeting follow-through
 * (docs/M365_SIXTH_PASS_CROSS_SERVICE_WORKFLOWS.md, catalog table).
 *
 * Same contract as the other playbook: a user-authored message, stage 1 pure
 * read, stage 2 only on agreement, ambiguity surfaced rather than absorbed,
 * provenance on every proposed artifact. Flagged mail is a pass-5 concern —
 * its body is withheld, so it is reported as a count and never used to seed a
 * draft.
 */
export const MORNING_TRIAGE_PROMPT = `Run the "morning triage" playbook.

Work in two stages and stop between them.

STAGE 1 — brief me (READ-ONLY: do not draft, send, create or schedule anything in this stage):
1. mail_digest over what arrived overnight.
2. mail_awaiting_my_reply for today — the messages where someone is waiting on me.
3. calendar_list_events for today.

Then give me ONE briefing, not three tool dumps:
   - What came in: the themes and the few messages that actually matter, with who sent them.
   - Waiting on you: what needs a reply and roughly how overdue it is. If any messages were flagged or withheld as suspicious, tell me how many and that they were held back — surface that count, never quietly drop it.
   - Today: the schedule, including the gaps I could actually use, and anything on it that the mail suggests I am not ready for.

Then, optionally, propose (do not execute):
   - tasks to create for the concrete asks people made of me;
   - nudge drafts for the replies that are overdue.
Show the full text of any draft you would create and the exact task list, each with a "drafted from:" provenance line naming the message or thread it came from.

Include an ambiguities list: anything you were unsure about — an ask you could not attribute to a person, a request that might already be handled, a meeting whose purpose is not clear — stated as a visible assumption or an outright question. Do not resolve an ambiguity silently.

Then WAIT. Do not run any write tool in stage 1. Ending at the proposal is the designed shape of this playbook.

STAGE 2 — execute (only after I say go, and only the items I agreed to):
- tasks_create as one batch for the tasks I kept;
- mail_create_reply_draft for the nudges I kept — drafts, never sends.

Never compose a reply from a message whose body was withheld, and tell me which writes landed rather than assuming they did.`;
