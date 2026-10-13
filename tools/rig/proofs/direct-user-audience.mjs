import { Proof } from '../proof.mjs'

// Production HTTP mail/command routes, real authorization tools, fake providers only.
export default async function (rig) {
  const p = new Proof('direct-user-audience')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns idle' })
  const oid = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const id = n => rig.agentRow(n).id
  const grants = n => rig.sql(`SELECT * FROM ot.audiences WHERE org_id=${oid} AND grantee='${n}' AND grantor='@user' AND revoked_at IS NULL AND NOT paused`)
  const notes = n => rig.sql(`SELECT ev,body,notice FROM ot.mail WHERE org_id=${oid} AND recipient_agent_id=${id(n)} AND ev->>'variant'='access.audience_changed' AND ev->>'outcome'='user_audience'`)
  const write = n => rig.tool(n, 'orgtree_message', { to: 'user', body: 'synthetic reply', notice: true })
  const revoke = n => rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'revoke', node: n, target: 'user' })
  const idle = n => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id=${id(n)} AND ended_at IS NULL`).length === 0, { what: `${n} idle` })
  const post = (n,text,extra={}) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${n}/message`, { text, notice:true, ...extra })

  p.check('nested agent cannot write to user before direct contact', !(await write('bob')).ok && grants('bob').length===0)
  await post('bob','USER-CONTACT-ONE')
  p.check('depth-two user message grants one active audience and real tool reply succeeds', grants('bob').length===1 && (await write('bob')).ok)
  const notice=notes('bob')
  p.check('canonical typed user_audience access notice is passive and has established wording', notice.length===1 && notice[0].notice && notice[0].body==='You now hold an audience with the user: you may write to the user (to=user), ask the user, and present documents.', notice)
  const chain=rig.sql(`SELECT recipient_name FROM ot.mail WHERE org_id=${oid} AND ev->>'variant'='context.deep_reach' AND ev->>'gist'='USER-CONTACT-ONE' ORDER BY recipient_name`)
  p.check('both superiors receive the direct-contact notice', JSON.stringify(chain.map(x=>x.recipient_name))===JSON.stringify(['alice','boss']),chain)
  const evCount=()=>Number(rig.one(`SELECT count(*) AS n FROM ot.events WHERE org_id=${oid} AND op='audience_grant' AND subject_agent_id=${id('bob')}`).n)
  const before=evCount()
  await Promise.all([post('bob','USER-CONTACT-TWO'),post('bob','USER-CONTACT-THREE')])
  p.check('concurrent repeat contact does not duplicate active grants, access notices or audit events', grants('bob').length===1 && notes('bob').length===1 && evCount()===before)
  await revoke('bob')
  p.check('revocation removes reply authority', grants('bob').length===0 && !(await write('bob')).ok)
  await post('bob','USER-CONTACT-REGRANT')
  p.check('new contact after revocation grants again', grants('bob').length===1 && notes('bob').length===2 && (await write('bob')).ok)
  await post('boss','USER-CONTACT-ROOT')
  p.check('top-level contact needs no explicit audience and still replies', grants('boss').length===0 && (await write('boss')).ok)
  p.check('chain notices do not themselves grant user audiences to superiors',grants('alice').length===0)
  await rig.tool('boss','orgtree_message',{to:'carol',body:'ordinary agent contact',notice:true})
  p.check('agent contact does not grant a user audience', grants('carol').length===0 && !(await write('carol')).ok)

  // Fault only the throwaway rig database: if the primary message fails, no grant/notice survives.
  await revoke('bob')
  const nBefore=notes('bob').length
  rig.exec(`CREATE FUNCTION public.refuse_contact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body='ROLLBACK-CONTACT' THEN RAISE EXCEPTION 'synthetic mail refusal'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_contact BEFORE INSERT ON ot.mail FOR EACH ROW EXECUTE FUNCTION public.refuse_contact()`)
  let refused=false
  try { await post('bob','ROLLBACK-CONTACT') } catch { refused=true }
  finally { rig.exec('DROP TRIGGER refuse_contact ON ot.mail; DROP FUNCTION public.refuse_contact()') }
  p.check('message insertion failure rolls back grant and canonical notice', refused && grants('bob').length===0 && notes('bob').length===nBefore)

  // Reply variant is eligible too.
  const sent=await rig.tool('boss','orgtree_message',{to:'bob',body:'reply source',notice:true})
  const source=rig.one(`SELECT uid FROM ot.mail WHERE org_id=${oid} AND body='reply source' ORDER BY id DESC LIMIT 1`)
  await post('bob','USER-REPLY',{reply_to:{kind:'mail',id:source.uid}})
  p.check('direct user reply restores audience', sent.ok && grants('bob').length===1)

  // A real slash-command actor admission, rather than calling the grant helper.
  await post('carol','/help',{notice:false})
  p.check('ordinary Claude slash command grants user reply access',grants('carol').length===1 && (await write('carol')).ok)
  await idle('carol'); await revoke('carol')
  const compact=await rig.api('POST', `/api/orgs/${rig.org}/nodes/carol/compact`)
  p.check('explicit Claude compact also grants reply access',compact.started && grants('carol').length===1 && (await write('carol')).ok,compact)
  await idle('carol'); await revoke('carol')
  await post('carol','/compact',{notice:false})
  p.check('typed compact follows the same direct-contact path',grants('carol').length===1)

  await rig.op({op:'hire',name:'mira',parent:'boss',tier:'wonder',title:'synthetic Muse compact control'})
  // Hiring alone need not start a turn. Warm the fake Muse session through agent mail,
  // so setup itself cannot satisfy the user-contact assertion.
  const warmed=await rig.tool('boss','orgtree_message',{to:'mira',body:'synthetic session initialization'})
  if (!warmed.ok) throw new Error('synthetic Muse session initialization refused')
  await rig.waitFor(()=>rig.agentRow('mira')?.session_id && rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id=${id('mira')} AND ended_at IS NULL`).length===0,{what:'Muse session idle'})
  p.check('Muse kickoff/system notices grant no user audience',grants('mira').length===0)
  const mc=await rig.api('POST', `/api/orgs/${rig.org}/nodes/mira/compact`)
  p.check('Muse compact grants the same authority through common command admission',mc.started && grants('mira').length===1 && (await write('mira')).ok,mc)
  const mn=rig.sql(`SELECT 1 FROM ot.mail WHERE org_id=${oid} AND recipient_name='boss' AND ev->>'variant'='context.deep_reach' AND ev->>'node'='mira' AND ev->>'kind'='command'`)
  p.check('Muse compact also notifies its superior chain',mn.length===1)

  const other=await rig.api('POST','/api/orgs',{name:'Other direct contact rig',dirs:[],net_autoconnect:false})
  await rig.op({op:'hire',name:'boss',tier:'opus',grant:6},{org:other.slug})
  await rig.op({op:'hire',name:'bob',tier:'haiku',parent:'boss'},{org:other.slug})
  const otherId=rig.one(`SELECT id FROM ot.orgs WHERE slug='${other.slug}'`).id
  p.check('same-name agent in a second org inherits no grant',rig.sql(`SELECT 1 FROM ot.audiences WHERE org_id=${otherId} AND grantee='bob' AND grantor='@user'`).length===0)
  await rig.userMail('bob','OTHER-ORG-CONTACT',{org:other.slug,notice:true})
  p.check('direct contact grants only within the addressed second org',rig.sql(`SELECT 1 FROM ot.audiences WHERE org_id=${otherId} AND grantee='bob' AND grantor='@user' AND revoked_at IS NULL`).length===1 && grants('bob').length===1)
  p.keep(rig,{agents:['carol','mira'],grep:/deep_reach|grant_notice|audience/})
  return p.summary()
}
