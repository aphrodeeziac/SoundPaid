import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import bs58 from 'bs58';

const json = (body, status=200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

function normalizeSoundCloudProfile(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !['soundcloud.com','www.soundcloud.com'].includes(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 1) return null;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(parts[0])) return null;
  return `https://soundcloud.com/${parts[0]}`;
}

function validWallet(value) {
  try { return bs58.decode(value).length === 32; } catch { return false; }
}

export default async (req) => {
  if (req.method !== 'POST') return json({error:'POST required'},405);
  let body;
  try { body = await req.json(); } catch { return json({error:'Invalid JSON'},400); }

  const wallet = String(body.wallet || '').trim();
  const soundcloudUrl = normalizeSoundCloudProfile(body.soundcloudUrl);
  if (!validWallet(wallet)) return json({error:'A valid Solana payout wallet is required.'},400);
  if (!soundcloudUrl) return json({error:'Use the artist public SoundCloud profile URL, for example https://soundcloud.com/artist.'},400);

  const store = getStore({name:'soundpaid', consistency:'strong'});
  const existingArtist = await store.get(`artist/${wallet}`, {type:'json'});
  if (existingArtist?.status === 'verified') return json({error:'This wallet is already a verified artist payout wallet.'},409);

  const profileKey = crypto.createHash('sha256').update(soundcloudUrl.toLowerCase()).digest('hex');
  const profileOwner = await store.get(`profile/${profileKey}`, {type:'json'});
  if (profileOwner?.wallet && profileOwner.wallet !== wallet) {
    return json({error:'This SoundCloud profile is already linked to a different verified payout wallet.'},409);
  }

  const code = `SOUNDPAID-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const createdAt = Date.now();
  const challenge = {
    wallet,
    soundcloudUrl,
    profileKey,
    code,
    createdAt,
    expiresAt: createdAt + 30*60*1000
  };
  await store.setJSON(`challenge/${wallet}`, challenge);
  return json({code, soundcloudUrl, expiresAt: challenge.expiresAt});
};
