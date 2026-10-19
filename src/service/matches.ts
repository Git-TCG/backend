import {randomInt,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import type {Env} from '../config/env.js';
import {SAMPLE_CARDS,SAMPLE_DECKS} from '../cards/samples.js';
import {applyAction,createMatch,viewFor,legalActions,type Action,type CardDef,type MatchState,type PlayerIndex} from '../engine/index.js';
import {requireUser} from './auth.js';
import {enqueue,transaction} from './db.js';

const queueInput=z.object({deck:z.enum(['owned','trial'])});
const commandInput=z.object({commandId:z.uuid(),expectedSeq:z.number().int().nonnegative(),action:z.object({type:z.string()}).passthrough()});
function bad(message:string,statusCode=400):never{throw Object.assign(new Error(message),{statusCode});}
async function deckFor(c:pg.PoolClient,userId:string,kind:string,seat:0|1){
 if(kind==='trial')return {ids:SAMPLE_DECKS[seat],cards:SAMPLE_CARDS};
 const d=await c.query('SELECT repo_ids FROM decks WHERE user_id=$1',[userId]);const ids=d.rows[0]?.repo_ids?.map(String) as string[]|undefined;
 if(!ids||ids.length!==7||new Set(ids).size!==7)bad('현재 덱에 7장을 저장하세요',409);
 const r=await c.query(`SELECT uc.repo_id,v.card FROM user_cards uc JOIN card_versions v ON v.repo_id=uc.repo_id AND v.season_id=(SELECT id FROM seasons WHERE active) AND v.status='ready' WHERE uc.user_id=$1 AND uc.repo_id=ANY($2::bigint[])`,[userId,ids]);
 if(r.rowCount!==7)bad('현재 시즌에 사용할 수 없는 카드가 있습니다',409);
 return {ids,cards:Object.fromEntries(r.rows.map(row=>[String(row.repo_id),row.card as CardDef]))};
}
function safe(state:MatchState,seat:PlayerIndex){
 const view=viewFor(state,seat),ids=new Set([...state.players[seat].hand,...state.players[seat].discard,...state.players[seat].field.filter(Boolean).map(x=>x!.cardId),...state.players[1-seat as PlayerIndex].discard,...state.players[1-seat as PlayerIndex].field.filter(Boolean).map(x=>x!.cardId),...(view.pending?.options||[])]);
 return {view,cards:Object.fromEntries([...ids].map(id=>[id,state.cards[id]]).filter(([,v])=>!!v)),legal:legalActions(state,seat)};
}
async function grant(c:pg.PoolClient,userId:string,key:string,kind:string,repoId?:string){
 const r=await c.query('INSERT INTO reward_grants(user_id,grant_key,repo_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id',[userId,key,repoId||null,kind]);return !!r.rowCount;
}
async function finish(c:pg.PoolClient,row:any,state:MatchState){
 if(!state.result||row.rewarded)return;
 await c.query('UPDATE matches SET rewarded=true,ended_at=now() WHERE id=$1',[row.id]);
 if(row.actions0<1||row.actions1<1||state.turn<4)return;
 for(const [userId,opponent] of [[row.player0,row.player1],[row.player1,row.player0]]){
  const cap=await c.query(`INSERT INTO normal_opponents(user_id,opponent_id,day,count) VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,1)
   ON CONFLICT(user_id,opponent_id,day) DO UPDATE SET count=normal_opponents.count+1 WHERE normal_opponents.count<3 RETURNING count`,[userId,opponent]);
  if(!cap.rowCount)continue;
  const count=await c.query('UPDATE users SET normal_matches=normal_matches+1 WHERE id=$1 RETURNING normal_matches',[userId]);
  for(const threshold of [3,7])if(count.rows[0].normal_matches===threshold)await milestone(c,userId,`matches:${threshold}`);
  const day=(await c.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0].day;
  if(await grant(c,userId,`daily:${day}`,'token'))await c.query('UPDATE users SET tokens=tokens+1 WHERE id=$1',[userId]);
 }
}
export async function milestone(c:pg.PoolClient,userId:string,key:string){
 const exists=await c.query('SELECT 1 FROM reward_grants WHERE user_id=$1 AND grant_key=$2',[userId,key]);if(exists.rowCount)return;
 const own=await c.query(`SELECT a.repo_id FROM allocations a WHERE a.user_id=$1 AND a.bucket='personal' AND NOT EXISTS(SELECT 1 FROM user_cards uc WHERE uc.user_id=$1 AND uc.repo_id=a.repo_id) ORDER BY a.position LIMIT 1`,[userId]);
 let repoId=own.rows[0]?.repo_id;
 if(!repoId){const publicCard=await c.query(`SELECT p.repo_id FROM pool_memberships p JOIN card_versions v ON v.repo_id=p.repo_id AND v.season_id=(SELECT id FROM seasons WHERE active) AND v.status='ready' WHERE p.active AND p.pool='general' AND NOT EXISTS(SELECT 1 FROM user_cards uc WHERE uc.user_id=$1 AND uc.repo_id=p.repo_id) ORDER BY random() LIMIT 1`,[userId]);repoId=publicCard.rows[0]?.repo_id;}
 if(repoId){if(await grant(c,userId,key,'card',repoId)){await c.query('INSERT INTO user_cards(user_id,repo_id,source) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[userId,repoId,key]);await enqueue(c,'card',`card:${repoId}:1`,{repoId:Number(repoId)});}}
 else {if(await grant(c,userId,key,'cosmetic'))await c.query('UPDATE users SET cosmetics=cosmetics+1 WHERE id=$1',[userId]);}
}
async function progressTimeout(c:pg.PoolClient,row:any){
 let state=row.state as MatchState,deadline=new Date(row.deadline).getTime(),changed=false;
 for(let steps=0;steps<4&&!state.result&&deadline<=Date.now();steps++){
  let seat=state.active,action:Action;
  if(state.phase==='mulligan'){
   seat=(!state.players[0].mulliganDone?0:1);action={type:'mulligan',cardIds:[]};
  }else if(state.pending){seat=state.pending.player;action={type:'choose',cardId:state.pending.options[0]!};}
  else {const col=seat===0?'idle0':'idle1';row[col]++;
   action=row[col]>=2?{type:'concede'}:{type:'endTurn'};
  }
  const result=applyAction(state,seat,action);if(!result.ok)break;
  state=result.state;deadline+=45000;changed=true;
 }
 if(changed){await c.query('UPDATE matches SET state=$2,seq=$3,deadline=$4,idle0=$5,idle1=$6 WHERE id=$1',[row.id,JSON.stringify(state),state.seq,new Date(deadline),row.idle0,row.idle1]);await finish(c,row,state);row.state=state;row.seq=state.seq;row.deadline=new Date(deadline);}
 return row;
}
export function registerMatches(app:FastifyInstance,pool:pg.Pool,env:Env){
 app.post('/api/queue',async req=>{const u=await requireUser(req,pool,env,true);const {deck}=queueInput.parse(req.body);
  return transaction(pool,async c=>{
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[u.id]);
   const active=await c.query('SELECT id FROM matches WHERE (player0=$1 OR player1=$1) AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1',[u.id]);if(active.rowCount)return {matchId:active.rows[0].id};
   await deckFor(c,u.id,deck,0);
   const waiting=await c.query('SELECT user_id,deck_kind FROM queue_entries WHERE user_id<>$1 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1',[u.id]);
   if(!waiting.rowCount){await c.query('INSERT INTO queue_entries(user_id,deck_kind) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET deck_kind=EXCLUDED.deck_kind',[u.id,deck]);return {waiting:true};}
   const opponent=waiting.rows[0];const left=await deckFor(c,String(opponent.user_id),opponent.deck_kind,0),right=await deckFor(c,u.id,deck,1);
   const cards={...left.cards,...right.cards};const state=createMatch({cards,decks:[left.ids,right.ids],seed:randomInt(1,2147483647)});
   const id=randomUUID();await c.query('INSERT INTO matches(id,player0,player1,state,seq,deadline) VALUES($1,$2,$3,$4,$5,now()+interval \'45 seconds\')',[id,opponent.user_id,u.id,JSON.stringify(state),state.seq]);
   await c.query('DELETE FROM queue_entries WHERE user_id IN ($1,$2)',[u.id,opponent.user_id]);return {matchId:id};
  });
 });
 app.delete('/api/queue',async req=>{const u=await requireUser(req,pool,env,true);await pool.query('DELETE FROM queue_entries WHERE user_id=$1',[u.id]);return {ok:true};});
 app.get('/api/queue',async req=>{const u=await requireUser(req,pool,env);const [waiting,match]=await Promise.all([pool.query('SELECT 1 FROM queue_entries WHERE user_id=$1',[u.id]),pool.query('SELECT id FROM matches WHERE (player0=$1 OR player1=$1) AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1',[u.id])]);return {waiting:!!waiting.rowCount,matchId:match.rows[0]?.id||null};});
 app.get('/api/matches/:id',async req=>{const u=await requireUser(req,pool,env);const id=z.uuid().parse((req.params as any).id);
  return transaction(pool,async c=>{const r=await c.query('SELECT * FROM matches WHERE id=$1 AND (player0=$2 OR player1=$2) FOR UPDATE',[id,u.id]);if(!r.rowCount)bad('경기를 찾을 수 없습니다',404);const row=await progressTimeout(c,r.rows[0]);const seat=String(row.player0)===String(u.id)?0:1;return {id,deadline:row.deadline,...safe(row.state,seat)};});
 });
 app.post('/api/matches/:id/actions',async req=>{const u=await requireUser(req,pool,env,true);const id=z.uuid().parse((req.params as any).id);const body=commandInput.parse(req.body);
  return transaction(pool,async c=>{
   const r=await c.query('SELECT * FROM matches WHERE id=$1 AND (player0=$2 OR player1=$2) FOR UPDATE',[id,u.id]);if(!r.rowCount)bad('경기를 찾을 수 없습니다',404);
   const repeat=await c.query('SELECT response FROM match_commands WHERE match_id=$1 AND user_id=$2 AND command_id=$3',[id,u.id,body.commandId]);if(repeat.rowCount)return repeat.rows[0].response;
   const row=await progressTimeout(c,r.rows[0]);if(row.seq!==body.expectedSeq)bad('경기 상태가 갱신되었습니다',409);
   const seat:PlayerIndex=String(row.player0)===String(u.id)?0:1;
   const result=applyAction(row.state,seat,body.action as Action);if(!result.ok)bad(result.error,400);
   if(seat===0){if(["deploy","attack","scrap"].includes(body.action.type))row.actions0++;row.idle0=0;}else{if(["deploy","attack","scrap"].includes(body.action.type))row.actions1++;row.idle1=0;}
   const deadline=row.state.active!==result.state.active||row.state.phase==='mulligan'&&result.state.phase!=='mulligan'?new Date(Date.now()+45000):row.deadline;
   await c.query('UPDATE matches SET state=$2,seq=$3,deadline=$4,actions0=$5,actions1=$6,idle0=$7,idle1=$8 WHERE id=$1',[id,JSON.stringify(result.state),result.state.seq,deadline,row.actions0,row.actions1,row.idle0,row.idle1]);
   await finish(c,row,result.state);
   const response={id,deadline,...safe(result.state,seat)};
   await c.query('INSERT INTO match_commands(match_id,user_id,command_id,seq,response) VALUES($1,$2,$3,$4,$5)',[id,u.id,body.commandId,result.state.seq,JSON.stringify(response)]);
   return response;
  });
 });
}
