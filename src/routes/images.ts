import { CARD_IMAGE_ID } from "../domain/images.js";
import type { RouteModule } from "../server.js";

/** 카드 일러스트. 공개 Repo 카드의 그림이라 로그인 없이 받을 수 있다. 숨긴 Repo의 그림은 내리지 않는다. */
export const imageRoutes: RouteModule = (app, { pool }) => {
  app.get("/api/card-images/:cardId", async (req, reply) => {
    const { cardId } = req.params as { cardId: string };
    if (!CARD_IMAGE_ID.test(cardId)) {
      reply.header("Cache-Control", "no-store");
      return reply.code(404).send({ error: "이미지가 없습니다" });
    }
    const hidden = /^\d+$/.test(cardId)
      ? (await pool.query("SELECT 1 FROM repositories WHERE id = $1 AND hidden_at IS NOT NULL", [Number(cardId)]))
          .rowCount
      : 0;
    const r = !hidden
      ? await pool.query<{ mime: string; bytes: Buffer; created_at: Date }>(
          "SELECT mime, bytes, created_at FROM card_images WHERE card_id = $1",
          [cardId],
        )
      : null;
    const row = r?.rows[0];
    if (!row) {
      // 아직 생성 중일 수 있으므로 캐시하지 않는다.
      reply.header("Cache-Control", "no-store");
      return reply.code(404).send({ error: "이미지가 아직 없습니다" });
    }
    reply.header("Content-Type", row.mime);
    reply.header("Cache-Control", "public, max-age=86400");
    reply.header("Last-Modified", row.created_at.toUTCString());
    return reply.send(row.bytes);
  });
};
