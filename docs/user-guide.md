# User guide

Everything happens on the HubSpot contact record, in the **Vonage** tab, plus the app Settings page for admins. A hosted copy of this guide with step-by-step visuals is served by the backend at `/2v/guide`.

## The three cards on a contact

### Vonage Messaging - send to this contact

1. Pick a channel: **WhatsApp**, **RCS** or **SMS**. The recipient is the contact's mobile number (falls back to phone).
2. WhatsApp: the dropdown lists the **approved templates on your WhatsApp Business Account**, loaded live. Pick one, fill its variables (variable 1 is prefilled with the first name) and send. Free text is also possible, but only inside the 24-hour window that opens when the customer last wrote to you.
3. RCS and SMS: type and send. RCS falls back to nothing on non-RCS phones, so use SMS for unknown handsets.
4. **Call**: dials the contact immediately from your voice number. There is no confirmation step.

Every send is logged as a timeline note: `[WHATSAPP sent] ...`.

### Vonage Inbox - two-way conversations

A list of conversations, one per person, across all channels, with unread counts. Open a thread to read the history (both directions, media and button clicks included) and reply on the channel you prefer. WhatsApp replies outside the window must use a template; the picker is in the reply box. The list refreshes every 12 seconds.

Inbound messages are matched to a contact by phone number. A message from an unknown number still appears in the inbox and in the per-portal store; link it by creating the contact with that number.

### Vonage Templates & Campaigns - build, approve, send at scale

Three views:

- **Templates**: your tool-built templates (SMS text, RCS rich card or carousel, WhatsApp text, media or buttons) and every template that exists on your WhatsApp Business Account with its Meta status (approved, pending, rejected plus the reason). Row actions: *Send to this contact*, *Submit for approval*, *Delete from WhatsApp account*, *Remove from this list*.
- **Campaigns**: pick a HubSpot list, a template, map variables (`{{firstname}}`, `{{lastname}}`, `{{email}}`, `{{phone}}`, `{{company}}`), send to every member with a phone. Opted-out numbers are skipped.
- **Flows**: opens the flow builder (below).

## WhatsApp templates in two minutes

- Templates must be **approved by Meta** before they can be sent. Approval usually takes minutes, sometimes a day.
- **Category** matters: *Utility* for transactional (confirmations, reminders), *Marketing* for anything promotional, *Authentication* for codes. Meta recategorises or rejects mismatches.
- **Language**: pick the language the text is actually in. Polish text submitted as `en_US` is rejected; the tool switches Polish text to `pl` automatically.
- **Variables**: write `{{firstname}}`, `{{email}}` and so on. On submit they are renumbered to `{{1}}`, `{{2}}` in order of first appearance and example values are attached (Meta requires one example per variable). The body may not start or end with a variable. The header may contain at most one variable.
- Only contact properties are auto-filled at send time. A label like `{{Start Date}}` will be approved but you must pass its value (workflow action variable or campaign mapping).
- Names on Meta are lowercase with underscores (`spotk_kids`). You can type the display form (`Spotk Kids`) in a workflow action; the backend maps it.
- **STOP** footer: include "Reply STOP to unsubscribe" in marketing templates; the opt-out handler honours it.

The non-technical version of all this is in `docs/whatsapp-guide.html`.

## Flows

Open from the Templates card (*Flows* view) or directly at `https://<host>/2v/flows?portal=<portal id>`.

- **Trigger**: a keyword (exact or contains), any inbound message, or outbound (started by you, a list, or a workflow).
- **Steps**: each step sends a message (text with quick replies, a tool template, or an approved WhatsApp template) and then either continues, waits for a reply, jumps to another step or ends.
- **Rules** on a waiting step match the reply (equals, contains, regex, numeric index for SMS, any) and route to a step. A no-match rule can repeat the question, jump or end.
- **Actions**: add a timeline note, set a contact property, or **stop** (hand over to a human: automation ignores that number for 24 hours unless an exact keyword arrives).
- **Variables**: `{{firstname}}`, `{{lastname}}`, `{{name}}`, `{{phone}}`, `{{email}}`, `{{company}}`, `{{reply}}`.
- **Simulator**: the phone preview on the right runs the flow in memory, including unsaved drafts.
- **Senders**: choose the sender per flow; the *Senders* screen lists everything discovered on your Vonage account and lets you set defaults.
- Start a flow for the current contact from the card, for a list (*Start for list*), or from a workflow with the *Start Vonage flow* action.

Priority when a message arrives: exact keyword flow, then an open session waiting for a reply, then contains-keyword flows, then the catch-all.

## HubSpot workflow actions

In the workflow builder under *Vonage*:

| Action | Fields | Notes |
|---|---|---|
| Send SMS via Vonage | message | Supports HubSpot personalisation tokens. |
| Send RCS via Vonage | message | Sent as RCS text from the portal's RCS sender. |
| Send WhatsApp template via Vonage | templateName, language, var1, var2, var3 | Template must be approved. Variables are placed header-first then body, in the order Meta approved. |
| Start Vonage flow | flow (name or id) | Starts the flow for the enrolled contact. |

They run on contact workflows and on deal, company, ticket, meeting and custom-object workflows: the backend resolves the first associated contact with a phone number. Custom objects need the optional `crm.objects.custom.read` scope.

Result codes (visible in the workflow's action log):

- `SUCCESS` with `status: sent` - Vonage accepted the message.
- `FAIL_PERMANENT` with one of: `no_phone_on_contact`, `vonage_not_configured`, `template_name_required`, `template_not_found` (lists the approved names), `template_not_approved`, `template_variable_mismatch`, `template_variable_empty`, `message_required`, `recipient_opted_out`, or the Vonage 4xx detail. HubSpot does not retry these.
- HTTP 502 for transient Vonage errors - HubSpot retries.

## Opt-out

Inbound text or button in the stop list (stop, stop all, unsubscribe, unsub, cancel, end, quit, opt out, remove me, stop messages) marks the number opted out for that portal, confirms to the customer ("Reply START to opt back in"), notes the contact and sets `vonage_opted_out` if the portal has that property. Every send path - cards, campaigns, workflows, flows - refuses opted-out numbers. START, subscribe or opt in lifts it. Admins can review and remove entries via `/2v/api/optouts`.

## Logging

- Timeline notes: `[SMS sent]`, `[WHATSAPP received]`, `[WHATSAPP button clicked] "Yes"`, `[SMS sent by workflow] ...`, `[Opted out] ...`.
- Inbox store keeps the full thread per number.
- Backend logs: `[wf]`, `[status]`, `[tpl]`, `[flow]`, `[oauth]`, `[hschannel]`.

## Help Desk channel (beta)

The backend can register a HubSpot custom channel so WhatsApp conversations land in the HubSpot Help Desk and agents reply from there. It needs the three `conversations.*` scopes (ticked at install, Enterprise tiers), one-time channel registration by the app owner, and then `POST /2v/api/hschannel/connect {portalId}`. Not yet exercised end to end.
