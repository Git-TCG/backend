import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SAMPLE_CARDS, SAMPLE_DECKS } from "../cards/samples.js";
import { createMatch } from "../engine/index.js";
import { createUser } from "../test/app.js";
import { createTestDatabase, describeDb, type TestDatabase } from "../test/db.js";
import { enqueueOrMatch, loadMatchForUser, playBotTurns, progressTimeouts, seatOf } from "./matches.js";

describeDb("대전·대기열", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.drop());

  it("연습 상대와 즉시 매칭되고 봇이 멀리건을 처리한다", async () => {
    const userId = 9001;
    await createUser(db.pool, userId, { consent: true, allocated: true });
    const r = await enqueueOrMatch(db.pool, userId, "trial", "bot");
    expect(r.matchId).toBeTruthy();

    const { transaction } = await import("../db/pool.js");
    await transaction(db.pool, async (c) => {
      let row = await loadMatchForUser(c, r.matchId!, userId);
      expect(row.mode).toBe("bot");
      expect(row.player1).toBe(0);
      row = await playBotTurns(c, row);
      // 플레이어가 아직 멀리건 전이면 봇만 멀리건을 끝냈을 수 있다.
      const seat = seatOf(row, userId);
      expect(seat).toBe(0);
      expect(row.state.players[1].mulliganDone || row.state.phase !== "mulligan").toBeTruthy();
    });
  });

  it("제한 시간이 지나면 턴을 대신 종료한다", async () => {
    const userId = 9002;
    await createUser(db.pool, userId, { consent: true, allocated: true });
    const state = createMatch({ cards: SAMPLE_CARDS, decks: SAMPLE_DECKS, seed: 42 });
    // 멀리건을 건너뛰고 배포 단계로 맞춘다.
    state.players[0].mulliganDone = true;
    state.players[1].mulliganDone = true;
    state.phase = "deploy";
    state.turn = 1;
    state.active = 0;
    state.seq = 2;
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO matches (id, mode, season_id, player0, player1, deck0, deck1, state, seq, deadline)
       VALUES ($1, 'bot', 1, $2, 0, 'trial', 'trial', $3, $4, now() - interval '1 second')`,
      [id, userId, JSON.stringify(state), state.seq],
    );

    const { transaction } = await import("../db/pool.js");
    await transaction(db.pool, async (c) => {
      let row = await loadMatchForUser(c, id, userId);
      row = await progressTimeouts(c, row);
      expect(row.state.seq).toBeGreaterThan(state.seq);
      expect(new Date(row.deadline).getTime()).toBeGreaterThan(Date.now() - 1000);
    });
  });
});
