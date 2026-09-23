import { getStore } from '@netlify/blobs';
import bs58 from 'bs58';

const json = (body, status=200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

const RPC_URL = Netlify.env.get('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com';

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0', id:1, method, params})
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.error) throw new Error(payload.error.message || 'Solana RPC error');
  return payload.result;
}

function isPubkey(value) {
  try { return bs58.decode(value).length === 32; } catch { return false; }
}
function isSignature(value) {
  try { return bs58.decode(value).length === 64; } catch { return false; }
}

function findSystemTransfer(tx, source, destination, minLamports) {
  const instructions = tx?.transaction?.message?.instructions || [];
  return instructions.some((ix) => {
    const p = ix?.parsed;
    if (p?.type !== 'transfer' || ix?.program !== 'system') return false;
    const info = p.info || {};
    const lamports = Number(info.lamports ?? 0);
    return info.source === source && info.destination === destination && Number.isSafeInteger(lamports) && lamports >= minLamports;
  });
}

function findMintInitialization(tx, mint, authority) {
  const instructions = tx?.transaction?.message?.instructions || [];
  return instructions.some((ix) => {
    const p = ix?.parsed;
    if (!p || !['initializeMint','initializeMint2'].includes(p.type)) return false;
    const info = p.info || {};
    return info.mint === mint && info.mintAuthority === authority && info.freezeAuthority == null;
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json({error:'POST required'},405);
  let body;
  try { body = await req.json(); } catch { return json({error:'Invalid JSON'},400); }

  const signature = String(body.signature || '').trim();
  const creatorWallet = String(body.creatorWallet || '').trim();
  const artistWallet = String(body.artistWallet || '').trim();
  const mint = String(body.mint || '').trim();
  const name = String(body.name || '').trim().slice(0,32);
  const symbol = String(body.symbol || '').trim().toUpperCase().slice(0,10);
  const metadataUri = String(body.metadataUri || '').trim().slice(0,200);
  const supply = Number(body.supply);
  const decimals = Number(body.decimals);
  const feeLamports = Number(body.feeLamports);

  if (!isSignature(signature)) return json({error:'Invalid Solana transaction signature.'},400);
  if (![creatorWallet,artistWallet,mint].every(isPubkey)) return json({error:'Invalid Solana public key.'},400);
  if (!name || !symbol) return json({error:'Token name and symbol are required.'},400);
  if (!Number.isSafeInteger(supply) || supply <= 0) return json({error:'Invalid token supply.'},400);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) return json({error:'Invalid token decimals.'},400);
  if (!Number.isSafeInteger(feeLamports) || feeLamports <= 0) return json({error:'Artist launch fee must be greater than zero.'},400);

  const store = getStore({name:'soundpaid', consistency:'strong'});
  const artist = await store.get(`artist/${artistWallet}`, {type:'json'});
  if (!artist || artist.status !== 'verified') return json({error:'Artist payout wallet is not verified.'},409);

  const existing = await store.get(`launch/${signature}`, {type:'json'});
  if (existing) return json({ok:true, launch:existing});

  let tx;
  try {
    tx = await rpc('getTransaction', [signature, {encoding:'jsonParsed', commitment:'confirmed', maxSupportedTransactionVersion:0}]);
  } catch (error) {
    return json({error:`Could not read the Solana transaction: ${error.message}`},502);
  }
  if (!tx) return json({error:'Transaction is not confirmed on Solana yet.'},409);
  if (tx.meta?.err) return json({error:'The Solana transaction failed.'},409);

  const keys = tx.transaction?.message?.accountKeys || [];
  const creatorIsSigner = keys.some((k) => (typeof k === 'string' ? k : k.pubkey) === creatorWallet && (typeof k === 'string' ? false : k.signer === true));
  if (!creatorIsSigner) return json({error:'Creator wallet did not sign this transaction.'},409);
  if (!findSystemTransfer(tx, creatorWallet, artistWallet, feeLamports)) {
    return json({error:'Confirmed transaction does not contain the required artist SOL payment.'},409);
  }
  if (!findMintInitialization(tx, mint, creatorWallet)) {
    return json({error:'Confirmed transaction does not initialize the claimed mint with the creator as mint authority and no freeze authority.'},409);
  }

  let mintInfo;
  try {
    mintInfo = await rpc('getAccountInfo', [mint, {encoding:'jsonParsed', commitment:'confirmed'}]);
  } catch (error) {
    return json({error:`Could not validate the mint: ${error.message}`},502);
  }
  const parsed = mintInfo?.value?.data?.parsed;
  const info = parsed?.info;
  if (parsed?.type !== 'mint' || !info) return json({error:'Mint account is not a parsed SPL mint.'},409);
  const expectedAmount = BigInt(supply) * (10n ** BigInt(decimals));
  if (BigInt(info.supply || '0') !== expectedAmount) return json({error:'On-chain supply does not match the launch record.'},409);
  if (Number(info.decimals) !== decimals) return json({error:'On-chain decimals do not match the launch record.'},409);
  if (info.mintAuthority != null || info.freezeAuthority != null) return json({error:'Mint or freeze authority is still active; SoundPaid requires a fixed supply with both authorities disabled.'},409);

  const launch = {
    signature,
    mint,
    name,
    symbol,
    supply,
    decimals,
    metadataUri,
    creatorWallet,
    artistWallet,
    soundcloudUrl: artist.soundcloudUrl,
    feeLamports,
    slot: tx.slot,
    blockTime: tx.blockTime || null,
    recordedAt: Date.now(),
    network:'mainnet-beta',
    status:'confirmed'
  };
  await store.setJSON(`launch/${signature}`, launch);
  await store.setJSON(`mint/${mint}`, {signature, recordedAt:launch.recordedAt});
  return json({ok:true, launch});
};
