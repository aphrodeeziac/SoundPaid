import bs58 from 'bs58';

export function normalizeSoundCloudProfile(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !['soundcloud.com','www.soundcloud.com'].includes(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(parts[0])) return null;
  return `https://soundcloud.com/${parts[0]}`;
}

export function validPubkey(value) {
  try { return bs58.decode(String(value || '')).length === 32; } catch { return false; }
}

export function validSignature(value) {
  try { return bs58.decode(String(value || '')).length === 64; } catch { return false; }
}

export async function fetchSoundCloudProfile(url) {
  let current = new URL(url);
  for (let i = 0; i < 4; i++) {
    if (current.protocol !== 'https:' || !['soundcloud.com','www.soundcloud.com'].includes(current.hostname.toLowerCase())) {
      throw new Error('SoundCloud redirected outside its own domain.');
    }
    const res = await fetch(current, {
      headers: {
        'user-agent':'Mozilla/5.0 (compatible; SoundPaidVerifier/1.0)',
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

export function extractSoundPaidWallet(html) {
  const normalized = String(html || '')
    .replace(/\\u003A/gi, ':')
    .replace(/\\u002D/gi, '-')
    .replace(/&#x3A;|&#58;|&colon;/gi, ':')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\\n/g, ' ');
  const match = normalized.match(/SOUNDPAID\s*[:=\-]\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (!match || !validPubkey(match[1])) return null;
  return match[1];
}

export async function verifySoundCloudArtist(profileUrl) {
  const soundcloudUrl = normalizeSoundCloudProfile(profileUrl);
  if (!soundcloudUrl) throw new Error('Use a public SoundCloud artist profile URL, for example https://soundcloud.com/artist.');
  const html = await fetchSoundCloudProfile(soundcloudUrl);
  const wallet = extractSoundPaidWallet(html);
  if (!wallet) throw new Error('No valid SOUNDPAID:<SOLANA_WALLET> tag was found in the public SoundCloud bio.');
  return { soundcloudUrl, wallet };
}
