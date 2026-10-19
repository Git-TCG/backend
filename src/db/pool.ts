import pg from "pg";

// pg 타입 정의의 TypeId 열거형에는 배열 OID가 없어서 숫자를 그대로 넘긴다.
type Oid = Parameters<typeof pg.types.setTypeParser>[0];
const TEXT_ARRAY = 1009 as unknown as Oid;
const INT8_ARRAY = 1016 as unknown as Oid;

function toSafeInteger(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint 범위 초과: ${v}`);
  return n;
}

// bigint(GitHub ID, count(*))를 문자열이 아닌 숫자로 받는다. GitHub ID는 안전한 정수 범위 안에 있다.
pg.types.setTypeParser(pg.types.builtins.INT8, toSafeInteger);
const parseTextArray = pg.types.getTypeParser(TEXT_ARRAY);
pg.types.setTypeParser(INT8_ARRAY, (v: string) =>
  (parseTextArray(v) as (string | null)[]).map((x) => (x === null ? null : toSafeInteger(x))),
);

export function createPool(databaseUrl: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max });
}

/** 풀 또는 트랜잭션 클라이언트. */
export type Queryable = Pick<pg.PoolClient, "query">;

export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
