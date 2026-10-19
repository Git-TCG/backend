import type pg from 'pg';
export type Sql = Pick<pg.PoolClient,'query'>;
export async function transaction<T>(pool:pg.Pool,fn:(c:pg.PoolClient)=>Promise<T>):Promise<T> {
  const c=await pool.connect();
  try {await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function enqueue(q:Sql,kind:string,key:string,payload:unknown) {
  await q.query("INSERT INTO jobs(kind,key,payload) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET status=CASE WHEN jobs.status='error' THEN 'queued' ELSE jobs.status END,available_at=now()",[kind,key,JSON.stringify(payload)]);
}
export function shuffle<T>(input:T[]):T[]{
  const a=[...input];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j]!,a[i]!];}
  return a;
}
export async function fillStarter(pool:pg.Pool,userId:string|number){
 await transaction(pool,async c=>{
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
  const own=await c.query('SELECT repo_id FROM user_cards WHERE user_id=$1',[userId]);const needed=7-own.rowCount!;if(needed<=0)return;
  const rows=await c.query(`SELECT p.repo_id FROM pool_memberships p JOIN card_versions v ON v.repo_id=p.repo_id AND v.season_id=(SELECT id FROM seasons WHERE active) AND v.status='ready'
   WHERE p.pool='general' AND p.active AND NOT EXISTS(SELECT 1 FROM user_cards u WHERE u.user_id=$1 AND u.repo_id=p.repo_id) ORDER BY random() LIMIT $2`,[userId,needed]);
  for(const row of rows.rows)await c.query("INSERT INTO user_cards(user_id,repo_id,source) VALUES($1,$2,'starter pool') ON CONFLICT DO NOTHING",[userId,row.repo_id]);
 });
}
