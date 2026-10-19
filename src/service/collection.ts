import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import type {Env} from '../config/env.js';
import {SAMPLE_CARDS,SAMPLE_DECKS} from '../cards/samples.js';
import {requireUser} from './auth.js';
import {enqueue,transaction,fillStarter} from './db.js';
import {github,type GithubRepo} from './providers.js';

const deckSchema=z.object({repoIds:z.array(z.number().int().positive()).length(7)});
export function registerCollection(app:FastifyInstance,pool:pg.Pool,env:Env){
 app.get('/api/status',async req=>{
  const u=await requireUser(req,pool,env);const [jobs,counts,poolCount]=await Promise.all([
   pool.query("SELECT id,kind,status,attempts,last_error FROM jobs WHERE key=$1 OR key IN (SELECT 'card:'||repo_id||':1' FROM allocations WHERE user_id=$2 AND bucket='initial') ORDER BY id",[`collect:${u.id}`,u.id]),
   pool.query("SELECT count(*)::int AS owned,count(*) FILTER(WHERE v.status='ready')::int AS ready FROM user_cards c LEFT JOIN card_versions v ON v.repo_id=c.repo_id AND v.season_id=(SELECT id FROM seasons WHERE active) WHERE c.user_id=$1",[u.id]),
   pool.query("SELECT count(*)::int AS count FROM pool_memberships p JOIN card_versions v ON v.repo_id=p.repo_id AND v.status='ready' AND v.season_id=(SELECT id FROM seasons WHERE active) WHERE p.pool='general' AND p.active")]);
  return {consent:!!u.consent_at,allocated:!!u.allocation_at,jobs:jobs.rows,owned:counts.rows[0],poolReady:poolCount.rows[0].count,canPlay:counts.rows[0].ready>=7};
 });
 app.post('/api/status/retry',async req=>{const u=await requireUser(req,pool,env,true);
  await transaction(pool,async c=>{
   if(!u.consent_at)throw Object.assign(new Error('카드 이용 동의가 필요합니다'),{statusCode:409});
   if(!u.allocation_at)await enqueue(c,'collect',`collect:${u.id}`,{userId:Number(u.id),login:u.login});
   const r=await c.query("SELECT repo_id FROM allocations WHERE user_id=$1 AND bucket='initial'",[u.id]);
   for(const row of r.rows)await enqueue(c,'card',`card:${row.repo_id}:1`,{repoId:Number(row.repo_id)});
  });return {ok:true};
 });
 app.get('/api/collection',async req=>{
  const u=await requireUser(req,pool,env);
  const r=await pool.query(`SELECT r.id,r.name,r.url,r.owner_login,r.description,c.source,v.status,v.card,v.grade,v.classification,v.reason
  FROM user_cards c JOIN repositories r ON r.id=c.repo_id LEFT JOIN card_versions v ON v.repo_id=r.id AND v.season_id=(SELECT id FROM seasons WHERE active)
  WHERE c.user_id=$1 ORDER BY c.created_at,r.id`,[u.id]);return {cards:r.rows};
 });
 app.get('/api/cards/:id',async req=>{
  const u=await requireUser(req,pool,env);const id=z.coerce.number().int().positive().parse((req.params as any).id);
  const r=await pool.query(`SELECT r.id,r.name,r.url,r.owner_login,r.description,v.status,v.card,v.grade,v.classification,v.reason,v.season_id
   FROM repositories r JOIN card_versions v ON v.repo_id=r.id WHERE r.id=$1 AND (EXISTS(SELECT 1 FROM user_cards WHERE user_id=$2 AND repo_id=r.id) OR EXISTS(SELECT 1 FROM pool_memberships WHERE repo_id=r.id AND active)) ORDER BY v.season_id DESC`,[id,u.id]);
  if(!r.rowCount)throw Object.assign(new Error('카드를 찾을 수 없습니다'),{statusCode:404});return {versions:r.rows};
 });
 app.get('/api/deck',async req=>{const u=await requireUser(req,pool,env);const r=await pool.query('SELECT repo_ids FROM decks WHERE user_id=$1',[u.id]);return {repoIds:r.rows[0]?.repo_ids||[]};});
 app.put('/api/deck',async req=>{const u=await requireUser(req,pool,env,true);const {repoIds}=deckSchema.parse(req.body);
  if(new Set(repoIds).size!==7)throw Object.assign(new Error('서로 다른 Repo 7장이 필요합니다'),{statusCode:400});
  await transaction(pool,async c=>{
   const r=await c.query(`SELECT count(*)::int AS count FROM user_cards uc JOIN card_versions v ON v.repo_id=uc.repo_id AND v.season_id=(SELECT id FROM seasons WHERE active) AND v.status='ready' WHERE uc.user_id=$1 AND uc.repo_id=ANY($2::bigint[])`,[u.id,repoIds]);
   if(r.rows[0].count!==7)throw Object.assign(new Error('보유한 현재 시즌 카드 7장을 선택하세요'),{statusCode:400});
   await c.query('INSERT INTO decks(user_id,repo_ids) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET repo_ids=EXCLUDED.repo_ids,updated_at=now()',[u.id,repoIds]);
  });return {ok:true};
 });
 app.get('/api/trial',async()=>({cards:SAMPLE_CARDS,decks:SAMPLE_DECKS,description:'가상 프로젝트 체험 덱. 실제 GitHub Repo 카드가 아닙니다.'}));
 app.get('/api/admin/pool',async req=>{const u=await requireUser(req,pool,env);admin(u,env);
  const r=await pool.query(`SELECT r.id,r.name,r.url,p.pool,p.active,p.weight,p.source,v.status,v.card,v.reason FROM pool_memberships p JOIN repositories r ON r.id=p.repo_id LEFT JOIN card_versions v ON v.repo_id=r.id AND v.season_id=(SELECT id FROM seasons WHERE active) ORDER BY r.id`);return {pool:r.rows};
 });
 app.post('/api/admin/repositories',async req=>{const u=await requireUser(req,pool,env,true);admin(u,env);
  const {url}=z.object({url:z.url()}).parse(req.body);const parsed=new URL(url);
  if(parsed.hostname!=='github.com'||parsed.protocol!=='https:'||!/^\/[^/]+\/[^/]+\/?$/.test(parsed.pathname))throw Object.assign(new Error('GitHub Repo URL만 허용합니다'),{statusCode:400});
  if(!env.GITHUB_CLASSIC_TOKEN)throw new Error('GitHub 앱 토큰 미설정');
  const parts=parsed.pathname.split('/').filter(Boolean);const repo=await github(`/repos/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`,env.GITHUB_CLASSIC_TOKEN) as GithubRepo;
  if(repo.private||repo.fork||repo.size===0)throw Object.assign(new Error('공개된 비어 있지 않은 원본 Repo만 허용합니다'),{statusCode:400});
  await transaction(pool,async c=>{
   await c.query(`INSERT INTO repositories(id,owner_id,owner_login,name,url,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,url=EXCLUDED.url,description=EXCLUDED.description,metadata=EXCLUDED.metadata,updated_at=now()`,[repo.id,repo.owner.id,repo.owner.login,repo.name,repo.html_url,repo.description,JSON.stringify(repo)]);
   await c.query("INSERT INTO pool_memberships(repo_id,pool,source) VALUES($1,'general','admin') ON CONFLICT DO NOTHING",[repo.id]);
   await enqueue(c,'card',`card:${repo.id}:1`,{repoId:repo.id});
  });return {id:repo.id,status:'pending'};
 });
 app.post('/api/admin/pool/:id/publish',async req=>{const u=await requireUser(req,pool,env,true);admin(u,env);const id=z.coerce.number().int().positive().parse((req.params as any).id);
  const r=await pool.query(`UPDATE pool_memberships SET active=true WHERE repo_id=$1 AND pool='general' AND EXISTS(SELECT 1 FROM card_versions WHERE repo_id=$1 AND season_id=(SELECT id FROM seasons WHERE active) AND status='ready') RETURNING repo_id`,[id]);
  if(!r.rowCount)throw Object.assign(new Error('준비된 카드가 없습니다'),{statusCode:409});
  const wait=await pool.query('SELECT id FROM users WHERE allocation_at IS NOT NULL AND (SELECT count(*) FROM user_cards WHERE user_id=users.id)<7');for(const user of wait.rows)await fillStarter(pool,user.id);return {ok:true};
 });
 app.post('/api/admin/season',async req=>{const u=await requireUser(req,pool,env,true);admin(u,env);
  const result=await transaction(pool,async c=>{
   const pending=await c.query(`SELECT count(*)::int AS count FROM pool_memberships p LEFT JOIN card_versions v ON v.repo_id=p.repo_id AND v.season_id=(SELECT id FROM seasons WHERE active)+1 WHERE p.active AND v.status IS DISTINCT FROM 'ready'`);
   if(pending.rows[0].count)throw Object.assign(new Error('새 시즌 카드가 준비되지 않았습니다'),{statusCode:409});
   const n=await c.query('SELECT id FROM seasons WHERE active FOR UPDATE');const next=n.rows[0].id+1;
   await c.query('UPDATE seasons SET active=false WHERE active');await c.query('INSERT INTO seasons(id,active) VALUES($1,true)',[next]);return next;
  });return {season:result};
 });
}
function admin(user:any,env:Env){const ids=env.ADMIN_GITHUB_IDS;if(!ids.includes(String(user.id)))throw Object.assign(new Error('관리자 권한이 필요합니다'),{statusCode:403});}
