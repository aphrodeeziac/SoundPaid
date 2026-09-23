import { getStore } from '@netlify/blobs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const json = (body, status=200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

async function fetchSoundCloudProfile(url) {
  let current = new URL(url);
  for (let i=0; i<4; i++) {
    if (current.protocol !== 'https:' || !['soundcloud.com','www.soundcloud.com'].includes(current.hostname.toLowerCase())) {
      throw new Error('SoundCloud redirected outside its own domain.');
    }
    const res = await fetch(current, {
      headers: {
        'user-agent':'Mozilla/5.0 SoundPaidVerifier/1.0',
        'accept':'text/html,application/xhtml+xml'
      },
      redirect:'manual'
    });
    if ([301,302,303,307,308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('SoundCloud returned an invalid redirect.');
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new Error(`SoundCloud returned HTTP ${res.status}.`);
    return await res.text();
  }
  throw new Error('Too many SoundCloud redirects.');
}

export default async (req) => {
  if (req.method !== 'POST') return json({error:'POST required'},405);
  let body;
  try { body = await req.json(); } catch { return json({error:'Invalid JSON'},400); }

  const wallet = String(body.wallet || '').trim();
  const signature = String(body.signature || '').trim();
  const store = getStore({name:'soundpaid', consistency:'strong'});
  const challenge = await store.get(`challenge/${wallet}`, {type:'json'});
  if (!challenge) return json({error:'No active challenge'},404);
  if (Date.now() > challenge.expiresAt) {
    await store.delete(`challenge/${wallet}`);
    return json({error:'Challenge expired. Start again.'},400);
  }

  const message = `SoundPaid artist verification\nWallet: ${challenge.wallet}\nSoundCloud: ${challenge.soundcloudUrl}\nCode: ${challenge.code}`;
  let validSignature = false;
  try {
    const pubkey = bs58.decode(wallet);
    const sig = bs58.decode(signature);
    validSignature = pubkey.length === 32 && sig.length === 64 && nacl.sign.detached.verify(
      new TextEncoder().encode(message), sig, pubkey
    );
  } catch {}
  if (!validSignature) return json({error:'Wallet signature did not verify'},400);

  let html;
  try { html = await fetchSoundCloudProfile(challenge.soundcloudUrl); }
  catch (error) { return json({error:`Could not verify the SoundCloud profile: ${error.message}`},502); }
  if (!html.toUpperCase().includes(challenge.code.toUpperCase())) {
    return json({error:'Verification code was not found on the public SoundCloud profile. Keep it in the bio and try again.'},400);
  }

  const profileOwner = await store.get(`profile/${challenge.profileKey}`, {type:'json'});
  if (profileOwner?.wallet && profileOwner.wallet !== wallet) {
    return json({error:'This SoundCloud profile is already linked to another verified wallet.'},409);
  }

  const artist = {
    wallet,
    soundcloudUrl: challenge.soundcloudUrl,
    profileKey: challenge.profileKey,
    verifiedAt: Date.now(),
    status:'verified'
  };
  await store.setJSON(`artist/${wallet}`, artist);
  await store.setJSON(`profile/${challenge.profileKey}`, {wallet, soundcloudUrl: challenge.soundcloudUrl, verifiedAt: artist.verifiedAt});
  await store.delete(`challenge/${wallet}`);
  return json({ok:true, artist});
};
