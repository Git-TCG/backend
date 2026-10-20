-- 카드 일러스트. card_id는 엔진 카드 ID(Repo ID 문자열 또는 sample-NN)이다.
-- 시즌이 바뀌어도 같은 카드는 같은 그림을 쓴다.
CREATE TABLE card_images (
  card_id    text PRIMARY KEY,
  mime       text NOT NULL CHECK (mime IN ('image/webp', 'image/png', 'image/jpeg')),
  bytes      bytea NOT NULL,
  prompt     text NOT NULL,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
