-- README 전적 배지에 보여줄 대표 카드(최대 3장). NULL이면 등급 높은 순으로 자동 고른다.
ALTER TABLE users
  ADD COLUMN badge_card_ids bigint[]
  CHECK (badge_card_ids IS NULL OR cardinality(badge_card_ids) BETWEEN 1 AND 3);
