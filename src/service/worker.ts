import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import { collectRepos,generateCard,type GithubRepo } from './providers.js';
import { enqueue,shuffle,transaction,fillStarter } from './db.js';
import type pg from 'pg';

const env=loadEnv();const {pool}=createDb(env.DATABASE_URL);await runMigrations(pool);
async function run(job:{id:number;kind:string;payload:any;attempts:number}) {
 if(job.kind==='collect') {
  if(!env.GITHUB_CLASSIC_TOKEN) throw new Error('GitHub 앱 토큰 미설정');
  const {userId,login}=job.payload;
  const repos=await collectRepos(userId,login,env.GITHUB_CLASSIC_TOKEN);
  await transaction(pool,async c=>{
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
   const done=await c.query('SELECT allocation_at FROM users WHERE id=$1',[userId]);
   if(done.rows[0]?.allocation_at) return;
   const sorted=shuffle(repos);
   for(let i=0;i<sorted.length;i++){
    const r=sorted[i]!;await upsertRepo(c,r);
    const bucket=i<7?'initial':i<10?'personal':'public';
    await c.query('INSERT INTO allocations(user_id,repo_id,position,bucket) VALUES($1,$2,$3,$4)',[userId,r.id,i,bucket]);
    if(bucket==='initial') await c.query("INSERT INTO user_cards(user_id,repo_id,source) VALUES($1,$2,'initial') ON CONFLICT DO NOTHING",[userId,r.id]);
    if(bucket==='public') await c.query("INSERT INTO pool_memberships(repo_id,pool,source) VALUES($1,'general','owner overflow') ON CONFLICT DO NOTHING",[r.id]);
    if(bucket==='initial') await enqueue(c,'card',`card:${r.id}:1`,{repoId:r.id});
   }
   await c.query('UPDATE users SET allocation_at=now() WHERE id=$1',[userId]);
  });
  await fillStarter(pool,userId);
 } else if(job.kind==='card') {
  const repoId=job.payload.repoId;
  const row=await pool.query('SELECT metadata FROM repositories WHERE id=$1',[repoId]);
  if(!row.rowCount) throw new Error('Repo 없음');
  const card=await generateCard(row.rows[0].metadata as GithubRepo,env);
  await pool.query(`INSERT INTO card_versions(repo_id,season_id,status,card,grade,classification,reason) VALUES($1,(SELECT id FROM seasons WHERE active),$2,$3,$4,$5,$6)
   ON CONFLICT(repo_id,season_id) DO UPDATE SET status=EXCLUDED.status,card=EXCLUDED.card,grade=EXCLUDED.grade,classification=EXCLUDED.classification,reason=EXCLUDED.reason`,[repoId,card.status,JSON.stringify(card.card),JSON.stringify(card.grade),JSON.stringify(card.classification),card.reason]);
  if(card.status==='ready'){const wait=await pool.query('SELECT id FROM users WHERE allocation_at IS NOT NULL AND (SELECT count(*) FROM user_cards WHERE user_id=users.id)<7');for(const u of wait.rows)await fillStarter(pool,u.id);}
 } else throw new Error('알 수 없는 작업');
}
async function upsertRepo(c:pg.PoolClient,r:GithubRepo) {
 await c.query(`INSERT INTO repositories(id,owner_id,owner_login,name,url,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(id) DO UPDATE SET owner_id=EXCLUDED.owner_id,owner_login=EXCLUDED.owner_login,name=EXCLUDED.name,url=EXCLUDED.url,description=EXCLUDED.description,metadata=EXCLUDED.metadata,updated_at=now()`,[r.id,r.owner.id,r.owner.login,r.name,r.html_url,r.description,JSON.stringify(r)]);
}
async function tick(){
 const claim=await transaction(pool,async c=>{
  const r=await c.query("SELECT id,kind,payload,attempts FROM jobs WHERE (status='queued' OR (status='running' AND locked_at<now()-interval '3 minutes')) AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");
  if(!r.rowCount)return null;
  const job=r.rows[0];await c.query("UPDATE jobs SET status='running',locked_at=now(),attempts=attempts+1 WHERE id=$1",[job.id]);return job;
 });
 if(!claim)return;
 try {await run(claim);await pool.query("UPDATE jobs SET status='done',last_error=NULL WHERE id=$1",[claim.id]);}
 catch(e){const reason=e instanceof Error?e.message:'작업 실패';await pool.query("UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'error' ELSE 'queued' END,available_at=now()+interval '30 seconds'*least(attempts,5),last_error=$2 WHERE id=$1",[claim.id,reason]);}
}
let stopping=false;for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{stopping=true;});
while(!stopping){try{await tick();}catch(e){console.error('worker tick failed',e instanceof Error?e.message:'unknown');}await new Promise(r=>setTimeout(r,1000));}
await pool.end();
