import { verifySoundCloudArtist, validPubkey, validSignature } from '../lib/soundcloud.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

function send(res,status,body){
  res.status(status).setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
  });
  if (!r.ok) throw new Error(`Solana RPC HTTP ${r.status}`);
  const payload = await r.json();
  if (payload.error) throw new Error(payload.error.message || 'Solana RPC error');
  return payload.result;
}

function transferFound(tx, source, destination, minLamports) {
  const instructions = tx?.transaction?.message?.instructions || [];
  return instructions.some(ix => {
    if (ix?.program !== 'system' || ix?.parsed?.type !== 'transfer') return false;
    const info = ix.parsed.info || {};
    const lamports = Number(info.lamports || 0);
    return info.source === source && info.destination === destination &&
      Number.isSafeInteger(lamports) && lamports >= minLamports;
  });
}

function mintInitFound(tx, mint, authority) {
  const instructions = tx?.transaction?.message?.instructions || [];
  return instructions.some(ix => {
    const p = ix?.parsed;
    if (!p || !['initializeMint','initializeMint2'].includes(p.type)) return false;
    const info = p.info || {};
    return info.mint === mint && info.mintAuthority === authority && info.freezeAuthority == null;
  });
}

export default async function handler(req,res) {
  if (req.method !== 'POST') return send(res,405,{error:'POST required'});
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const signature = String(body.signature || '').trim();
    const creatorWallet = String(body.creatorWallet || '').trim();
    const mint = String(body.mint || '').trim();
    const name = String(body.name || '').trim().slice(0,32);
    const symbol = String(body.symbol || '').trim().toUpperCase().slice(0,10);
    const soundcloudUrl = String(body.soundcloudUrl || '').trim();
    const supply = Number(body.supply);
    const decimals = Number(body.decimals);
    const feeLamports = Number(body.feeLamports);

    if (!validSignature(signature)) return send(res,400,{error:'Invalid Solana transaction signature.'});
    if (!validPubkey(creatorWallet) || !validPubkey(mint)) return send(res,400,{error:'Invalid Solana public key.'});
    if (!name || !symbol) return send(res,400,{error:'Token name and symbol are required.'});
    if (!Number.isSafeInteger(supply) || supply <= 0) return send(res,400,{error:'Invalid token supply.'});
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) return send(res,400,{error:'Invalid token decimals.'});
    if (!Number.isSafeInteger(feeLamports) || feeLamports <= 0) return send(res,400,{error:'Artist fee must be greater than zero.'});

    const artist = await verifySoundCloudArtist(soundcloudUrl);
    const tx = await rpc('getTransaction',[signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
    if (!tx) return send(res,409,{error:'Transaction is not confirmed on Solana yet.'});
    if (tx.meta?.err) return send(res,409,{error:'The Solana transaction failed.'});

    const keys = tx.transaction?.message?.accountKeys || [];
    const creatorIsSigner = keys.some(k => (typeof k === 'string' ? k : k.pubkey) === creatorWallet && (typeof k === 'string' ? false : k.signer === true));
    if (!creatorIsSigner) return send(res,409,{error:'Creator wallet did not sign this transaction.'});
    if (!transferFound(tx,creatorWallet,artist.wallet,feeLamports)) return send(res,409,{error:'Required artist SOL payment was not found in the confirmed transaction.'});
    if (!mintInitFound(tx,mint,creatorWallet)) return send(res,409,{error:'Transaction does not initialize the claimed mint with the creator as mint authority and no freeze authority.'});

    const mintInfo = await rpc('getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'confirmed'}]);
    const parsed = mintInfo?.value?.data?.parsed;
    const info = parsed?.info;
    if (parsed?.type !== 'mint' || !info) return send(res,409,{error:'Mint account is not a parsed SPL mint.'});

    const expected = BigInt(supply) * (10n ** BigInt(decimals));
    if (BigInt(info.supply || '0') !== expected) return send(res,409,{error:'On-chain supply does not match the launch record.'});
    if (Number(info.decimals) !== decimals) return send(res,409,{error:'On-chain decimals do not match the launch record.'});
    if (info.mintAuthority != null || info.freezeAuthority != null) return send(res,409,{error:'Mint or freeze authority is still active.'});

    return send(res,200,{
      ok:true,
      receipt:{
        network:'mainnet-beta',
        signature,
        mint,
        name,
        symbol,
        supply,
        decimals,
        creatorWallet,
        artistWallet:artist.wallet,
        soundcloudUrl:artist.soundcloudUrl,
        feeLamports,
        slot:tx.slot,
        blockTime:tx.blockTime || null,
        verifiedAt:Date.now()
      }
    });
  } catch (error) {
    return send(res,400,{error:error.message || 'Launch verification failed'});
  }
}
