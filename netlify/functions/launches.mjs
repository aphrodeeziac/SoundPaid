import { getStore } from '@netlify/blobs';

const json = (body, status=200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

export default async (req) => {
  if (req.method !== 'GET') return json({error:'GET required'},405);
  const store = getStore({name:'soundpaid'});
  const url = new URL(req.url);
  const mint = url.searchParams.get('mint')?.trim();
  if (mint) {
    const pointer = await store.get(`mint/${mint}`, {type:'json'});
    if (!pointer?.signature) return json({error:'Launch not found'},404);
    const launch = await store.get(`launch/${pointer.signature}`, {type:'json'});
    return launch ? json({launch}) : json({error:'Launch not found'},404);
  }

  const { blobs } = await store.list({prefix:'launch/'});
  const launches = [];
  for (const blob of blobs.slice(0,250)) {
    const launch = await store.get(blob.key,{type:'json'});
    if (launch?.status === 'confirmed') launches.push(launch);
  }
  launches.sort((a,b)=>b.recordedAt-a.recordedAt);
  return json({launches:launches.slice(0,100)});
};
