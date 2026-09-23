import { verifySoundCloudArtist } from '../lib/soundcloud.js';

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res,405,{error:'POST required'});
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const result = await verifySoundCloudArtist(body.soundcloudUrl);
    return send(res,200,{verified:true,...result});
  } catch (error) {
    return send(res,400,{verified:false,error:error.message || 'Artist verification failed'});
  }
}
