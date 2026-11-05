import {
  Alert, Button, ButtonRow, Divider, Dropdown, Flex, Heading, Input, LoadingButton,
  Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, Text, TextArea, hubspot,
} from '@hubspot/ui-extensions';
import { useEffect, useState } from 'react';
import type { CrmContext, ExtensionPointApiActions } from '@hubspot/ui-extensions';

const MW = 'https://YOUR-BACKEND-HOST';
const api = (p: string, opts?: object) => hubspot.fetch(`${MW}${p}`, opts).then((r) => r.json());

type HubActions = ExtensionPointApiActions<'crm.record.tab'>;
hubspot.extend<'crm.record.tab'>(({ context, actions }: { context: CrmContext; actions: HubActions }) => <Hub context={context} actions={actions} />);

type Channel = 'whatsapp' | 'rcs' | 'sms';
type MsgType = 'text' | 'image' | 'video' | 'file' | 'buttons' | 'card' | 'carousel';
interface Btn { type: string; text: string; value?: string }
interface Card { title?: string; text?: string; mediaUrl?: string; suggestions?: Btn[] }
interface Tpl {
  id: string; name: string; channel: Channel; type?: MsgType; body?: string; title?: string;
  header?: string; footer?: string; mediaUrl?: string; buttons?: Btn[]; suggestions?: Btn[]; cards?: Card[];
  variables?: string[]; language?: string; category?: string; status?: string; error?: string | null; waName?: string;
}
type View = 'templates' | 'builder' | 'campaign' | 'dialer' | 'flows';

const typeOptions = (ch: Channel) => {
  if (ch === 'sms') return [{ label: 'Text', value: 'text' }];
  const base = [{ label: 'Text', value: 'text' }, { label: 'Image', value: 'image' }, { label: 'Video', value: 'video' }, { label: 'File', value: 'file' }];
  if (ch === 'whatsapp') return [...base, { label: 'Buttons', value: 'buttons' }];
  return [...base, { label: 'Rich card', value: 'card' }, { label: 'Carousel', value: 'carousel' }];
};

const Hub = ({ context, actions }: { context: CrmContext; actions: HubActions }) => {
  const portalId = context.portal?.id;
  const [view, setView] = useState<View>('templates');
  return (
    <Flex direction="column" gap="medium">
      <Flex direction="row" justify="between" align="center">
        <Heading>Vonage hub</Heading>
        <Select name="view" value={view} onChange={(v) => setView(v as View)}
          options={[{ label: 'Templates', value: 'templates' }, { label: 'New / edit', value: 'builder' }, { label: 'Campaign', value: 'campaign' }, { label: 'Flows', value: 'flows' }, { label: 'Dialer', value: 'dialer' }]} />
      </Flex>
      <Divider />
      {view === 'templates' && <Templates portalId={portalId} context={context} />}
      {view === 'builder' && <Builder portalId={portalId} onSaved={() => setView('templates')} />}
      {view === 'campaign' && <Campaign portalId={portalId} />}
      {view === 'dialer' && <Dialer portalId={portalId} />}
      {view === 'flows' && <Flows portalId={portalId} context={context} actions={actions} />}
    </Flex>
  );
};

const short = (s: string, n = 26) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
const Templates = ({ portalId, context }: { portalId?: number; context?: CrmContext }) => {
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [waba, setWaba] = useState<WaTpl[]>([]);
  // Send an approved WABA template to THIS contact, straight from the list.
  const objectId = context?.crm?.objectId; const objectTypeId = (context?.crm as any)?.objectTypeId || '0-1';
  const [to, setTo] = useState(''); const [firstName, setFirstName] = useState('');
  const [sendFor, setSendFor] = useState<WaTpl | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<{ ok: boolean; msg: string } | null>(null);
  // Deleting from the WhatsApp Business Account is permanent, so it is a two-step: pick it, then confirm.
  const [confirmDel, setConfirmDel] = useState<{ name: string; label: string } | null>(null);
  // Tool-built templates (SMS / RCS / WhatsApp, any type) send through /send-rich,
  // which builds the right payload per channel and fills {{variables}} itself.
  const [sendTpl, setSendTpl] = useState<Tpl | null>(null);
  const [tplVars, setTplVars] = useState<Record<string, string>>({});
  const startSendTpl = (x: Tpl) => {
    setSendFor(null); setSendTpl(x); setSendNote(null);
    const names = (x.variables && x.variables.length ? x.variables : Array.from(new Set(((x.body || '') + ' ' + (x.title || '') + ' ' + (x.header || '')).match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) || [])).map((m) => m.replace(/[{}\s]/g, '')));
    const v: Record<string, string> = {}; names.forEach((n) => { v[n] = /^first/i.test(n) ? firstName : ''; }); setTplVars(v);
  };
  const doSendTpl = async () => {
    if (!sendTpl || !to.trim()) { setSendNote({ ok: false, msg: 'Add a recipient number first.' }); return; }
    setSending(true); setSendNote(null);
    try {
      const r = await api(`/2v/api/send-rich`, { method: 'POST', body: { portalId, contactId: objectId, template: sendTpl, to: to.trim(), vars: tplVars } });
      setSendNote(r && r.ok ? { ok: true, msg: `Sent "${sendTpl.name}" by ${String(sendTpl.channel).toUpperCase()} to ${to.trim()} and logged to the timeline.` }
        : { ok: false, msg: 'Could not send: ' + ((r && (r.error || r.detail || r.title)) || 'unknown error') + (String(sendTpl.channel) === 'whatsapp' ? ' (free-form WhatsApp only reaches people who messaged you in the last 24h - use an approved template otherwise)' : '') });
    } catch (e) { setSendNote({ ok: false, msg: 'Could not reach the messaging service.' }); }
    setSending(false);
  };
  const [deleting, setDeleting] = useState(false);
  const inFlight = (st?: string) => ['submitted', 'pending', 'approved'].includes(String(st || '').toLowerCase());
  const delWaba = async () => {
    if (!confirmDel) return; setDeleting(true);
    try {
      const r = await api(`/2v/api/wa/templates?portalId=${portalId}&name=${encodeURIComponent(confirmDel.name)}`, { method: 'DELETE' });
      setNote(r && r.ok ? `Deleted "${confirmDel.label}" from your WhatsApp Business Account.` : 'Could not delete: ' + ((r && r.error) || 'unknown error'));
    } catch (e) { setNote('Could not reach the messaging service.'); }
    setDeleting(false); setConfirmDel(null); load();
  };
  useEffect(() => {
    if (!portalId || !objectId) return;
    api(`/2v/api/hs/resolve?portalId=${portalId}&objectType=${objectTypeId}&objectId=${objectId}`).then((d) => {
      const phone = d.phone || d.mobilephone || d.to || d.number || '';
      const name = d.name || d.firstName || d.firstname || '';
      if (phone) setTo(String(phone)); if (name) setFirstName(String(name).split(' ')[0]);
    }).catch(() => {});
  }, [portalId, objectId]);
  const startSend = (w: WaTpl) => { setSendTpl(null); setSendFor(w); setSendNote(null); setParams(new Array(w.varCount).fill('').map((_, i) => (i === 0 ? firstName : ''))); };
  const doSend = async () => {
    if (!sendFor || !to.trim()) { setSendNote({ ok: false, msg: 'Add a recipient number first.' }); return; }
    setSending(true); setSendNote(null);
    try {
      const r = await api(`/2v/api/wa/send-template`, { method: 'POST', body: { portalId, contactId: objectId, to: to.trim(), name: sendFor.name, language: sendFor.language, bodyParams: sendFor.varCount > 0 ? params : [] } });
      setSendNote(r && (r.ok || r.message_uuid) ? { ok: true, msg: `Sent "${sendFor.name}" to ${to.trim()} and logged to the timeline.` } : { ok: false, msg: 'Could not send: ' + ((r && (r.error || r.detail || r.title)) || 'unknown error') });
    } catch (e) { setSendNote({ ok: false, msg: 'Could not reach the messaging service.' }); }
    setSending(false);
  };
  // Two sources: templates built in this tool (stored per portal) AND every template
  // that actually exists on the WhatsApp Business Account - approved, pending or
  // rejected - read live from Vonage. Previously only the first was shown, so a
  // portal with 24 approved WhatsApp templates looked like it had one SMS draft.
  const load = () => {
    api(`/2v/api/templates?portalId=${portalId}`).then((d) => setTpls(d.templates || [])).catch(() => {});
    api(`/2v/api/wa/templates?portalId=${portalId}`).then((d) => setWaba(d.all || d.templates || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const submit = async (id: string) => {
    if (submitting) return; setSubmitting(id);
    try {
    setNote('Submitting…');
    const r = await api(`/2v/api/templates/${id}/submit?portalId=${portalId}`, { method: 'POST', body: {} });
    setNote(r.ok ? 'Submitted to Meta.' : r.message || 'Queued.'); load();
    } finally { setSubmitting(null); }
  };
  const del = async (id: string) => { await api(`/2v/api/templates/${id}?portalId=${portalId}`, { method: 'DELETE' }); load(); };
  if (!tpls.length && !waba.length) return <Text>No templates yet. Switch to <Text format={{ fontWeight: 'bold' }}>New / edit</Text> to build one.</Text>;
  return (
    <Flex direction="column" gap="small">
      {note && <Alert title="Status" variant="info">{note}</Alert>}
      {waba.length > 0 && <Text variant="microcopy">{waba.length} template{waba.length === 1 ? '' : 's'} found on your WhatsApp Business Account ({waba.filter((w) => String(w.status).toUpperCase() === 'APPROVED').length} approved) - listed below with anything built here. Approved ones are sent from the Messaging card.</Text>}
      {confirmDel && (
        <Flex direction="column" gap="small">
          <Alert title="Delete from your WhatsApp Business Account?" variant="warning">
            "{confirmDel.label}" ({confirmDel.name}) will be removed from Meta for every language. This cannot be undone, and it would need a new approval to come back.
          </Alert>
          <Flex gap="small">
            <LoadingButton loading={deleting} variant="destructive" onClick={delWaba}>Yes, delete it</LoadingButton>
            <Button variant="secondary" onClick={() => setConfirmDel(null)}>Cancel</Button>
          </Flex>
          <Divider />
        </Flex>
      )}
      {sendTpl && (
        <Flex direction="column" gap="small">
          <Text format={{ fontWeight: 'bold' }}>Send "{sendTpl.name}" by {String(sendTpl.channel).toUpperCase()}{sendTpl.type && sendTpl.type !== 'text' ? ` (${sendTpl.type})` : ''}</Text>
          <Text variant="microcopy">{short(sendTpl.body || sendTpl.title || '', 160)}</Text>
          <Input label="Recipient number" name="sendTplTo" value={to} onInput={(v) => setTo(v)} placeholder="e.g. 447700900000" />
          {Object.keys(tplVars).map((k) => <Input key={k} label={`{{${k}}}`} name={`tv_${k}`} value={tplVars[k]} onInput={(v) => setTplVars({ ...tplVars, [k]: v })} />)}
          <Flex gap="small">
            <LoadingButton loading={sending} variant="primary" onClick={doSendTpl}>Send now</LoadingButton>
            <Button variant="secondary" onClick={() => setSendTpl(null)}>Cancel</Button>
          </Flex>
          {sendNote && <Alert title={sendNote.ok ? 'Sent' : 'Not sent'} variant={sendNote.ok ? 'success' : 'error'}>{sendNote.msg}</Alert>}
          <Divider />
        </Flex>
      )}
      {sendFor && (
        <Flex direction="column" gap="small">
          <Text format={{ fontWeight: 'bold' }}>Send "{sendFor.name}" ({sendFor.language})</Text>
          <Text variant="microcopy">{short(sendFor.bodyText, 160)}</Text>
          <Input label="Recipient number" name="sendTo" value={to} onInput={(v) => setTo(v)} placeholder="e.g. 447700900000" />
          {params.map((p, i) => <Input key={i} label={`Variable {{${i + 1}}}`} name={`v${i}`} value={p} onInput={(v) => setParams(params.map((x, j) => (j === i ? v : x)))} />)}
          <Flex gap="small">
            <LoadingButton loading={sending} variant="primary" onClick={doSend}>Send now</LoadingButton>
            <Button variant="secondary" onClick={() => setSendFor(null)}>Cancel</Button>
          </Flex>
          {sendNote && <Alert title={sendNote.ok ? 'Sent' : 'Not sent'} variant={sendNote.ok ? 'success' : 'error'}>{sendNote.msg}</Alert>}
          <Divider />
        </Flex>
      )}
      <Table bordered>
        <TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>Channel</TableHeader><TableHeader>Type</TableHeader><TableHeader>Status</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
        <TableBody>
          {tpls.map((t) => (
            <TableRow key={t.id}>
              <TableCell>{short(t.name)}</TableCell>
              <TableCell><Tag>{t.channel.toUpperCase()}</Tag></TableCell>
              <TableCell>{t.type || 'text'}</TableCell>
              <TableCell>{t.channel === 'whatsapp' ? ((t.status || 'draft') + (t.error ? ' - ' + t.error : '')) : '-'}</TableCell>
              <TableCell>
                <Dropdown buttonSize="xs" variant="secondary" buttonText="Actions" options={[
                  { label: 'Send to this contact', onClick: () => startSendTpl(t) },
                  ...(t.channel === 'whatsapp' && !inFlight(t.status) ? [{ label: submitting === t.id ? 'Submitting…' : 'Submit for approval', onClick: () => submit(t.id) }] : []),
                  ...(t.channel === 'whatsapp' && t.waName && inFlight(t.status) ? [{ label: 'Delete from WhatsApp account', onClick: () => setConfirmDel({ name: t.waName as string, label: t.name }) }] : []),
                  { label: 'Remove from this list', onClick: () => del(t.id) },
                ]} />
              </TableCell>
            </TableRow>
          ))}
          {waba.filter((w) => !tpls.some((x) => (x.waName || '').toLowerCase() === String(w.name).toLowerCase())).map((w) => (
            <TableRow key={'waba-' + w.name + '-' + w.language}>
              <TableCell>{short(w.name)} · {w.language}</TableCell>
              <TableCell><Tag>WHATSAPP</Tag></TableCell>
              <TableCell>{w.hasMediaHeader ? String(w.headerFormat).toLowerCase() : 'text'}</TableCell>
              <TableCell>{String(w.status || '').toLowerCase()}</TableCell>
              <TableCell><Dropdown buttonSize="xs" variant="secondary" buttonText="Actions" options={[
                ...(String(w.status).toUpperCase() === 'APPROVED' ? [{ label: 'Send to this contact', onClick: () => startSend(w) }] : []),
                { label: 'Delete from WhatsApp account', onClick: () => setConfirmDel({ name: w.name, label: w.name }) },
              ]} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Flex>
  );
};

// Small repeating editor for buttons / suggestions
const Rows = ({ label, items, setItems, kinds }: { label: string; items: Btn[]; setItems: (b: Btn[]) => void; kinds: { label: string; value: string }[] }) => (
  <Flex direction="column" gap="extra-small">
    <Text format={{ fontWeight: 'bold' }}>{label}</Text>
    {items.map((b, i) => (
      <Flex key={i} direction="row" gap="extra-small" align="end">
        <Select name={`k${i}`} value={b.type} onChange={(v) => { const n = [...items]; n[i] = { ...b, type: v as string }; setItems(n); }} options={kinds} />
        <Input name={`t${i}`} value={b.text} placeholder="Label" onInput={(v) => { const n = [...items]; n[i] = { ...b, text: v }; setItems(n); }} />
        {b.type !== 'reply' && <Input name={`v${i}`} value={b.value || ''} placeholder={b.type === 'dial' || b.type === 'phone' ? '+44…' : 'https://…'} onInput={(v) => { const n = [...items]; n[i] = { ...b, value: v }; setItems(n); }} />}
        <Button size="xs" variant="destructive" onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</Button>
      </Flex>
    ))}
    <Button size="xs" onClick={() => setItems([...items, { type: kinds[0].value, text: '', value: '' }])}>Add</Button>
  </Flex>
);

const Builder = ({ portalId, onSaved }: { portalId?: number; onSaved: () => void }) => {
  const [channel, setChannel] = useState<Channel>('rcs');
  const [type, setType] = useState<MsgType>('text');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [category, setCategory] = useState('MARKETING');
  const [buttons, setButtons] = useState<Btn[]>([]);
  const [suggestions, setSuggestions] = useState<Btn[]>([]);
  const [cards, setCards] = useState<Card[]>([{ title: '', text: '', mediaUrl: '' }]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [preview, setPreview] = useState('');

  const vars = [...new Set([...(header + ' ' + body + ' ' + title).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];
  const assemble = (): Tpl => ({
    id: '', name, channel, type, body, title, header, footer, mediaUrl, language, category, variables: vars,
    buttons: type === 'buttons' ? buttons : [], suggestions: (type === 'text' || type === 'card') ? suggestions : [],
    cards: type === 'carousel' ? cards.filter((c) => c.title || c.text || c.mediaUrl) : [],
  });

  const showPreview = async () => {
    const r = await api('/2v/api/preview', { method: 'POST', body: { template: assemble(), to: '447700900000' } });
    setPreview(JSON.stringify(r.payload || r, null, 1));
  };
  const save = async (thenSubmit: boolean) => {
    if (!name.trim()) { setNote({ ok: false, msg: 'Name is required.' }); return; }
    setBusy(true);
    try {
      const r = await api('/2v/api/templates', { method: 'POST', body: { portalId, ...assemble() } });
      if (r.ok && thenSubmit && channel === 'whatsapp') {
        const s = await api(`/2v/api/templates/${r.template.id}/submit?portalId=${portalId}`, { method: 'POST', body: {} });
        setNote({ ok: !!(s.ok || s.queued), msg: s.ok ? (s.message || 'Saved & submitted to Meta.') : (s.message || s.error || 'Saved, but not submitted. Please try again.') });
      } else { setNote({ ok: true, msg: 'Template saved.' }); if (r.ok) setTimeout(onSaved, 700); }
    } catch (e) { setNote({ ok: false, msg: 'Could not save.' }); } finally { setBusy(false); }
  };

  const media = type === 'image' || type === 'video' || type === 'file';
  return (
    <Flex direction="column" gap="small">
      <Flex direction="row" gap="small">
        <Select label="Channel" name="ch" value={channel} onChange={(v) => { setChannel(v as Channel); setType('text'); }}
          options={[{ label: 'WhatsApp', value: 'whatsapp' }, { label: 'RCS', value: 'rcs' }, { label: 'SMS', value: 'sms' }]} />
        <Select label="Message type" name="ty" value={type} onChange={(v) => setType(v as MsgType)} options={typeOptions(channel)} />
      </Flex>
      <Input label="Template name" name="nm" value={name} onInput={setName} placeholder="Spring promo" />

      {media && <Input label={`${type} URL (paste a public/HubSpot file URL, or a hosted /2v/media id)`} name="mu" value={mediaUrl} onInput={setMediaUrl} placeholder="https://…" />}
      {type !== 'carousel' && <TextArea label={media ? 'Caption' : 'Body - variables: {{firstname}} {{lastname}} {{email}} {{phone}} {{company}}'} name="bd" value={body} onInput={setBody} rows={3} />}

      {channel === 'whatsapp' && type === 'text' && (
        <Flex direction="row" gap="small">
          <Select label="Language" name="lang" value={language} onChange={(v) => setLanguage(v as string)}
            options={[{ label: 'Polish', value: 'pl' }, { label: 'English (US)', value: 'en_US' }, { label: 'English (UK)', value: 'en_GB' }, { label: 'German', value: 'de' }, { label: 'French', value: 'fr' }, { label: 'Spanish', value: 'es' }, { label: 'Italian', value: 'it' }, { label: 'Dutch', value: 'nl' }, { label: 'Portuguese (BR)', value: 'pt_BR' }, { label: 'Hebrew', value: 'he' }, { label: 'Arabic', value: 'ar' }]} />
          <Select label="Category" name="cat" value={category} onChange={(v) => setCategory(v as string)}
            options={[{ label: 'Marketing', value: 'MARKETING' }, { label: 'Utility', value: 'UTILITY' }, { label: 'Authentication', value: 'AUTHENTICATION' }]} />
        </Flex>
      )}
      {channel === 'whatsapp' && type === 'text' && <Input label="Header (optional)" name="hd" value={header} onInput={setHeader} placeholder="Hi {{firstname}}" />}
      {channel === 'whatsapp' && (type === 'text' || type === 'buttons') && <Input label="Footer (optional)" name="ft" value={footer} onInput={setFooter} placeholder="Reply STOP to opt out" />}

      {channel === 'rcs' && type === 'card' && (
        <Flex direction="column" gap="extra-small">
          <Input label="Card title" name="ct" value={title} onInput={setTitle} />
          <Input label="Card image/video URL" name="cm" value={mediaUrl} onInput={setMediaUrl} placeholder="https://…" />
        </Flex>
      )}

      {channel === 'rcs' && type === 'carousel' && (
        <Flex direction="column" gap="small">
          <Text format={{ fontWeight: 'bold' }}>Carousel cards</Text>
          {cards.map((c, i) => (
            <Flex key={i} direction="column" gap="extra-small">
              <Flex direction="row" gap="extra-small">
                <Input name={`ct${i}`} value={c.title || ''} placeholder="Title" onInput={(v) => { const n = [...cards]; n[i] = { ...c, title: v }; setCards(n); }} />
                <Button size="xs" variant="destructive" onClick={() => setCards(cards.filter((_, j) => j !== i))}>✕</Button>
              </Flex>
              <Input name={`cx${i}`} value={c.text || ''} placeholder="Description" onInput={(v) => { const n = [...cards]; n[i] = { ...c, text: v }; setCards(n); }} />
              <Input name={`cm${i}`} value={c.mediaUrl || ''} placeholder="Image URL" onInput={(v) => { const n = [...cards]; n[i] = { ...c, mediaUrl: v }; setCards(n); }} />
              <Divider />
            </Flex>
          ))}
          <Button size="xs" onClick={() => setCards([...cards, { title: '', text: '', mediaUrl: '' }])}>Add card</Button>
        </Flex>
      )}

      {channel === 'whatsapp' && type === 'buttons' && (
        <Rows label="Buttons" items={buttons} setItems={setButtons} kinds={[{ label: 'Quick reply', value: 'reply' }, { label: 'Open URL', value: 'url' }, { label: 'Call', value: 'phone' }]} />
      )}
      {channel === 'rcs' && (type === 'text' || type === 'card') && (
        <Rows label="Suggestions" items={suggestions} setItems={setSuggestions} kinds={[{ label: 'Reply', value: 'reply' }, { label: 'Open URL', value: 'url' }, { label: 'Dial', value: 'dial' }]} />
      )}

      <Text variant="microcopy">Variables: {vars.length ? vars.join(', ') : 'none'}</Text>
      {note && <Alert title={note.ok ? 'Saved' : 'Check'} variant={note.ok ? 'success' : 'danger'}>{note.msg}</Alert>}
      {preview ? <Alert title="Vonage payload preview" variant="info">{preview}</Alert> : null}
      <ButtonRow>
        {busy ? <LoadingButton loading>Saving…</LoadingButton> : <Button variant="primary" onClick={() => save(false)}>Save</Button>}
        <Button onClick={showPreview}>Preview payload</Button>
        {channel === 'whatsapp' && !busy && <Button onClick={() => save(true)}>Save &amp; submit for approval</Button>}
      </ButtonRow>
    </Flex>
  );
};

interface Member { contactId?: string; name?: string; phone: string }
interface WaTpl { name: string; language: string; status: string; category: string; bodyText: string; varCount: number; headerFormat: string; hasMediaHeader: boolean }
const Campaign = ({ portalId }: { portalId?: number }) => {
  const [source, setSource] = useState('all');
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [listId, setListId] = useState('');
  const [paste, setPaste] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [mode, setMode] = useState('wa');
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [tplId, setTplId] = useState('');
  const [channel, setChannel] = useState<Channel>('sms');
  const [text, setText] = useState('');
  // Real approved WhatsApp templates
  const [waTpls, setWaTpls] = useState<WaTpl[]>([]);
  const [waName, setWaName] = useState('');
  const [waParams, setWaParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const waSel = waTpls.find((t) => t.name === waName);
  useEffect(() => {
    api(`/2v/api/templates?portalId=${portalId}`).then((d) => { setTpls(d.templates || []); if (d.templates?.[0]) setTplId(d.templates[0].id); }).catch(() => {});
    api(`/2v/api/hs/lists?portalId=${portalId}`).then((d) => setLists(d.lists || [])).catch(() => {});
    api('/2v/api/wa/templates?portalId=' + portalId).then((d) => setWaTpls(d.templates || [])).catch(() => {});
  }, []);
  const applyWa = (n: string) => {
    setWaName(n);
    const t = waTpls.find((x) => x.name === n);
    setWaParams(t ? new Array(t.varCount).fill('').map((_, i) => (i === 0 ? '{{firstname}}' : '')) : []);
  };
  const setParam = (i: number, v: string) => setWaParams((p) => { const n = [...p]; n[i] = v; return n; });
  const loadAud = async () => {
    setNote('Loading…');
    let m: Member[] = [];
    if (source === 'paste') m = paste.split('\n').map((s) => s.trim()).filter(Boolean).map((phone) => ({ phone }));
    else if (source === 'all') { const r = await api(`/2v/api/hs/contacts-with-phone?portalId=${portalId}`); m = (r.members || []).filter((x: Member) => x.phone); }
    else { const r = await api(`/2v/api/hs/lists/${listId}/members?portalId=${portalId}`); m = (r.members || []).filter((x: Member) => x.phone); }
    setMembers(m); setNote(`${m.length} recipients with a phone.`);
  };
  const send = async () => {
    if (mode === 'wa') {
      if (!waSel) { setNote('Pick a WhatsApp template.'); return; }
      if (waSel.varCount > 0 && waParams.some((p) => !p.trim())) { setNote(`Fill all ${waSel.varCount} variable(s).`); return; }
    }
    setBusy(true); setNote('Sending…');
    if (mode === 'wa') {
      const recipients = members.map((m) => ({ to: m.phone, contactId: m.contactId, firstname: (m.name || '').split(' ')[0] }));
      const r = await api('/2v/api/campaign/wa-template', { method: 'POST', body: { portalId, recipients, name: waSel!.name, language: waSel!.language, params: waSel!.varCount > 0 ? waParams : [] } });
      setNote(`Sent ${r.sent}/${r.total}.`); setBusy(false); return;
    }
    const recipients = members.map((m) => ({ to: m.phone, contactId: m.contactId, vars: { firstname: (m.name || '').split(' ')[0] } }));
    const body: Record<string, unknown> = { portalId, recipients };
    if (mode === 'tpl') body.templateId = tplId; else { body.channel = channel; body.text = text; }
    const r = await api('/2v/api/campaign/send', { method: 'POST', body });
    setNote(`Sent ${r.sent}/${r.total}.`); setBusy(false);
  };
  return (
    <Flex direction="column" gap="small">
      <Select label="Audience" name="src" value={source} onChange={(v) => setSource(v as string)}
        options={[{ label: 'All contacts with a phone', value: 'all' }, { label: 'HubSpot list', value: 'list' }, { label: 'Paste numbers', value: 'paste' }]} />
      {source === 'list' && <Select label="List" name="list" value={listId} onChange={(v) => setListId(v as string)} options={lists.map((l) => ({ label: l.name, value: String(l.id) }))} />}
      {source === 'paste' && <TextArea label="Numbers (one per line)" name="paste" value={paste} onInput={setPaste} rows={3} />}
      <Button onClick={loadAud}>Load recipients</Button>
      {note && <Text variant="microcopy">{note}</Text>}
      <Divider />
      <Select label="Send as" name="mode" value={mode} onChange={(v) => setMode(v as string)}
        options={[{ label: 'Approved WhatsApp template', value: 'wa' }, { label: 'Saved template (this tool)', value: 'tpl' }, { label: 'Free text', value: 'text' }]} />
      {mode === 'wa' && (
        <Flex direction="column" gap="extra-small">
          <Select label={waTpls.length ? `WhatsApp template (${waTpls.length})` : 'WhatsApp template'} name="watpl" value={waName}
            placeholder={waTpls.length ? 'Choose a template' : 'Loading your templates…'} onChange={(v) => applyWa(v as string)}
            options={waTpls.map((t) => ({ label: `${t.name} (${t.language})`, value: t.name }))} />
          {waSel && (
            <Flex direction="column" gap="extra-small">
              {waSel.hasMediaHeader && <Text variant="microcopy">Has a {waSel.headerFormat.toLowerCase()} header (set in WhatsApp Manager).</Text>}
              <Text variant="microcopy">{waSel.bodyText || '(no body text)'}</Text>
              {waSel.varCount > 0 && new Array(waSel.varCount).fill(0).map((_, i) => (
                <Input key={i} label={`Variable {{${i + 1}}}`} name={`wp${i}`} value={waParams[i] || ''} onInput={(v) => setParam(i, v)} placeholder="value or {{firstname}}" />
              ))}
              <Text variant="microcopy">Tip: put {'{{firstname}}'} in any variable to personalise per contact.</Text>
            </Flex>
          )}
        </Flex>
      )}
      {mode === 'tpl' && <Select label="Template" name="tpl" value={tplId} onChange={(v) => setTplId(v as string)} options={tpls.map((t) => ({ label: `[${t.channel}/${t.type || 'text'}] ${t.name}`, value: t.id }))} />}
      {mode === 'text' && (
        <Flex direction="column" gap="small">
          <Select label="Channel" name="cch" value={channel} onChange={(v) => setChannel(v as Channel)} options={[{ label: 'SMS', value: 'sms' }, { label: 'WhatsApp', value: 'whatsapp' }, { label: 'RCS', value: 'rcs' }]} />
          <TextArea label="Text - {{firstname}} filled per contact" name="ctext" value={text} onInput={setText} rows={3} />
        </Flex>
      )}
      {busy ? <LoadingButton loading>Sending…</LoadingButton> : <Button variant="primary" disabled={!members.length} onClick={send}>Send to {members.length}</Button>}
    </Flex>
  );
};

const Dialer = ({ portalId }: { portalId?: number }) => {
  const [num, setNum] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const call = async () => {
    if (!num.trim()) { setNote('Enter a number.'); return; }
    setBusy(true); setNote('Calling…');
    const r = await api('/2v/api/call', { method: 'POST', body: { portalId, to: num } });
    setNote(r.ok ? `Call placed to ${num}.` : `Could not place call: ${r.body?.title || r.error || 'error'}`); setBusy(false);
  };
  return (
    <Flex direction="column" gap="small">
      <Input label="Number" name="dn" value={num} onInput={setNum} placeholder="+447700900000" />
      {note && <Text>{note}</Text>}
      {busy ? <LoadingButton loading>Calling…</LoadingButton> : <Button variant="primary" onClick={call}>Call</Button>}
    </Flex>
  );
};

// ---- Flows: conversational automations built in the hosted flow builder ----
// The builder itself (steps, if/then rules, templates, senders, simulator) is a
// full web page on the backend, opened in a HubSpot iframe modal. This view lists
// the portal's flows and starts one for the contact on screen.
interface FlowRow { id: string; name: string; channel: Channel; enabled: boolean; trigger: { type: string; keywords: string[] }; steps: unknown[] }
const Flows = ({ portalId, context, actions }: { portalId?: number; context: CrmContext; actions: HubActions }) => {
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const objectId = context?.crm?.objectId; const objectTypeId = (context?.crm as any)?.objectTypeId || '0-1';
  const load = () => { if (!portalId) return; setLoading(true); api(`/2v/api/flows?portalId=${portalId}`).then((d) => setFlows(d.flows || [])).catch(() => setFlows([])).finally(() => setLoading(false)); };
  useEffect(load, [portalId]);
  useEffect(() => {
    if (!portalId || !objectId) return;
    api(`/2v/api/hs/resolve?portalId=${portalId}&objectType=${objectTypeId}&objectId=${objectId}`).then((d) => { if (d.phone) setTo(String(d.phone)); }).catch(() => {});
  }, [portalId, objectId]);
  const openBuilder = () => actions.openIframeModal({ uri: `${MW}/2v/flows?portal=${portalId}&embed=1`, width: 1440, height: 900, title: 'Vonage flows', flush: true }, () => load());
  const start = async (f: FlowRow) => {
    if (!to.trim()) { setNote({ ok: false, msg: 'This record has no phone number.' }); return; }
    setBusy(f.id); setNote(null);
    try {
      const r = await api(`/2v/api/flows/${f.id}/start`, { method: 'POST', body: { portalId, to, contactId: objectId } });
      if (r.error) setNote({ ok: false, msg: niceErr(r.error) }); else setNote({ ok: true, msg: `"${f.name}" started for ${to}${r.waiting ? ' - waiting for their reply' : ''}.` });
    } catch (e) { setNote({ ok: false, msg: String(e) }); }
    setBusy(null);
  };
  const trig = (f: FlowRow) => f.trigger?.type === 'keyword' ? `Keyword: ${(f.trigger.keywords || []).join(', ')}` : f.trigger?.type === 'any' ? 'Any inbound message' : 'Started by you';
  return (
    <Flex direction="column" gap="small">
      <Text variant="microcopy">Flows send a message or template, then branch on the reply (if this, then that) over WhatsApp, RCS or SMS. Build and test them in the flow builder; start any flow for this contact here, or use the "Start Vonage flow" workflow action.</Text>
      <ButtonRow>
        <Button variant="primary" onClick={openBuilder}>Open flow builder</Button>
        <Button onClick={load}>Refresh</Button>
      </ButtonRow>
      {note && <Alert title={note.ok ? 'Started' : 'Not started'} variant={note.ok ? 'success' : 'error'}>{note.msg}</Alert>}
      {loading ? <Text>Loading flows...</Text> : flows.length === 0 ? <Text>No flows yet. Open the flow builder to create the first one.</Text> : (
        <Table bordered={true}>
          <TableHead><TableRow><TableHeader>Flow</TableHeader><TableHeader>Channel</TableHeader><TableHeader>Starts when</TableHeader><TableHeader>Steps</TableHeader><TableHeader></TableHeader></TableRow></TableHead>
          <TableBody>
            {flows.map((f) => (
              <TableRow key={f.id}>
                <TableCell>{f.name}{f.enabled ? '' : ' (disabled)'}</TableCell>
                <TableCell><Tag>{f.channel}</Tag></TableCell>
                <TableCell>{short(trig(f), 34)}</TableCell>
                <TableCell>{(f.steps || []).length}</TableCell>
                <TableCell><LoadingButton size="xs" loading={busy === f.id} onClick={() => start(f)}>Start for this contact</LoadingButton></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Flex>
  );
};
