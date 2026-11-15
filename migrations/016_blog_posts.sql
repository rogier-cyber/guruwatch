-- Blogartikelen van guruwatch.nl (oude site), overgenomen in onze eigen opmaak; elke paar uur ververst.
CREATE TABLE IF NOT EXISTS blog_posts (
  id integer PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  category text,
  published_at timestamptz,
  image text,
  intro text,
  blocks jsonb NOT NULL,
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blog_posts_published ON blog_posts (published_at DESC);
