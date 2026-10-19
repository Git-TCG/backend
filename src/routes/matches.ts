import { z } from "zod";
import {
  applyPlayerAction,
  enqueueOrMatch,
  loadMatchForUser,
  playBotTurns,
  progressTimeouts,
  publicMatchView,
  seatOf,
  type DeckKind,
} from "../domain/matches.js";
import { transaction } from "../db/pool.js";
import { conflict } from "../http/errors.js";
import { requireUser } from "../http/session.js";
import type { Action } from "../engine/types.js";
import type { RouteModule } from "../server.js";

const queueInput = z.object({
  deck: z.enum(["owned", "trial"]),
  opponent: z.enum(["queue", "bot"]).default("queue"),
});

const commandInput = z.object({
  commandId: z.uuid(),
  expectedSeq: z.number().int().nonnegative(),
  action: z
    .object({ type: z.string() })
    .passthrough()
    .transform((v) => v as Action),
});

export const matchRoutes: RouteModule = (app, deps) => {
  const { pool } = deps;

  app.post("/api/queue", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    const body = queueInput.parse(req.body);
    return enqueueOrMatch(pool, user.id, body.deck as DeckKind, body.opponent);
  });

  app.delete("/api/queue", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    await pool.query("DELETE FROM queue_entries WHERE user_id = $1", [user.id]);
    return { ok: true };
  });

  app.get("/api/queue", async (req) => {
    const user = await requireUser(req, deps);
    await pool.query("UPDATE queue_entries SET seen_at = now() WHERE user_id = $1", [user.id]);
    const [waiting, match] = await Promise.all([
      pool.query("SELECT 1 FROM queue_entries WHERE user_id = $1", [user.id]),
      pool.query<{ id: string }>(
        `SELECT id FROM matches WHERE (player0 = $1 OR player1 = $1) AND ended_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [user.id],
      ),
    ]);
    return { waiting: (waiting.rowCount ?? 0) > 0, matchId: match.rows[0]?.id ?? null };
  });

  app.get("/api/matches/:id", async (req) => {
    const user = await requireUser(req, deps);
    const id = z.uuid().parse((req.params as { id: string }).id);
    return transaction(pool, async (c) => {
      let row = await loadMatchForUser(c, id, user.id);
      row = await progressTimeouts(c, row);
      row = await playBotTurns(c, row);
      const seat = seatOf(row, user.id);
      return { id, ...publicMatchView(row.state, seat, row.deadline) };
    });
  });

  app.post("/api/matches/:id/actions", async (req) => {
    const user = await requireUser(req, deps, { write: true });
    const id = z.uuid().parse((req.params as { id: string }).id);
    const body = commandInput.parse(req.body);
    return transaction(pool, async (c) => {
      let row = await loadMatchForUser(c, id, user.id);
      const repeat = await c.query<{ response: unknown }>(
        "SELECT response FROM match_commands WHERE match_id = $1 AND user_id = $2 AND command_id = $3",
        [id, user.id, body.commandId],
      );
      if (repeat.rows[0]) return repeat.rows[0].response;

      row = await progressTimeouts(c, row);
      row = await playBotTurns(c, row);
      if (row.seq !== body.expectedSeq) throw conflict("경기 상태가 갱신되었습니다");

      row = await applyPlayerAction(c, row, user.id, body.action);
      row = await playBotTurns(c, row);

      const seat = seatOf(row, user.id);
      const response = { id, ...publicMatchView(row.state, seat, row.deadline) };
      await c.query(
        "INSERT INTO match_commands (match_id, user_id, command_id, response) VALUES ($1, $2, $3, $4)",
        [id, user.id, body.commandId, JSON.stringify(response)],
      );
      return response;
    });
  });
};
