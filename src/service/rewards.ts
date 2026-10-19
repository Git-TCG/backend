import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import type {Env} from '../config/env.js';
import {requireUser} from './auth.js';
import {enqueue,transaction} from './db.js';
import {milestone} from './matches.js';

export function registerRewards(app:FastifyInstance,pool:pg.Pool,env:Env){
 app.post('/api/tutorial/complete',async req=>{const u=await requireUser(req,pool,env,true);await transaction(pool,async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[u.id]);await milestone(c,u.id,'tutorial');});return {ok:true};});
 app.get('/api/discovery',async req=>{const u=await requireUser(req,pool,env);const r=await pool.query('SELECT id,options FROM discoveries WHERE user_id=$1 AND chosen IS NULL',[u.id]);return {tokens:u.tokens,cosmetics:u.cosmetics,open:r.rows[0]||null};});
 app.post('/api/discovery',async req=>{const u=await requireUser(req,pool,env,true);return transaction(pool,async c=>{
  const user=await c.query('SELECT tokens,cosmetics FROM users WHERE id=$1 FOR UPDATE',[u.id]);
  const pending=await c.query('SELECT id,options FROM discoveries WHERE user_id=$1 AND chosen IS NULL',[u.id]);if(pending.rowCount)return {open:pending.rows[0],tokens:user.rows[0].tokens};
  if(user.rows[0].tokens<3)throw Object.assign(new Error('발견 토큰 3개가 필요합니다'),{statusCode:409});
  const personal=await c.query(`SELECT a.repo_id FROM allocations a WHERE a.user_id=$1 AND a.bucket='personal' AND NOT EXISTS(SELECT 1 FROM user_cards uc WHERE uc.user_id=$1 AND uc.repo_id=a.repo_id) ORDER BY a.position LIMIT 3`,[u.id]);
  const candidates=personal.rows.map(r=>String(r.repo_id));
  const publicRows=await c.query(`SELECT p.repo_id FROM pool_memberships p JOIN card_versions v ON v.repo_id=p.repo_id AND v.season_id=(SELECT id FROM seasons WHERE active) AND v.status='ready' WHERE p.active AND p.pool='general' AND NOT EXISTS(SELECT 1 FROM user_cards uc WHERE uc.user_id=$1 AND uc.repo_id=p.repo_id) AND NOT(p.repo_id=ANY($2::bigint[])) ORDER BY random() LIMIT $3`,[u.id,candidates,3-candidates.length]);
  candidates.push(...publicRows.rows.map(r=>String(r.repo_id)));
  await c.query('UPDATE users SET tokens=tokens-3 WHERE id=$1',[u.id]);
  if(!candidates.length){await c.query('UPDATE users SET cosmetics=cosmetics+1 WHERE id=$1',[u.id]);return {open:null,cosmetic:true};}
  const r=await c.query('INSERT INTO discoveries(user_id,options) VALUES($1,$2::bigint[]) RETURNING id,options',[u.id,candidates]);return {open:r.rows[0]};
 });});
 app.post('/api/discovery/:id/choose',async req=>{const u=await requireUser(req,pool,env,true);const id=z.coerce.number().int().positive().parse((req.params as any).id);const {repoId}=z.object({repoId:z.coerce.number().int().positive()}).parse(req.body);
  return transaction(pool,async c=>{
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[u.id]);
   const r=await c.query('SELECT * FROM discoveries WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,u.id]);if(!r.rowCount)throw Object.assign(new Error('발견을 찾을 수 없습니다'),{statusCode:404});
   if(r.rows[0].chosen)return {repoId:r.rows[0].chosen};
   if(!r.rows[0].options.map(String).includes(String(repoId)))throw Object.assign(new Error('후보에 없는 카드입니다'),{statusCode:400});
   await c.query('UPDATE discoveries SET chosen=$2 WHERE id=$1',[id,repoId]);
   await c.query("INSERT INTO user_cards(user_id,repo_id,source) VALUES($1,$2,'discovery') ON CONFLICT DO NOTHING",[u.id,repoId]);await enqueue(c,'card',`card:${repoId}:1`,{repoId});
   return {repoId};
  });
 });
}
