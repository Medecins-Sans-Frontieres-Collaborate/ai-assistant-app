/**
 * "Meeting follow-through" — the worked example from
 * docs/M365_SIXTH_PASS_CROSS_SERVICE_WORKFLOWS.md.
 *
 * The prompt is written as the USER's message (it lands in the composer,
 * editable, and the user presses send themselves), so it addresses the
 * assistant in the second person. It must echo — never contradict —
 * M365_CHAIN_INSTRUCTIONS in lib/services/m365/tools/toolCatalog.ts: read
 * first, stage the writes, surface every ambiguity, name the provenance.
 *
 * Stage 1 is deliberately sized to fit inside the tool-round budget
 * (MAX_TOOL_ROUNDS); the pause at the proposal is the designed shape of the
 * chain, not a truncation.
 */
export const MEETING_FOLLOW_THROUGH_PROMPT = `Run the "meeting follow-through" playbook on the meeting transcript in this conversation.

Work in two stages and stop between them.

STAGE 1 — understand and propose (READ-ONLY: do not create, send, schedule or change anything in this stage):
1. Read the transcript already in this conversation. It is the primary source; do not go looking for another one.
2. Use calendar_list_events around the meeting's time to find the calendar event and its attendee list (match on subject or join URL). If you cannot identify the event with confidence, say so and continue from the transcript alone rather than guessing which meeting it was.
3. From the transcript, produce:
   - a short summary of what the meeting was about;
   - the decisions that were actually made;
   - action items, each with an owner;
   - open questions: unresolved disagreements, "let's pick this up next time" moments, and any action item that ended up with no owner.
4. Resolve owner names with person_resolve, checking the calendar attendee list first and the wider directory only after that. person_resolve returns ranked candidates — present them, never silently pick one.
5. Only if the open questions genuinely warrant another meeting, use calendar_get_schedule to find slots that work for the people who would need to be there. If there is no common slot, say there is no common slot; do not offer the least-bad one as if it worked.

Then stop and show me, in this order:
   a. the summary, decisions and action items;
   b. a proposal block containing: the full draft text of the follow-up email; the exact list of tasks you would create with their owners; and — only if step 5 found a reason — a recommended follow-up meeting with WHY it is needed, who should attend, and the free slots you found;
   c. an ambiguities list: every assumption you had to make, stated visibly ("two people named Chris attended; I assumed Chris Okonkwo because the action item mentions shipping — correct me if that's wrong"), every name you could not resolve, and anything the transcript left genuinely unclear. Ask outright where it matters. Guessing quietly is the one failure I care about.

Then WAIT for my answer. Do not run any write tool in stage 1. Pausing here is the point of the playbook, not a failure to finish.

STAGE 2 — execute (only after I say go, and only what I have agreed to):
- mail_create_reply_draft on the meeting's thread, or mail_create_draft to the attendees if there is no thread: the follow-up summary and action items. A draft — not a send.
- tasks_create for the action items I approved, as one batch.
- calendar_create_event ONLY if I picked a slot, with the agenda built from the open questions. Never schedule a slot I did not choose.

Every artifact you create names where it came from: put a "drafted from: transcript (meeting title, date) + thread (subject)" provenance line in the draft body and in each proposal, so I can check the basis before I approve it and answer "why was Ana invited?" afterwards.

If anything in stage 2 fails, tell me which parts landed and which did not — never report a write as done before its confirmation comes back.`;
