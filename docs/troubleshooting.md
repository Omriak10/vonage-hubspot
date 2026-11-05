# Troubleshooting

Symptoms first, then causes we have actually hit, then the fix.

## Cards

**"Vonage is not connected yet"** - the portal has no Vonage credentials. An admin connects them at Marketplace > Connected apps > Vonage Messaging > Settings. There is no fallback account by design.

**"Could not reach the messaging service" on POST only, while lists load** - a UI-extension `hubspot.fetch` POST was given a string body. The body must be a plain object; HubSpot serialises it and strips every header except Authorization. The request never leaves the browser, so nothing appears in backend logs.

**Changes do not appear after `hs project upload`** - HubSpot caches the bundle. Wait a few minutes and open the record in a new tab. Ctrl+Shift+R on the old tab is often not enough.

**A card "jumps" up and down continuously** - a HubSpot Table cell containing wrapping text creates a resize loop in the remote iframe. Keep table cells to short tokens; put prose in a Text above the table. Also avoid replacing state arrays on every poll when nothing changed.

**Settings page not visible** - it is an app-level page, not a record card: Marketplace > Connected apps > My apps > Vonage Messaging > Settings.

## Sending

**Card says "sent", nothing arrives** - Vonage answers 202 before Meta or the carrier evaluates the message. Check the final status: the backend logs `[status] whatsapp <uuid> to=... rejected error=<code>`, or query the Vonage Reports API on the portal's own account for that `message_uuid`.

**WhatsApp error 1022 (invalid template or parameters)** - all of these have occurred:
- Template name typed differently from Meta's lowercase_underscore name. Now mapped automatically; an unknown name fails before sending with `template_not_found`.
- Language code the template was not approved in (for example `pl` typed for an `en_US` template). The backend now sends in the language the template exists in.
- Variable count different from the approved placeholders (a filled variable on a zero-placeholder template, or a missing one). Now `template_variable_mismatch` / `template_variable_empty` before sending.

**WhatsApp 401 on send** - the WhatsApp number is not linked to the Application ID entered in Settings. Link it in the Vonage dashboard or enter the application it is linked to. Listing templates works with any Messages-capable application on the owning account; sending does not.

**WhatsApp free text fails** - outside the 24-hour window. Use an approved template.

**RCS send "wrong credentials"** - the RCS agent is linked to a different Vonage application than the one in Settings.

**"Error 0" or empty template list** - the WhatsApp Business Account has zero templates. Create and submit one first.

**Recipient opted out (403)** - the number replied STOP earlier. Remove it with `POST /2v/api/optouts/remove` only if the customer has opted back in.

## WhatsApp template approval

**Rejected with no obvious reason** - read Meta's raw record: `GET /2v/api/admin/wa-template?portalId=&name=&adminKey=` returns components, status and rejection reason.

Common rejection causes, all handled by the submit path now: variables without examples; named variables (`{{Start Date}}`) sent as positional; body starting or ending with a variable; more than one header variable; Polish (or other non-English) text submitted as `en_US`; a name that already exists on the account in another language; double-encoded text (UTF-8 read as cp1252 - `imię` arriving as `imiÄ™`) from the card.

**Submit returns to draft** - the submit answered an error the card could not show. The card now surfaces `message`. No `[tpl] submit` line in the logs means the request was refused before reaching Meta.

**Status looks wrong** - the overlay keys WABA templates by name and language; an old rejected `en_US` version no longer hides the approved `pl` one.

## Workflow actions

**401 bad signature on every execution** - HubSpot signs workflow-action executions with signature version v2: `sha256(clientSecret + METHOD + full URL including query + rawBody)`. v3 (HMAC, timestamped) and v1 are also accepted. `BASE_URL` must be exactly the public URL HubSpot called.

**"This meeting has no associated contact"** - the object the workflow runs on has no associated contact with a phone number. For custom objects the portal must have granted `crm.objects.custom.read` (reinstall and tick the optional scope).

**Action does not appear in the workflow builder** - the component was not picked up. Workflow actions must be `type: "workflow-action"` in `src/app/workflow-actions/`; check the component count in the upload log.

## Inbound

**Replies do not reach the inbox** - the application's inbound webhook is not pointing at `.../2v/webhooks/inbound?portal=<id>`. Reconnect in Settings with auto-wire on, or set it manually. Inbound is routed to exactly one portal: the `portal` query tag first, then by matching the `to` sender against each portal's discovered senders.

**Wrong contact name on an inbound** - fixed: a matched contact must actually contain the inbound digits (last 8).

## Backend / VCR

**Deploy fails "credentials not found"** - the application in `vcr.yml` was created in the dashboard, not with `vcr app create` / `vcr app generate-keys`.

**Deploy fails on health** - `GET /_/health` must return 200 within the startup window. Ship `node_modules`.

**Lost updates in the inbox when two messages arrive together** - all inbox writes are serialised through an in-process lock; keep new state writes inside the same pattern.

**Text arrives with mojibake** - a middleware repairs cp1252 double-encoding on every `/2v/api` body when the UTF-8 re-read is clean. Keep it.

## Auth (401 unauthorised)

**A card gets 401 on every call** - the backend could not verify HubSpot's v3 signature. Causes: `HS_CLIENT_SECRET` does not match the app's current client secret; `BASE_URL` differs from the host HubSpot actually called (the signature covers the full URL, so a proxy that rewrites the path or query breaks it); `HS_APP_ID` set to a different app. Set `PORTAL_AUTH=log` to see `[auth] DENY ... why=` lines without blocking.

**The flow builder shows "This builder link has expired"** - the session token in the iframe URL is older than 12 hours or was minted for another portal. Close it and open Flows again from the card.

**`curl` to an API route returns 401** - expected. Add `&adminKey=<ADMIN_KEY>` for administrative checks.

## Security notes

- Rotate `ADMIN_KEY` and the HubSpot client secret if they were ever committed anywhere.
- Invite links are minted with the `ADMIN_KEY` only; an invite lets a portal install the app, nothing more.
- The hosted pages (`/2v/guide`, `/2v/install/:guid`, `/2v/flows`) are public HTML; all data they show comes through authenticated API calls.
