import {createHash,randomBytes} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import type {Env} from '../config/env.js';
import {exchangeCode,github} from './providers.js';
import {enqueue,transaction} from './db.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
function cookies(req:FastifyRequest){return Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=',2)).filter(p=>p.length===2));}
export function allowedOrigins(env:Env):string[] {
 return env.CORS_ORIGINS.flatMap(s=>{
  if(/^https?:\/\//.test(s)){const u=new URL(s);return u.pathname==='/'&&!u.search&&!u.hash?[u.origin]:[];}
  if(/^(localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+)(:\d+)?$/i.test(s)) return [`http://${s.includes(':')?s:s+':8123'}`,`https://${s.includes(':')?s:s+':8123'}`];
  return [];
 });
}
function requestOrigin(req:FastifyRequest,env:Env) {
 const origin=req.headers.origin;
 if(origin&&allowedOrigins(env).includes(origin)) return origin;
 const host=req.headers.host;const result=`http://${host}`;
 if(host&&allowedOrigins(env).includes(result))return result;
 throw new Error('허용되지 않은 서비스 주소');
}
export async function currentUser(req:FastifyRequest,pool:pg.Pool){
 const token=cookies(req).tcg_session;if(!token)return null;
 const r=await pool.query('SELECT u.*,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[hash(token)]);
 return r.rows[0]||null;
}
export async function requireUser(req:FastifyRequest,pool:pg.Pool,env:Env,write=false){
 const user=await currentUser(req,pool);if(!user)throw Object.assign(new Error('로그인이 필요합니다'),{statusCode:401});
 if(write){
  const origin=req.headers.origin;
  if(!origin||!allowedOrigins(env).includes(origin))throw Object.assign(new Error('허용되지 않은 요청 출처'),{statusCode:403});
  const csrf=req.headers['x-csrf-token'];if(typeof csrf!=='string'||hash(csrf)!==user.csrf_hash)throw Object.assign(new Error('CSRF 토큰 오류'),{statusCode:403});
 }
 return user;
}
export function registerAuth(app:FastifyInstance,pool:pg.Pool,env:Env) {
 app.get('/api/auth/github/start',async(req,reply)=>{
  const origin=requestOrigin(req,env),state=random();
  await pool.query("INSERT INTO oauth_states(state_hash,origin,expires_at) VALUES($1,$2,now()+interval '10 minutes')",[hash(state),origin]);
  const url=new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id',env.GITHUB_CLIENT_ID||'');url.searchParams.set('redirect_uri',origin+'/api/auth/github');
  url.searchParams.set('state',state);url.searchParams.set('scope','read:user');
  return reply.redirect(url.toString());
 });
 app.get('/api/auth/github',async(req,reply)=>{
  const q=req.query as {code?:string;state?:string};if(!q.code||!q.state)throw Object.assign(new Error('OAuth 응답 누락'),{statusCode:400});
  const row=await pool.query('DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING origin',[hash(q.state)]);
  if(!row.rowCount)throw Object.assign(new Error('OAuth 상태 만료 또는 중복'),{statusCode:400});
  const origin=row.rows[0].origin as string;
  if(!allowedOrigins(env).includes(origin))throw Object.assign(new Error('OAuth 출처 오류'),{statusCode:400});
  const token=await exchangeCode(env,q.code,origin+'/api/auth/github');
  const profile=await github('/user',token) as {id:number;login:string;name?:string;avatar_url?:string};
  if(!Number.isSafeInteger(profile.id)||!profile.login)throw new Error('GitHub 계정 오류');
  const session=random(),csrf=random();
  await transaction(pool,async c=>{
   await c.query('INSERT INTO users(id,login,name,avatar_url) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET login=EXCLUDED.login,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url',[profile.id,profile.login,profile.name||null,profile.avatar_url||null]);
   await c.query("INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '14 days')",[hash(session),profile.id,hash(csrf)]);
  });
  const secure=origin.startsWith('https:')?'; Secure':'';
  reply.header('Set-Cookie',`tcg_session=${session}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=1209600${secure}`);
  reply.header('Cache-Control','no-store');
  return reply.redirect(origin+'/?login=ok');
 });
 app.get('/api/me',async(req)=>{
  const user=await currentUser(req,pool);if(!user)return {user:null};
  const token=cookies(req).tcg_session;
  // CSRF token is issued separately because only authenticated same-origin callers can read it.
  const csrf=random();await pool.query('UPDATE sessions SET csrf_hash=$1 WHERE token_hash=$2',[hash(csrf),hash(token!)]);
  return {user:{id:user.id,login:user.login,name:user.name,avatar_url:user.avatar_url,consent_at:user.consent_at,allocation_at:user.allocation_at,tokens:user.tokens,cosmetics:user.cosmetics,normal_matches:user.normal_matches},csrf};
 });
 app.post('/api/consent',async(req)=>{
  const user=await requireUser(req,pool,env,true);
  await transaction(pool,async c=>{
   await c.query('UPDATE users SET consent_at=COALESCE(consent_at,now()) WHERE id=$1',[user.id]);
   await enqueue(c,'collect',`collect:${user.id}`,{userId:Number(user.id),login:user.login});
  });return {ok:true};
 });
 app.post('/api/logout',async(req,reply)=>{
  await requireUser(req,pool,env,true);const token=cookies(req).tcg_session!;
  await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hash(token)]);
  reply.header('Set-Cookie','tcg_session=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0');return {ok:true};
 });
}
