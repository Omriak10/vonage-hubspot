# HubSpot App Marketplace listing - Vonage Messaging
Everything needed to fill the listing form (App Marketplace > Create listing, dev account vonage-messaging / App ID <your app id>).

## Basics
- **App name:** Vonage Messaging
- **Tagline (short):** WhatsApp, RCS and SMS for HubSpot - send, receive and call from the contact record, on your own Vonage account.
- **Categories:** SMS & Messaging / Calling; secondary: Marketing, Customer Support
- **Languages:** English

## Short description (~150 chars)
Send WhatsApp, RCS and SMS, run list campaigns and make calls from any HubSpot record - two-way, logged to the timeline, on your own Vonage account.

## Full description
Turn every HubSpot contact record into a messaging workspace. Vonage Messaging adds four cards to your CRM:

- **Vonage Messaging** - send WhatsApp, RCS or SMS to the contact you are looking at. Pick an approved WhatsApp template (loaded live from your WABA) to reach customers outside the 24-hour window, or free-text inside it. Place a phone call with one click.
- **Vonage Inbox** - a unified, two-way inbox on the record. Every WhatsApp, RCS and SMS reply lands in one thread per person, across channels, with unread counts. Reply on whichever channel you like without leaving HubSpot.
- **Vonage Templates & Campaigns** - build reusable rich messages (RCS cards & carousels, WhatsApp buttons and media) and blast approved WhatsApp templates to any HubSpot list with per-contact personalisation.
- **Vonage Settings** - connect your own Vonage account in two minutes: API key, application, private key and your senders. We verify the credentials against the Vonage API and wire your inbound webhooks automatically.

Everything is logged to the contact timeline, so the whole team sees the conversation history.

**Bring your own Vonage account.** Messages and calls are sent exclusively through your own Vonage API account and your own numbers and senders - your traffic, your branding, your rates. Nothing is shared between customers, and inbound messages are routed only to your portal.

## Requirements section
- A Vonage API account (developer.vonage.com) with a Vonage Application (Messages + Voice)
- Your own senders: WhatsApp Business number and/or RCS agent and/or SMS sender, linked to that application
- HubSpot: contacts read/write, lists read, leads read (OAuth scopes shown at install)

## Pricing
- Listing model: **Free to install** (customers pay Vonage usage rates on their own account)

## URLs
- Setup / documentation: https://YOUR-BACKEND-HOST/2v/guide
- Support: https://YOUR-BACKEND-HOST/2v/guide
- Support email: support@example.com  (swap to a Vonage alias before official publication)
- Privacy policy: https://www.vonage.com/legal/privacy-policy/
- Terms of service: https://www.vonage.com/legal/

## Screenshots to capture (1280x800, PNG)
1. Vonage Messaging card on a contact - WhatsApp template picker open
2. Vonage Inbox - conversation list with unread badges + channel tags
3. Vonage Inbox - open thread showing WhatsApp + RCS in one conversation, reply box
4. Vonage Templates & Campaigns - RCS carousel builder
5. Vonage Settings - the connect-your-account form (verified state)
6. (Optional) the setup guide page

## Reviewer test instructions (for the review form)
1. Install the app via OAuth into a test portal.
2. Add the four Vonage cards to a contact record (Customize > Add card).
3. Open "Vonage Settings" and connect a Vonage API account (API key/secret, Application ID + private key, at least one sender). The app verifies credentials live against the Vonage API; wrong credentials are rejected.
4. Without connected credentials every send/call correctly refuses with "vonage_not_configured" - there is no shared account.
5. Send an SMS/WhatsApp from "Vonage Messaging"; reply from the handset and watch it land in "Vonage Inbox" and on the contact timeline.
- A demo video can be provided on request; a Vonage test account with senders can be arranged for review.

## Known gating items before submission
- HubSpot requires >= 3 active installs of the public app before a listing can be submitted.
- Vonage trademark: listing is prepared under the personal dev account; re-publish/transfer under an official Vonage developer account for the public launch (or obtain brand authorisation in the review).
- GDPR: contact privacy-deletion webhook implemented (scrubs inbox threads); uninstall purges tokens, credentials, inbox and templates for the portal.
