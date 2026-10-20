import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildCardDefinition } from "../cards/build.js";
import { transaction } from "../db/pool.js";
import { createUser, loginAs, testServer } from "../test/app.js";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";
import { awardGrowth, grownCard, growthInfo } from "./growth.js";
import { loadDeck } from "./matches.js";

const base = buildCardDefinition({ id: "70", name: "테스트", grade: "C", role: "attack", tags: [] });
it("승급은 기존 능력을 유지하고 등급별 비용·능력치를 적용한다", () => {
  const upgraded = grownCard(base, 4);
  expect(upgraded.grade).toBe("SS");
  expect(upgraded.cost).toBe(5);
  expect(upgraded.ability!.effect).toBe(base.ability!.effect);
  expect(base.grade).toBe("C");
  expect(grownCard(upgraded, 1)).toBe(upgraded);
  expect(growthInfo(upgraded, 4).nextGrade).toBeNull();
});

describeDb("카드 성장", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    for (const user of [7, 8]) await createUser(db.pool, user, { consent: true, allocated: true });
    for (let id = 70; id < 77; id++) {
      await db.pool.query(`INSERT INTO repositories (id, owner_id, owner_login, owner_type, name, full_name, url, default_branch, metadata)
        VALUES ($1, 7, 'u7', 'User', 'r', 'u7/r', 'https://github.com/u7/r', 'main', '{}')`, [id]);
      await db.pool.query("INSERT INTO card_versions (repo_id, season_id, status, card) VALUES ($1, 1, 'ready', $2)", [id, JSON.stringify({ ...base, id: String(id) })]);
      for (const user of [7, 8]) await db.pool.query("INSERT INTO user_cards (user_id, repo_id, source) VALUES ($1, $2, 'initial')", [user, id]);
    }
    for (const user of [7, 8]) await db.pool.query("INSERT INTO decks (user_id, repo_ids) VALUES ($1, '{70,71,72,73,74,75,76}')", [user]);
  });
  afterAll(async () => db?.drop());

  it("연습 보상은 중복 없이 하루 3회까지만 지급한다", async () => {
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      await db.pool.query(`INSERT INTO matches (id, mode, season_id, player0, player1, deck0, deck1, state, seq, deadline)
        VALUES ($1, 'bot', 1, 7, 0, 'trial', 'trial', '{}', 0, now())`, [id]);
      await transaction(db.pool, async c => { await awardGrowth(c, 7, id, true); await awardGrowth(c, 7, id, true); });
    }
    expect((await db.pool.query("SELECT growth_points FROM users WHERE id = 7")).rows[0].growth_points).toBe(15);
  });

  it("승급 요청의 권한·잔액·중복을 검증하고 양쪽 덱을 분리한다", async () => {
    const app = await testServer(db.pool);
    try {
      const client = await loginAs(app, db.pool, 7);
      expect((await client.post('/api/cards/70/upgrade', { expectedGrade: 'C' })).statusCode).toBe(400);
      await db.pool.query("UPDATE users SET growth_points = 500 WHERE id = 7");
      const results = await Promise.all([client.post('/api/cards/70/upgrade', { expectedGrade: 'C' }), client.post('/api/cards/70/upgrade', { expectedGrade: 'C' })]);
      expect(results.map(r => r.statusCode).sort()).toEqual([200, 400]);
      expect((await db.pool.query("SELECT growth_points FROM users WHERE id = 7")).rows[0].growth_points).toBe(450);
      expect((await client.post('/api/cards/999/upgrade', { expectedGrade: 'C' })).statusCode).toBe(404);
      const a = await loadDeck(db.pool, 7, 'owned', 0);
      const b = await loadDeck(db.pool, 8, 'owned', 1);
      expect(a.cards['7:70']!.grade).toBe('B');
      expect(b.cards['8:70']!.grade).toBe('C');
      expect(Object.keys({ ...a.cards, ...b.cards })).toHaveLength(14);
      const collection = (await client.get('/api/collection')).json();
      expect(collection.cards[0].card.grade).toBe('B');
      expect(collection.cards[0].growth.cost).toBe(100);
      expect((await app.inject({ method: 'POST', url: '/api/cards/70/upgrade', payload: { expectedGrade: 'B' } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
