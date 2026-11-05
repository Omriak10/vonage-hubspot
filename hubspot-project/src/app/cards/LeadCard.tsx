import {
  Alert, Button, ButtonRow, Flex, Input, LoadingButton, Select, Text, TextArea, hubspot,
} from '@hubspot/ui-extensions';
import { useEffect, useState } from 'react';
import type { CrmContext } from '@hubspot/ui-extensions';

const MW = 'https://YOUR-BACKEND-HOST';

hubspot.extend<'crm.preview'>(({ context }: { context: CrmContext }) => <LeadCard context={context} />);

type Channel = 'whatsapp' | 'rcs' | 'sms';
interface WaTpl { name: string; language: string; status: string; category: string; bodyText: string; varCount: number; headerFormat: string; hasMediaHeader: boolean }

// Compact send + call card shown in the Lead preview panel.
const LeadCard = ({ context }: { context: CrmContext }) => {
  const portalId = context.portal?.id;
  const objectId = context.crm?.objectId;
  const objectTypeId = context.crm?.objectTypeId;
  const [contactId, setContactId] = useState<string | number | undefined>(undefined);
  const [name, setName] = useState('');
  const [to, setTo] = useState('');
  const [channel, setChannel] = useState<Channel>('whatsapp');
  const [text, setText] = useState('');
  const [waTpls, setWaTpls] = useState<WaTpl[]>([]);
  const [waName, setWaName] = useState('');
  const [waParams, setWaParams] = useState<string[]>([]);
  const [busy, setBusy] = useState<'' | 'send' | 'call'>('');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const firstName = name.split(' ')[0];
  const waSel = waTpls.find((t) => t.name === waName);

  useEffect(() => {
    hubspot
      .fetch(`${MW}/2v/api/hs/resolve?portalId=${portalId}&objectType=${objectTypeId}&objectId=${objectId}`, { method: 'GET' })
      .then((r) => r.json())
      .then((d) => { setTo(d.phone || ''); setName(d.name || ''); setContactId(d.contactId); })
      .catch(() => {});
  }, []);

  // Load real approved WhatsApp templates when the WhatsApp channel is active.
  useEffect(() => {
    setWaName(''); setWaParams([]);
    if (channel !== 'whatsapp') { setWaTpls([]); return; }
    hubspot.fetch(`${MW}/2v/api/wa/templates?portalId=${portalId}`, { method: 'GET' })
      .then((r) => r.json()).then((d) => setWaTpls(d.templates || [])).catch(() => setWaTpls([]));
  }, [channel]);

  const applyWa = (n: string) => {
    setWaName(n);
    const t = waTpls.find((x) => x.name === n);
    setWaParams(t ? new Array(t.varCount).fill('').map((_, i) => (i === 0 ? firstName || '' : '')) : []);
  };
  const setParam = (i: number, v: string) => setWaParams((p) => { const n = [...p]; n[i] = v; return n; });

  const send = async () => {
    setResult(null);
    if (!to.trim()) { setResult({ ok: false, msg: 'Add a number first.' }); return; }
    if (channel === 'whatsapp' && waSel) {
      if (waSel.varCount > 0 && waParams.some((p) => !p.trim())) { setResult({ ok: false, msg: `Fill all ${waSel.varCount} variable(s).` }); return; }
      setBusy('send');
      try {
        const res = await hubspot.fetch(`${MW}/2v/api/wa/send-template`, { method: 'POST', body: { portalId, contactId, to, name: waSel.name, language: waSel.language, bodyParams: waSel.varCount > 0 ? waParams : [] } });
        const b = await res.json();
        if (res.ok && b.ok) setResult({ ok: true, msg: `WhatsApp template "${waSel.name}" sent.` });
        else setResult({ ok: false, msg: `Could not send: ${b?.body?.title || b?.error || res.status}` });
      } catch (e) { setResult({ ok: false, msg: 'Service unreachable.' }); } finally { setBusy(''); }
      return;
    }
    if (!text.trim()) { setResult({ ok: false, msg: 'Pick a template or type a message.' }); return; }
    setBusy('send');
    try {
      const res = await hubspot.fetch(`${MW}/2v/api/send`, { method: 'POST', body: { portalId, contactId, channel, to, text } });
      const b = await res.json();
      if (res.ok && b.ok) { setResult({ ok: true, msg: `${channel.toUpperCase()} sent and logged.` }); setText(''); }
      else setResult({ ok: false, msg: `Could not send: ${b?.body?.title || b?.error || res.status}` });
    } catch (e) { setResult({ ok: false, msg: 'Service unreachable.' }); } finally { setBusy(''); }
  };
  const call = async () => {
    setResult(null);
    if (!to.trim()) { setResult({ ok: false, msg: 'Add a number to call.' }); return; }
    setBusy('call');
    try {
      const res = await hubspot.fetch(`${MW}/2v/api/call`, { method: 'POST', body: { portalId, contactId, to } });
      const b = await res.json();
      setResult(res.ok && b.ok ? { ok: true, msg: `Calling ${to}.` } : { ok: false, msg: `Could not call: ${b?.body?.title || b?.error || res.status}` });
    } catch (e) { setResult({ ok: false, msg: 'Service unreachable.' }); } finally { setBusy(''); }
  };

  return (
    <Flex direction="column" gap="small">
      <Text variant="microcopy">{name ? `Message ${name}` : 'Message this lead'} via Vonage - logged to the timeline.</Text>
      <Select name="channel" value={channel} onChange={(v) => setChannel(v as Channel)}
        options={[{ label: 'WhatsApp', value: 'whatsapp' }, { label: 'RCS', value: 'rcs' }, { label: 'SMS', value: 'sms' }]} />
      {channel === 'whatsapp' && (
        <Select name="watpl" value={waName} placeholder={waTpls.length ? 'Free text (24h window only)' : 'Loading templates…'}
          onChange={(v) => applyWa(v as string)} options={waTpls.map((t) => ({ label: `${t.name} (${t.language})`, value: t.name }))} />
      )}
      <Input name="to" value={to} onInput={setTo} placeholder="+447700900000" />
      {channel === 'whatsapp' && waSel ? (
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">{waSel.bodyText || '(no body text)'}</Text>
          {waSel.varCount > 0 && new Array(waSel.varCount).fill(0).map((_, i) => (
            <Input key={i} label={`Variable {{${i + 1}}}`} name={`p${i}`} value={waParams[i] || ''} onInput={(v) => setParam(i, v)} placeholder={i === 0 ? firstName || 'value' : 'value'} />
          ))}
        </Flex>
      ) : (
        <TextArea name="text" value={text} onInput={setText} rows={3} placeholder="Type your message…" />
      )}
      {result && <Alert title={result.ok ? 'Done' : 'Heads up'} variant={result.ok ? 'success' : 'danger'}>{result.msg}</Alert>}
      <ButtonRow>
        {busy === 'send' ? <LoadingButton loading>Sending…</LoadingButton> : <Button variant="primary" onClick={send}>Send</Button>}
        {busy === 'call' ? <LoadingButton loading>Calling…</LoadingButton> : <Button onClick={call}>Call</Button>}
      </ButtonRow>
    </Flex>
  );
};
