import { getStore } from '@netlify/blobs';

const json = (body, status=200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

export default async (req) => {
  if (req.method !== 'GET') return json({error:'GET required'},405);
  const store = getStore({name:'soundpaid', consistency:'strong'});
  const url = new URL(req.url);
  const wallet = url.searchParams.get('wallet')?.trim();

  if (wallet) {
    const artist = await store.get(`artist/${wallet}`, {type:'json'});
    if (!artist || artist.status !== 'verified') return json({verified:false},404);
    return json({verified:true, artist});
  }

  const { blobs } = await store.list({prefix:'artist/'});
  const artists = [];
  for (const blob of blobs.slice(0,250)) {
    const artist = await store.get(blob.key,{type:'json'});
    if (artist?.status === 'verified') artists.push(artist);
  }
  artists.sort((a,b)=>b.verifiedAt-a.verifiedAt);
  return json({artists});
};
