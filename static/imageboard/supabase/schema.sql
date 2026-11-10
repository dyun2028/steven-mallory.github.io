-- Imageboard schema for Supabase. Paste this whole file into the Supabase
-- dashboard: SQL Editor -> New query -> Run. Safe to read, contains no secrets.
--
-- Security model: the site is static, so the browser talks to Supabase with the
-- public "anon" key. Row Level Security (RLS) is what protects the data:
--   * anyone can READ boards, threads, posts and uploaded images
--   * nobody can write to the tables directly; posting only works through the
--     create_thread / create_post functions, which validate everything
--   * nobody can edit or delete anything (do moderation in the dashboard)

-- ---------- tables ----------
create table public.boards (
  id          text primary key check (id ~ '^[a-z0-9]{1,5}$'),
  name        text not null,
  description text not null default '',
  sort        int  not null default 0
);

create table public.threads (
  id                       bigint generated always as identity primary key,
  board                    text not null references public.boards(id),
  original_poster_username text not null default 'anon',
  subject                  text check (char_length(subject) <= 100),
  created_at               timestamptz not null default now(),
  bumped_at                timestamptz not null default now()
);
create index threads_board_bumped_idx on public.threads (board, bumped_at desc);

create table public.posts (
  id            bigint generated always as identity primary key,
  thread_id     bigint not null references public.threads(id) on delete cascade,
  post_user     text not null default 'anon' check (char_length(post_user) <= 16),
  body          text not null default '' check (char_length(body) <= 2000),
  created_at    timestamptz not null default now(),
  file_path     text,
  thumb_path    text,
  original_name text check (char_length(original_name) <= 64),
  width         int,
  height        int
);
create index posts_thread_idx on public.posts (thread_id, created_at, id);

-- Used only for rate limiting: a hash of the poster's IP and a timestamp,
-- cleaned out after a day. Not readable from the browser.
create table public.post_log (
  ip_hash    text not null,
  created_at timestamptz not null default now()
);
create index post_log_idx on public.post_log (ip_hash, created_at);

-- ---------- catalog view (one row per thread, with the OP's text and thumbnail) ----------
create view public.thread_catalog with (security_invoker = on) as
select t.id, t.board, t.subject, t.original_poster_username, t.created_at, t.bumped_at,
       op.body       as op_body,
       op.thumb_path as op_thumb_path,
       op.width      as op_width,
       op.height     as op_height,
       greatest((select count(*) from public.posts p where p.thread_id = t.id) - 1, 0) as reply_count
from public.threads t
left join lateral (
  select * from public.posts p where p.thread_id = t.id order by p.created_at, p.id limit 1
) op on true;

-- ---------- row level security ----------
alter table public.boards   enable row level security;
alter table public.threads  enable row level security;
alter table public.posts    enable row level security;
alter table public.post_log enable row level security;

create policy "anyone can read boards"  on public.boards  for select using (true);
create policy "anyone can read threads" on public.threads for select using (true);
create policy "anyone can read posts"   on public.posts   for select using (true);
-- No insert/update/delete policies: direct writes are denied.

revoke all on public.boards, public.threads, public.posts, public.post_log from anon, authenticated;
grant select on public.boards, public.threads, public.posts, public.thread_catalog to anon, authenticated;

-- ---------- helper functions (not callable from the browser) ----------
create function public.ib_rate_limit() returns void
language plpgsql security definer set search_path = public as $$
declare hdrs json; ip text; h text;
begin
  begin hdrs := current_setting('request.headers', true)::json;
  exception when others then hdrs := null; end;
  ip := split_part(coalesce(hdrs->>'x-forwarded-for', ''), ',', 1);
  if ip = '' then return; end if;
  h := md5(ip);
  delete from post_log where created_at < now() - interval '1 day';
  if exists (select 1 from post_log where ip_hash = h and created_at > now() - interval '20 seconds') then
    raise exception 'You are posting too fast. Wait a few seconds and try again.';
  end if;
  insert into post_log (ip_hash) values (h);
end $$;

create function public.ib_check_file(p_file text, p_thumb text, p_w int, p_h int) returns void
language plpgsql set search_path = public as $$
begin
  if p_file !~ '^full/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$'
     or p_thumb is null
     or p_thumb !~ '^thumbs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    raise exception 'Invalid image.';
  end if;
  if p_w is null or p_h is null or p_w < 1 or p_h < 1 or p_w > 20000 or p_h > 20000 then
    raise exception 'Invalid image size.';
  end if;
end $$;

revoke execute on function public.ib_rate_limit() from public, anon, authenticated;
revoke execute on function public.ib_check_file(text, text, int, int) from public, anon, authenticated;

-- ---------- posting functions (what the website calls) ----------
create function public.create_thread(
  p_board text, p_subject text, p_username text, p_body text,
  p_file_path text, p_thumb_path text, p_original_name text, p_width int, p_height int
) returns bigint
language plpgsql security definer set search_path = public as $$
declare tid bigint;
        uname text := left(coalesce(nullif(btrim(p_username), ''), 'anon'), 16);
begin
  if not exists (select 1 from boards where id = p_board) then raise exception 'Unknown board.'; end if;
  if p_file_path is null then raise exception 'A new thread needs an image.'; end if;
  perform ib_check_file(p_file_path, p_thumb_path, p_width, p_height);
  if char_length(coalesce(p_subject, '')) > 100 then raise exception 'Subject is too long (100 max).'; end if;
  if char_length(coalesce(p_body, '')) > 2000 then raise exception 'Post is too long (2000 max).'; end if;
  perform ib_rate_limit();

  insert into threads (board, original_poster_username, subject)
  values (p_board, uname, nullif(btrim(p_subject), '')) returning id into tid;
  insert into posts (thread_id, post_user, body, file_path, thumb_path, original_name, width, height)
  values (tid, uname, coalesce(p_body, ''), p_file_path, p_thumb_path, left(p_original_name, 64), p_width, p_height);
  return tid;
end $$;

create function public.create_post(
  p_thread_id bigint, p_username text, p_body text,
  p_file_path text default null, p_thumb_path text default null,
  p_original_name text default null, p_width int default null, p_height int default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare pid bigint;
        uname text := left(coalesce(nullif(btrim(p_username), ''), 'anon'), 16);
begin
  if not exists (select 1 from threads where id = p_thread_id) then raise exception 'Thread not found.'; end if;
  if (select count(*) from posts where thread_id = p_thread_id) >= 500 then raise exception 'This thread is full.'; end if;
  if char_length(coalesce(p_body, '')) > 2000 then raise exception 'Post is too long (2000 max).'; end if;
  if p_file_path is not null then
    perform ib_check_file(p_file_path, p_thumb_path, p_width, p_height);
  elsif btrim(coalesce(p_body, '')) = '' then
    raise exception 'Write something or attach an image.';
  end if;
  perform ib_rate_limit();

  insert into posts (thread_id, post_user, body, file_path, thumb_path, original_name, width, height)
  values (p_thread_id, uname, coalesce(p_body, ''), p_file_path, p_thumb_path, left(p_original_name, 64), p_width, p_height)
  returning id into pid;
  update threads set bumped_at = now() where id = p_thread_id;
  return pid;
end $$;

grant execute on function public.create_thread(text, text, text, text, text, text, text, int, int) to anon, authenticated;
grant execute on function public.create_post(bigint, text, text, text, text, text, int, int) to anon, authenticated;

-- ---------- image storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imageboard', 'imageboard', true, 5242880, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do nothing;

create policy "anyone can upload imageboard images" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'imageboard' and (storage.foldername(name))[1] in ('full', 'thumbs'));
-- Public buckets serve files by URL; no read/update/delete policies are needed.

-- ---------- boards (same four as the original Flask app; ids are max 5 chars) ----------
insert into public.boards (id, name, description, sort) values
  ('b',    'Random', 'Anything goes.',        10),
  ('tech', 'Tech',   'Computers and code.',   20),
  ('life', 'Life',   'Day-to-day stuff.',     30),
  ('r9k',  'r9k',    'Original posts only-ish.', 40);
