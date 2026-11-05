import {
  Alert,
  Button,
  ButtonRow,
  Divider,
  Flex,
  Heading,
  Input,
  LoadingButton,
  Select,
  Text,
  TextArea,
  hubspot,
} from '@hubspot/ui-extensions';
import { useEffect, useState } from 'react';
import type { CrmContext, ExtensionPointApiActions } from '@hubspot/ui-extensions';

const MW = 'https://YOUR-BACKEND-HOST';

const NOT_SET = 'Vonage is not connected yet. An admin can connect your Vonage account in HubSpot: Marketplace > Connected apps > My apps > Vonage Messaging > Settings.';
const niceErr = (d: unknown) => /not_configured|not configured/i.test(String(d)) ? NOT_SET : String(d);

interface CrmExtensionProps {
  context: CrmContext;
  actions: ExtensionPointApiActions<'crm.record.tab'>;
}

hubspot.extend<'crm.record.tab'>(({ context, actions }: CrmExtensionProps) => (
  <MessagingCard context={context} actions={actions} />
));

type Channel = 'whatsapp' | 'rcs' | 'sms';
interface Tpl { id: string; name: string; channel: Channel; body: string }
interface WaTpl { name: string; language: string; status: string; category: string; bodyText: string; varCount: number; headerFormat: string; hasMediaHeader: boolean }

const MessagingCard = ({ context, actions }: CrmExtensionProps) => {
  const [name, setName] = useState('');
  const [to, setTo] = useState('');
  const [channel, setChannel] = useState<Channel>('whatsapp');
  const [text, setText] = useState('');
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [tplId, setTplId] = useState('');
  // Real approved WhatsApp templates (live from the WABA)
  const [waTpls, setWaTpls] = useState<WaTpl[]>([]);
  const [waName, setWaName] = useState('');
  const [waParams, setWaParams] = useState<string[]>([]);
  const [busy, setBusy] = useState<'' | 'send' | 'call'>('');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const portalId = context.portal?.id;
  const objectId = context.crm?.objectId;
  const objectTypeId = context.crm?.objectTypeId;
  const [contactId, setContactId] = useState<string | number | undefined>(objectId);
  const firstName = name.split(' ')[0];
  const waSel = waTpls.find((t) => t.name === waName);

  // Resolve phone + name for a contact OR a lead (follows the lead -> contact association)
  useEffect(() => {
    hubspot
      .fetch(`${MW}/2v/api/hs/resolve?portalId=${portalId}&objectType=${objectTypeId}&objectId=${objectId}`, { method: 'GET' })
      .then((r) => r.json())
      .then((d) => { setTo(d.phone || ''); setName(d.name || ''); if (d.contactId) setContactId(d.contactId); })
      .catch(() => {});
  }, []);

  // Load templates when the channel changes: WhatsApp pulls the real approved
  // WABA templates; SMS/RCS use the templates saved in this tool.
  useEffect(() => {
    setTplId(''); setWaName(''); setWaParams([]);
    if (channel === 'whatsapp') {
      setTemplates([]);
      hubspot.fetch(`${MW}/2v/api/wa/templates?portalId=${portalId}`, { method: 'GET' })
        .then((r) => r.json())
        .then((d) => setWaTpls(d.templates || []))
        .catch(() => setWaTpls([]));
    } else {
      setWaTpls([]);
      hubspot.fetch(`${MW}/2v/api/templates?portalId=${portalId}&channel=${channel}`, { method: 'GET' })
        .then((r) => r.json())
        .then((d) => setTemplates(d.templates || []))
        .catch(() => setTemplates([]));
    }
  }, [channel, portalId]);

  const applyTemplate = (id: string) => {
    setTplId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setText((t.body || '').replace(/\{\{\s*firstname\s*\}\}/gi, firstName || ''));
  };
  const applyWaTemplate = (n: string) => {
    setWaName(n);
    const t = waTpls.find((x) => x.name === n);
    setWaParams(t ? new Array(t.varCount).fill('').map((_, i) => (i === 0 ? firstName || '' : '')) : []);
    if (t) setText(t.bodyText || '');
  };
  const setParam = (i: number, v: string) => setWaParams((p) => { const n = [...p]; n[i] = v; return n; });

  const send = async () => {
    setResult(null);
    if (!to.trim()) { setResult({ ok: false, msg: 'Add a recipient number first.' }); return; }
    // WhatsApp + a real approved template -> send by name (delivers outside the 24h window)
    if (channel === 'whatsapp' && waSel) {
      if (waSel.varCount > 0 && waParams.some((p) => !p.trim())) {
        setResult({ ok: false, msg: `Fill all ${waSel.varCount} template variable(s) first.` }); return;
      }
      setBusy('send');
      try {
        const res = await hubspot.fetch(`${MW}/2v/api/wa/send-template`, {
          method: 'POST',
          body: { portalId, contactId, to, name: waSel.name, language: waSel.language, bodyParams: waSel.varCount > 0 ? waParams : [] },
        });
        const body = await res.json();
        if (res.ok && body.ok) { setResult({ ok: true, msg: `WhatsApp template "${waSel.name}" sent and logged.` }); }
        else { const detail = body?.body?.title || body?.body?.detail || body?.error || `status ${res.status}`; setResult({ ok: false, msg: `Could not send: ${niceErr(detail)}` }); }
      } catch (e) { setResult({ ok: false, msg: 'Could not reach the messaging service.' }); } finally { setBusy(''); }
      return;
    }
    if (!text.trim()) { setResult({ ok: false, msg: 'Pick a template or type a message first.' }); return; }
    setBusy('send');
    try {
      const res = await hubspot.fetch(`${MW}/2v/api/send`, {
        method: 'POST',
        body: { portalId, contactId, channel, to, text },
      });
      const body = await res.json();
      if (res.ok && body.ok) {
        setResult({ ok: true, msg: `${channel.toUpperCase()} sent and logged to the timeline.` });
        setText('');
      } else {
        const detail = body?.body?.title || body?.body?.detail || body?.error || `status ${res.status}`;
        setResult({ ok: false, msg: `Could not send: ${niceErr(detail)}` });
      }
    } catch (e) {
      setResult({ ok: false, msg: 'Could not reach the messaging service.' });
    } finally {
      setBusy('');
    }
  };

  const call = async () => {
    setResult(null);
    if (!to.trim()) {
      setResult({ ok: false, msg: 'Add a number to call.' });
      return;
    }
    setBusy('call');
    try {
      const res = await hubspot.fetch(`${MW}/2v/api/call`, {
        method: 'POST',
        body: { portalId, contactId, to },
      });
      const body = await res.json();
      if (res.ok && body.ok) setResult({ ok: true, msg: `Calling ${to} - logged to the timeline.` });
      else {
        const detail = body?.body?.title || body?.body?.detail || body?.error || `status ${res.status}`;
        setResult({ ok: false, msg: `Could not start call: ${niceErr(detail)}` });
      }
    } catch (e) {
      setResult({ ok: false, msg: 'Could not reach the calling service.' });
    } finally {
      setBusy('');
    }
  };

  return (
    <Flex direction="column" gap="small">
      <Heading>Send a message</Heading>
      <Text variant="microcopy">
        {name ? `To ${name}` : 'Message this contact'} via Vonage. Replies are logged to the timeline.
      </Text>
      <Divider />

      <Select
        label="Channel"
        name="channel"
        value={channel}
        onChange={(v) => setChannel(v as Channel)}
        options={[
          { label: 'WhatsApp', value: 'whatsapp' },
          { label: 'RCS', value: 'rcs' },
          { label: 'SMS', value: 'sms' },
        ]}
      />

      {channel !== 'whatsapp' && templates.length > 0 && (
        <Select
          label="Use a template"
          name="template"
          value={tplId}
          placeholder="Start from scratch"
          onChange={(v) => applyTemplate(v as string)}
          options={templates.map((t) => ({ label: t.name, value: t.id }))}
        />
      )}

      {channel === 'whatsapp' && (
        <Select
          label={waTpls.length ? `Approved WhatsApp template (${waTpls.length})` : 'Approved WhatsApp template'}
          name="watemplate"
          value={waName}
          placeholder={waTpls.length ? 'Free text (24h window only)' : 'Loading your templates…'}
          onChange={(v) => applyWaTemplate(v as string)}
          options={waTpls.map((t) => ({ label: `${t.name} (${t.language})`, value: t.name }))}
        />
      )}

      <Input label="Recipient number" name="to" value={to} onInput={(v) => setTo(v)} placeholder="+447700900000" />

      {channel === 'whatsapp' && waSel ? (
        <Flex direction="column" gap="extra-small">
          {waSel.hasMediaHeader && (
            <Text variant="microcopy">This template has a {waSel.headerFormat.toLowerCase()} header set in WhatsApp Manager.</Text>
          )}
          <Text variant="microcopy" format={{ fontWeight: 'bold' }}>Preview</Text>
          <Text variant="microcopy">{waSel.bodyText || '(no body text)'}</Text>
          {waSel.varCount > 0 && new Array(waSel.varCount).fill(0).map((_, i) => (
            <Input key={i} label={`Variable {{${i + 1}}}`} name={`p${i}`} value={waParams[i] || ''} onInput={(v) => setParam(i, v)} placeholder={i === 0 ? firstName || 'value' : 'value'} />
          ))}
        </Flex>
      ) : (
        <TextArea label="Message" name="text" value={text} onInput={(v) => setText(v)} rows={4} placeholder="Type your message…" />
      )}

      {result && (
        <Alert title={result.ok ? 'Done' : 'Heads up'} variant={result.ok ? 'success' : 'danger'}>
          {result.msg}
        </Alert>
      )}

      <ButtonRow>
        {busy === 'send' ? (
          <LoadingButton loading>Sending…</LoadingButton>
        ) : (
          <Button variant="primary" onClick={send}>
            Send {channel.toUpperCase()}
          </Button>
        )}
        {busy === 'call' ? (
          <LoadingButton loading>Calling…</LoadingButton>
        ) : (
          <Button onClick={call}>Call</Button>
        )}
      </ButtonRow>
    </Flex>
  );
};
